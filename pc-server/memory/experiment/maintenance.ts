// 周期维护：7 / 14 天失真与保真计划（只读 + 审计，不修改任何记忆）。
//
// 口径（见开发计划第五阶段）：
// - cold 事件每 eventDistillDays（默认 7 天）逐层降低分辨率：L1 原文 → L2 粗化时间地点；
//   L2 的同类事件再按 eventDistillDays 合成 L3 主题要旨；
// - hot 事件每 habitDistillDays（默认 14 天）只做保真摘要，不跨事件合并；
// - 习惯是第二优先级：只在允许记忆模型参与时生成保真摘要，永不降级成事件；
// - 设定 / 明确记住 / 未分类：不进入事件遗忘队列，扫描时就跳过；
// - L4（删除正文留 tombstone）属于执行阶段，本模块只把记忆推进到 L3 为止。
//
// 安全纪律：这里不调用模型、不改记忆，只写 distill_plan 审计（proposed）。
// 计划在启动时补算一次（不驻留定时器）或由设置页手动触发；实验关闭时零副作用。
import { createHash } from "node:crypto";
import type { MemoryEntry } from "../../foundation/types";
import { state } from "../../persistence/json-store";
import { reportError } from "../../observability/app-errors";
import { memoryStore } from "../index";
import {
  isForgettable,
  isHotMemory,
  normalizeMemoryFacets,
  normalizeMemoryKind,
  normalizeMemoryStatus,
} from "./entry";
import { getMemoryExperimentSettings, memoryExperimentFeature, memoryExperimentLlmAllowed } from "./gate";
import {
  getAuditByIdempotencyKey,
  listAudit,
  openExperimentDb,
  recordAudit,
  updateAuditResult,
  type MemoryAuditStatus,
} from "./store";

const DAY_MS = 86_400_000;
/** 单次扫描最多生成多少条计划：维护是后台任务，不能一次刷满审计。 */
const MAX_PROPOSALS = 10;
/** 执行阶段的粗略成本估算：每条计划一次模型调用，输入正文 + 提示词。 */
const ESTIMATED_PROMPT_TOKENS = 500;

export type MaintenanceOp = "fidelity" | "coarsen" | "theme_merge";

export interface MaintenanceProposal {
  op: MaintenanceOp;
  targetId: number;
  memberIds: number[];
  /** 计划改写后的预览。fidelity 在未调用模型前为空串，表示执行时再生成。 */
  content: string;
  currentContent: string;
  reason: string;
  confidence: number;
  fromGeneration: number;
  toGeneration: number;
  cadenceDays: number;
  dueAt: number;
  scopeKey: string;
  scopeLabel: string;
  estimatedModelCalls: number;
  estimatedTokens: number;
  involved: Array<{ id: number; content: string; role: "target" | "source" }>;
}

export interface MaintenanceRecord extends MaintenanceProposal {
  auditId: string;
  status: MemoryAuditStatus;
  at: number;
}

export interface MaintenancePlanResult {
  scanned: number;
  due: number;
  proposed: number;
  created: number;
  budget: number;
  estimatedModelCalls: number;
  estimatedTokens: number;
  skipped: {
    notDue: number;
    noPreview: number;
    noModel: number;
    budget: number;
  };
  proposals: MaintenanceProposal[];
}

interface PoolEntry {
  memory: MemoryEntry;
  scopeKey: string;
  scopeLabel: string;
}

const TIME_CLUSTER = /((?:今天|昨天|前天|本周|这周|上周|本月|这个月|上个月|去年|前年|今年|上午|下午|中午|晚上|凌晨|早上|\d{4}年|\d{1,2}月\d{1,2}[日号]|\d{1,2}点(?:半|钟)?)[的]?)+/g;
const RECENT_TIME = /(今天|昨天|前天|上午|下午|中午|晚上|凌晨|早上|\d{1,2}点)/;
const MID_TIME = /(本周|这周|上周|本月|这个月|上个月|\d{1,2}月)/;
const YEAR_TIME = /(去年|前年|今年|\d{4}年)/;

/** 时间词粗化：保留「多久以前」这一档信息，丢掉具体日期与钟点。 */
export function coarseTimeLabel(text: string): string {
  if (RECENT_TIME.test(text)) return "最近";
  if (MID_TIME.test(text)) return "近期";
  if (YEAR_TIME.test(text)) return "过去一年内";
  return "过去某时";
}

/**
 * 确定性 L2 预览：时间词粗化 + 去掉括注细节。
 * 只用于展示「将失去什么」；执行阶段（S14）可以用记忆模型写出更自然的摘要。
 */
export function coarsenEventContent(memory: Pick<MemoryEntry, "content" | "facets">): { content: string; changed: boolean } {
  const original = String(memory.content ?? "").trim();
  if (!original) return { content: "", changed: false };
  const facets = normalizeMemoryFacets(memory.facets);
  const coarse = coarseTimeLabel(facets?.time || original);
  let text = original;
  if (facets?.time && text.includes(facets.time)) {
    text = text.split(facets.time).join(coarse);
  }
  text = text.replace(TIME_CLUSTER, () => coarse);
  text = text.replace(/[（(][^）)]{1,80}[）)]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 160) text = `${text.slice(0, 158)}…`;
  return { content: text, changed: text !== original };
}

function eventSlot(memory: MemoryEntry): { key: string; label: string } | null {
  const facets = normalizeMemoryFacets(memory.facets);
  const event = facets?.event?.trim();
  if (event) return { key: `event:${event.toLowerCase()}`, label: event };
  for (const tag of facets?.tags ?? []) {
    const text = tag.trim();
    if (text.length >= 2) return { key: `tag:${text.toLowerCase()}`, label: text };
  }
  return null;
}

function collectPool(): PoolEntry[] {
  const pool: PoolEntry[] = [];
  for (const memory of memoryStore.getGlobalMemories()) {
    pool.push({ memory, scopeKey: "global", scopeLabel: "全局记忆" });
  }
  for (const group of memoryStore.getAllAssistantGroups()) {
    const name = group.assistantName
      || state.settings.assistants.find((assistant) => assistant.id === group.assistantId)?.name
      || "助手";
    for (const memory of group.memories) {
      pool.push({ memory, scopeKey: `assistant:${group.assistantId}`, scopeLabel: name });
    }
  }
  return pool;
}

function lastTouched(memory: MemoryEntry): number {
  const distilled = Number(memory.distilledAt) || 0;
  const updated = Number(memory.updatedAt) || 0;
  return Math.max(distilled, updated);
}

function dueOf(memory: MemoryEntry, cadenceDays: number): number {
  return lastTouched(memory) + cadenceDays * DAY_MS;
}

function isDue(memory: MemoryEntry, cadenceDays: number, now: number): boolean {
  return now >= dueOf(memory, cadenceDays);
}

function tokenEstimate(content: string): number {
  return ESTIMATED_PROMPT_TOKENS + Math.ceil(String(content ?? "").length / 2);
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function proposalKey(proposal: MaintenanceProposal): string {
  const members = proposal.memberIds.join(",");
  const signature = [
    proposal.op,
    proposal.targetId,
    `${proposal.fromGeneration}->${proposal.toGeneration}`,
    members,
    hashText(proposal.currentContent),
    hashText(proposal.content),
  ].join("|");
  return `distill:${signature}`;
}

function buildProposal(
  op: MaintenanceOp,
  target: PoolEntry,
  members: PoolEntry[],
  options: {
    content: string;
    reason: string;
    confidence: number;
    toGeneration: number;
    cadenceDays: number;
    estimatedModelCalls: number;
  },
): MaintenanceProposal {
  const fromGeneration = Math.max(...members.map((item) => item.memory.generation ?? 0));
  return {
    op,
    targetId: target.memory.id,
    memberIds: members.map((item) => item.memory.id),
    content: options.content,
    currentContent: target.memory.content,
    reason: options.reason,
    confidence: options.confidence,
    fromGeneration,
    toGeneration: options.toGeneration,
    cadenceDays: options.cadenceDays,
    dueAt: Math.min(...members.map((item) => dueOf(item.memory, options.cadenceDays))),
    scopeKey: target.scopeKey,
    scopeLabel: target.scopeLabel,
    estimatedModelCalls: options.estimatedModelCalls,
    estimatedTokens: options.estimatedModelCalls > 0 ? tokenEstimate(target.memory.content) : 0,
    involved: [
      { id: target.memory.id, content: target.memory.content, role: "target" },
      ...members
        .filter((item) => item.memory.id !== target.memory.id)
        .map((item) => ({ id: item.memory.id, content: item.memory.content, role: "source" as const })),
    ],
  };
}

function runStamp(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `maintenance:run:${date.getFullYear()}-${month}-${day}`;
}

function recordDailyRun(
  now: number,
  trigger: "startup" | "manual",
  result: Omit<MaintenancePlanResult, "proposals">,
): void {
  if (trigger !== "startup") return;
  const db = openExperimentDb();
  if (!db) return;
  const key = runStamp(now);
  if (getAuditByIdempotencyKey(db, key)) return;
  recordAudit(db, {
    action: "distill_plan",
    status: "info",
    idempotencyKey: key,
    detail: {
      run: "startup",
      at: now,
      scanned: result.scanned,
      due: result.due,
      created: result.created,
      estimatedModelCalls: result.estimatedModelCalls,
      estimatedTokens: result.estimatedTokens,
    },
  });
}

/**
 * 生成维护计划。只写审计，不修改记忆；同样签名的计划（含已拒绝）不会重复出现。
 * 所有模型调用都发生在未来的执行阶段，本函数 estimatedModelCalls 只是报价。
 */
export function planMaintenance(options: { now?: number; trigger?: "startup" | "manual"; limit?: number } = {}): MaintenancePlanResult {
  const empty: MaintenancePlanResult = {
    scanned: 0,
    due: 0,
    proposed: 0,
    created: 0,
    budget: MAX_PROPOSALS,
    estimatedModelCalls: 0,
    estimatedTokens: 0,
    skipped: { notDue: 0, noPreview: 0, noModel: 0, budget: 0 },
    proposals: [],
  };
  if (!memoryExperimentFeature("maintenance")) return empty;
  const db = openExperimentDb();
  if (!db) return empty;

  const settings = getMemoryExperimentSettings();
  const now = options.now ?? Date.now();
  const llmAllowed = memoryExperimentLlmAllowed();
  const hotThreshold = settings.hotMentionThreshold;
  const limit = Math.min(MAX_PROPOSALS, Math.max(1, Math.round(options.limit ?? MAX_PROPOSALS)));
  const pool = collectPool();
  const skipped = { notDue: 0, noPreview: 0, noModel: 0, budget: 0 };
  let due = 0;

  // 1) 保护类记忆不进入队列；习惯只做保真摘要（有模型才值得生成）。
  const habits: PoolEntry[] = [];
  const coldEvents: PoolEntry[] = [];
  const hotEvents: PoolEntry[] = [];
  for (const item of pool) {
    const memory = item.memory;
    if (normalizeMemoryStatus(memory.status) !== "active") continue;
    const kind = normalizeMemoryKind(memory.kind);
    if (kind === "habit") {
      habits.push(item);
      continue;
    }
    if (kind !== "event") continue;
    if (!isForgettable(memory)) continue;
    if (isHotMemory(memory, hotThreshold)) hotEvents.push(item);
    else coldEvents.push(item);
  }

  const planned: MaintenanceProposal[] = [];
  const used = new Set<number>();
  const add = (proposal: MaintenanceProposal): boolean => {
    const key = proposalKey(proposal);
    if (getAuditByIdempotencyKey(db, key)) return false;
    const rec = recordAudit(db, {
      action: "distill_plan",
      status: "proposed",
      memoryId: proposal.targetId,
      idempotencyKey: key,
      detail: { ...proposal },
    });
    if (!rec.inserted) return false;
    planned.push(proposal);
    for (const id of proposal.memberIds) used.add(id);
    return true;
  };
  const full = () => planned.length >= limit;

  // 2) L2 的同类事件合成 L3 主题要旨：同一作用域 + 同一事件槽位，且都已被粗化过。
  //    热事件不参与跨事件合并（计划明确：hot 只做保真摘要）。
  const clusters = new Map<string, PoolEntry[]>();
  for (const item of coldEvents) {
    if ((item.memory.generation ?? 0) < 1) continue;
    const slot = eventSlot(item.memory);
    if (!slot) continue;
    const key = `${item.scopeKey}|${slot.key}`;
    const list = clusters.get(key) ?? [];
    list.push(item);
    clusters.set(key, list);
  }
  const mergeCandidates: Array<{ members: PoolEntry[]; target: PoolEntry }> = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    if (!members.every((item) => isDue(item.memory, settings.eventDistillDays, now))) continue;
    const target = [...members].sort((left, right) =>
      right.memory.updatedAt - left.memory.updatedAt
      || Math.max(0, Number(right.memory.mentionCount) || 0) - Math.max(0, Number(left.memory.mentionCount) || 0)
      || right.memory.id - left.memory.id,
    )[0]!;
    mergeCandidates.push({ members, target });
    due += members.length;
  }
  mergeCandidates.sort((left, right) => dueOf(left.target.memory, settings.eventDistillDays) - dueOf(right.target.memory, settings.eventDistillDays));

  for (const cluster of mergeCandidates) {
    if (full()) {
      skipped.budget += cluster.members.length;
      continue;
    }
    const slot = eventSlot(cluster.target.memory);
    const label = slot?.label || "同类事件";
    const proposal = buildProposal("theme_merge", cluster.target, cluster.members, {
      content: `${label}：共 ${cluster.members.length} 次同类事件，时间地点已粗化`,
      reason: `同类事件「${label}」已粗化过，按 7 天周期合成主题要旨（L3）`,
      confidence: Math.min(0.8, 0.6 + (cluster.members.length - 2) * 0.05),
      toGeneration: 2,
      cadenceDays: settings.eventDistillDays,
      estimatedModelCalls: llmAllowed ? 1 : 0,
    });
    add(proposal);
  }

  // 3) 冷事件逐层粗化：L1 → L2。L2 之后只剩主题合并与执行阶段的 L4。
  for (const item of coldEvents) {
    if (used.has(item.memory.id)) continue;
    const generation = Math.max(0, Math.round(Number(item.memory.generation) || 0));
    if (generation >= 1) continue;
    if (!isDue(item.memory, settings.eventDistillDays, now)) {
      skipped.notDue += 1;
      continue;
    }
    due += 1;
    if (full()) {
      skipped.budget += 1;
      continue;
    }
    const preview = coarsenEventContent(item.memory);
    if (!preview.changed && !llmAllowed) {
      skipped.noPreview += 1;
      continue;
    }
    const proposal = buildProposal("coarsen", item, [item], {
      content: preview.changed ? preview.content : "",
      reason: "低权重事件按 7 天周期粗化时间与地点（L2）",
      confidence: 0.7,
      toGeneration: generation + 1,
      cadenceDays: settings.eventDistillDays,
      estimatedModelCalls: llmAllowed ? 1 : 0,
    });
    add(proposal);
  }

  // 4) 热事件：14 天一次保真摘要，不合并、不降级。没有记忆模型时宁可不生成
  //    （确定性「保真」要么是空操作，要么会丢信息，两者都不该写成提案）。
  for (const item of hotEvents) {
    if (used.has(item.memory.id)) continue;
    if (!isDue(item.memory, settings.habitDistillDays, now)) {
      skipped.notDue += 1;
      continue;
    }
    due += 1;
    if (!llmAllowed) {
      skipped.noModel += 1;
      continue;
    }
    if (full()) {
      skipped.budget += 1;
      continue;
    }
    const generation = Math.max(0, Math.round(Number(item.memory.generation) || 0));
    add(buildProposal("fidelity", item, [item], {
      content: "",
      reason: "热事件按 14 天周期做保真摘要，不做跨事件合并",
      confidence: 0.72,
      toGeneration: generation,
      cadenceDays: settings.habitDistillDays,
      estimatedModelCalls: 1,
    }));
  }

  // 5) 习惯：第二优先级，只允许保真压缩，永不降级成事件；同样要求模型参与。
  for (const item of habits) {
    if (used.has(item.memory.id)) continue;
    if (!isDue(item.memory, settings.habitDistillDays, now)) {
      skipped.notDue += 1;
      continue;
    }
    due += 1;
    if (!llmAllowed) {
      skipped.noModel += 1;
      continue;
    }
    if (full()) {
      skipped.budget += 1;
      continue;
    }
    const generation = Math.max(0, Math.round(Number(item.memory.generation) || 0));
    add(buildProposal("fidelity", item, [item], {
      content: "",
      reason: "高权重习惯按 14 天周期做保真摘要，不降级、不删除",
      confidence: 0.66,
      toGeneration: generation,
      cadenceDays: settings.habitDistillDays,
      estimatedModelCalls: 1,
    }));
  }

  const estimatedModelCalls = planned.reduce((sum, proposal) => sum + proposal.estimatedModelCalls, 0);
  const estimatedTokens = planned.reduce((sum, proposal) => sum + proposal.estimatedTokens, 0);
  const summary = {
    scanned: pool.length,
    due,
    proposed: planned.length,
    created: planned.length,
    budget: limit,
    estimatedModelCalls,
    estimatedTokens,
    skipped,
  };
  recordDailyRun(now, options.trigger ?? "manual", summary);
  return { ...summary, proposals: planned };
}

/** 审计 detail → 计划对象。执行 / 撤销阶段（forget.ts）复用同一份解析，避免两种口径。 */
export function parseMaintenanceProposal(detail: Record<string, unknown>): MaintenanceProposal | null {
  const op = detail.op;
  if (op !== "fidelity" && op !== "coarsen" && op !== "theme_merge") return null;
  const targetId = Number(detail.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) return null;
  const memberIds = Array.isArray(detail.memberIds)
    ? detail.memberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return {
    op,
    targetId,
    memberIds,
    content: String(detail.content ?? ""),
    currentContent: String(detail.currentContent ?? ""),
    reason: String(detail.reason ?? ""),
    confidence: Number(detail.confidence) || 0,
    fromGeneration: Math.max(0, Math.round(Number(detail.fromGeneration) || 0)),
    toGeneration: Math.max(0, Math.round(Number(detail.toGeneration) || 0)),
    cadenceDays: Math.max(1, Math.round(Number(detail.cadenceDays) || 7)),
    dueAt: Number(detail.dueAt) || 0,
    scopeKey: String(detail.scopeKey ?? ""),
    scopeLabel: String(detail.scopeLabel ?? ""),
    estimatedModelCalls: Math.max(0, Math.round(Number(detail.estimatedModelCalls) || 0)),
    estimatedTokens: Math.max(0, Math.round(Number(detail.estimatedTokens) || 0)),
    involved: Array.isArray(detail.involved)
      ? detail.involved as MaintenanceProposal["involved"]
      : [],
  };
}

export function listMaintenanceProposals(status?: MemoryAuditStatus): MaintenanceRecord[] {
  const db = openExperimentDb();
  if (!db) return [];
  return listAudit(db, { action: "distill_plan", limit: 200, ...(status ? { status } : {}) })
    .map((entry) => {
      const proposal = parseMaintenanceProposal(entry.detail);
      if (!proposal) return null;
      return { ...proposal, auditId: entry.auditId, status: entry.status, at: entry.at };
    })
    .filter((entry): entry is MaintenanceRecord => entry != null);
}

export interface MaintenanceSummary {
  lastRunAt: number | null;
  pending: MaintenanceRecord[];
  /** 当前设置下一条到期计划若执行的模型调用报价（仅提示，不会自动调用）。 */
  estimatedModelCalls: number;
}

export function maintenanceSummary(): MaintenanceSummary {
  if (!memoryExperimentFeature("maintenance")) return { lastRunAt: null, pending: [], estimatedModelCalls: 0 };
  const db = openExperimentDb();
  if (!db) return { lastRunAt: null, pending: [], estimatedModelCalls: 0 };
  const pending = listMaintenanceProposals("proposed");
  const latest = listAudit(db, { action: "distill_plan", limit: 1 })[0];
  return {
    lastRunAt: latest?.at ?? null,
    pending,
    estimatedModelCalls: pending.reduce((sum, proposal) => sum + proposal.estimatedModelCalls, 0),
  };
}

/** 拒绝一条维护计划：只改审计状态；试运行中也可拒绝（安全操作）。 */
export function rejectMaintenanceProposal(auditId: string): { auditId: string; status: "rejected" } {
  if (!memoryExperimentFeature("maintenance")) throw new Error("周期维护未开启");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");
  const audit = listAudit(db, { action: "distill_plan", limit: 500 }).find((entry) => entry.auditId === auditId);
  if (!audit || !parseMaintenanceProposal(audit.detail)) throw new Error("维护计划不存在");
  if (audit.status !== "proposed") throw new Error(`提案当前状态为 ${audit.status}，不能拒绝`);
  updateAuditResult(db, auditId, "rejected", { rejectedAt: Date.now() });
  return { auditId, status: "rejected" };
}

let catchUpScheduled = false;

/**
 * 启动补算：应用启动后延迟几秒跑一次，不阻塞启动、不驻留定时器。
 * 扫描本身零模型调用；执行阶段需要模型时会在计划里先报价。
 */
export function scheduleMaintenanceCatchUp(): void {
  if (catchUpScheduled) return;
  if (!memoryExperimentFeature("maintenance")) return;
  catchUpScheduled = true;
  const timer = setTimeout(() => {
    try {
      planMaintenance({ trigger: "startup" });
    } catch (err) {
      reportError("persistence", "warn", "周期维护补算失败", err, "memory_maintenance_catch_up_failed");
    }
  }, 5_000) as unknown as { unref?: () => void };
  timer.unref?.();
}
