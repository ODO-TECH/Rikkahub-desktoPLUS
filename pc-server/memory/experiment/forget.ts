// 遗忘执行（S14）：执行失真计划、30 天原文延迟清除、到期墓碑、审计撤销与失败回滚。
//
// 口径（见开发计划第五阶段 / 最终放行门槛）：
// - 执行只在「总开关 + 周期维护 + 非试运行」时允许；试运行只生成计划。
// - 每次失真把改写前的内容落到 rawContent，并重新计时 purgeAfter（默认 30 天）——
//   这是最短保留期，热记忆反复保真会顺延，宁可多留不可少留。
// - 到期只删除 rawContent（不是消息原文，也不是当前摘要）；L3 主题（generation ≥ 2
//   的事件）到期时连正文一起清除，留下 tombstone 审计元数据。
// - tombstone / 被清除原文的记忆不再进入上下文、RAG 与向量池（见 memory/index 与
//   vector-index 的无条件过滤）。
// - 30 天延迟期内可撤销：执行前把目标与成员快照写进审计，撤销按快照恢复；
//   原文清除后撤销被拒绝（审计里的原文也在同一时刻抹掉）。
import type { MemoryEntry, MemoryFacets, MemoryKind, MemoryStatus } from "../../foundation/types";
import { reportError } from "../../observability/app-errors";
import { fetchAuxiliaryText } from "../../conversations/auxiliary";
import { memoryStore } from "../index";
import { memoryModelThinkingEnabled, resolveMemoryModel } from "../memory-model";
import {
  isProtectedMemory,
  normalizeMemoryFacets,
  normalizeMemoryKind,
  normalizeMemoryStatus,
} from "./entry";
import {
  getMemoryExperimentSettings,
  memoryExperimentFeature,
  memoryExperimentLlmAllowed,
  memoryExperimentMutates,
} from "./gate";
import {
  coarseTimeLabel,
  coarsenEventContent,
  parseMaintenanceProposal,
  type MaintenanceOp,
  type MaintenanceProposal,
} from "./maintenance";
import {
  deleteMemoryEdgesByAudit,
  getAudit,
  getAuditByIdempotencyKey,
  listAudit,
  openExperimentDb,
  recordAudit,
  recordMemoryEdge,
  updateAuditDetail,
  updateAuditResult,
} from "./store";
import { isRecord } from "../../foundation/utils";

const DAY_MS = 86_400_000;
/** 审计里原文被清除后的占位符（保留「此处曾有原文」的语义，不保留内容）。 */
export const PURGED_TEXT = "（原文已按延迟清除策略删除）";

export interface ForgetSnapshot {
  id: number;
  content: string;
  status: MemoryStatus;
  kind: MemoryKind;
  rawContent: string | null;
  facets: MemoryFacets | null;
  explicitRemember: boolean;
  generation: number;
  distilledAt: number | null;
  purgeAfter: number | null;
  source: "manual" | "ai";
  updatedAt: number;
}

export interface ForgetApplyResult {
  auditId: string;
  op: MaintenanceOp;
  targetId: number;
  generation: number;
  archivedIds: number[];
  modelUsed: boolean;
  purgeAfter: number | null;
}

export interface ForgetUndoResult {
  auditId: string;
  targetId: number;
  restoredIds: number[];
}

export interface PurgeResult {
  /** 试运行：只统计到期数量，不删除任何内容。 */
  dryRun: boolean;
  scanned: number;
  due: number;
  purgedRaw: number;
  tombstoned: number;
  cleaned: number;
}

export interface ForgetAppliedRecord {
  auditId: string;
  at: number;
  op: MaintenanceOp;
  targetId: number;
  content: string;
  currentContent: string;
  scopeLabel: string;
  modelUsed: boolean;
  purgedAt: number | null;
}

export interface ForgettingSummary {
  now: number;
  lastPurgeAt: number | null;
  pendingRawPurges: number;
  pendingTombstones: number;
  scheduledPurges: number;
  earliestPurgeAt: number | null;
  applied: ForgetAppliedRecord[];
}

function collectAll(): MemoryEntry[] {
  const all: MemoryEntry[] = [...memoryStore.getGlobalMemories()];
  for (const group of memoryStore.getAllAssistantGroups()) {
    for (const memory of group.memories) all.push(memory);
  }
  return all;
}

function scopeKeyOfMemory(memoryId: number): string | null {
  const scope = memoryStore.scopeOfMemory(memoryId);
  if (!scope) return null;
  return "assistantId" in scope ? `assistant:${scope.assistantId}` : "global";
}

function snapshotOf(entry: MemoryEntry): ForgetSnapshot {
  return {
    id: entry.id,
    content: entry.content,
    status: normalizeMemoryStatus(entry.status),
    kind: normalizeMemoryKind(entry.kind),
    rawContent: entry.rawContent ?? null,
    facets: entry.facets ?? null,
    explicitRemember: entry.explicitRemember === true,
    generation: Math.max(0, Math.round(Number(entry.generation) || 0)),
    distilledAt: Number(entry.distilledAt) > 0 ? Number(entry.distilledAt) : null,
    purgeAfter: Number(entry.purgeAfter) > 0 ? Number(entry.purgeAfter) : null,
    source: entry.source === "ai" ? "ai" : "manual",
    updatedAt: entry.updatedAt,
  };
}

function parseSnapshot(raw: unknown): ForgetSnapshot | null {
  if (!isRecord(raw)) return null;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    content: String(raw.content ?? ""),
    status: normalizeMemoryStatus(raw.status),
    kind: normalizeMemoryKind(raw.kind),
    rawContent: typeof raw.rawContent === "string" ? raw.rawContent : null,
    facets: raw.facets && typeof raw.facets === "object" ? normalizeMemoryFacets(raw.facets) : null,
    explicitRemember: raw.explicitRemember === true,
    generation: Math.max(0, Math.round(Number(raw.generation) || 0)),
    distilledAt: Number(raw.distilledAt) > 0 ? Number(raw.distilledAt) : null,
    purgeAfter: Number(raw.purgeAfter) > 0 ? Number(raw.purgeAfter) : null,
    source: raw.source === "ai" ? "ai" : "manual",
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

interface ApplyBefore {
  target: ForgetSnapshot;
  members: ForgetSnapshot[];
}

function parseBefore(raw: unknown): ApplyBefore | null {
  if (!isRecord(raw)) return null;
  const target = parseSnapshot(raw.target);
  if (!target) return null;
  const members = Array.isArray(raw.members)
    ? raw.members.map(parseSnapshot).filter((item): item is ForgetSnapshot => item != null)
    : [];
  return { target, members };
}

/** L2 粗化后的标签：时间改粗，其余标签原样保留（预览里没删的细节不偷偷删）。 */
function coarseFacets(raw: MemoryFacets | null | undefined): MemoryFacets | null {
  const facets = normalizeMemoryFacets(raw);
  if (!facets) return null;
  const next: MemoryFacets = { ...facets };
  if (next.time) next.time = coarseTimeLabel(next.time);
  return next;
}

/** L3 主题只保留事件槽位与标签；具体时间地点人物不再保留。 */
function themeFacets(raw: MemoryFacets | null | undefined): MemoryFacets | null {
  const facets = normalizeMemoryFacets(raw);
  if (!facets) return null;
  const next: MemoryFacets = {};
  if (facets.event) next.event = facets.event;
  if (facets.tags?.length) next.tags = facets.tags;
  return Object.keys(next).length > 0 ? next : null;
}

function cleanModelText(text: string): string {
  return text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
}

function buildDistillPrompt(op: MaintenanceOp, proposal: MaintenanceProposal, members: MemoryEntry[]): string {
  if (op === "fidelity") {
    return [
      "把下面这条记忆改写成更短的保真摘要。",
      "保留全部关键事实、数字、偏好与约束，不添加原文没有的信息，不要解释。",
      "只输出摘要本身。",
      "",
      proposal.currentContent,
    ].join("\n");
  }
  if (op === "coarsen") {
    return [
      "把下面这条事件记忆粗化成一句话：只保留「多久以前 + 发生了什么」，",
      "删掉具体日期、钟点、地点和次要细节，不要编造。只输出结果。",
      "",
      proposal.currentContent,
    ].join("\n");
  }
  const lines = members
    .map((member) => `- #${member.id} ${String(member.content ?? "").slice(0, 300)}`)
    .join("\n");
  return [
    "把下面这些同类事件合并成一条主题要旨：只保留共同模式与大致频率，",
    "删掉每次的具体时间地点和无关细节，不要编造。只输出结果。",
    "",
    lines,
  ].join("\n");
}

async function rewriteWithModel(
  op: MaintenanceOp,
  proposal: MaintenanceProposal,
  members: MemoryEntry[],
): Promise<string> {
  const model = resolveMemoryModel();
  if (!model) throw new Error("未配置记忆场景模型");
  const text = await fetchAuxiliaryText(model.model.id, buildDistillPrompt(op, proposal, members), "memory-distill", {
    maxTokens: 400,
    reasoningLevel: memoryModelThinkingEnabled() ? "AUTO" : undefined,
  });
  const cleaned = cleanModelText(text);
  if (!cleaned) throw new Error("记忆模型返回空摘要");
  return cleaned;
}

/** 当前记忆是否还与快照一致——一致就不碰，避免失败回滚反而刷新 updatedAt。 */
function matchesSnapshot(entry: MemoryEntry, snap: ForgetSnapshot): boolean {
  return entry.content === snap.content
    && normalizeMemoryStatus(entry.status) === snap.status
    && normalizeMemoryKind(entry.kind) === snap.kind
    && (entry.rawContent ?? null) === snap.rawContent
    && JSON.stringify(entry.facets ?? null) === JSON.stringify(snap.facets ?? null)
    && (entry.explicitRemember === true) === snap.explicitRemember
    && Math.max(0, Math.round(Number(entry.generation) || 0)) === snap.generation
    && (Number(entry.distilledAt) > 0 ? Number(entry.distilledAt) : null) === snap.distilledAt
    && (Number(entry.purgeAfter) > 0 ? Number(entry.purgeAfter) : null) === snap.purgeAfter;
}

/** 撤销 / 失败回滚共用：按快照还原一条记忆（内容、分类、状态、实验元数据）。 */
function restoreSnapshot(snap: ForgetSnapshot): boolean {
  const entry = memoryStore.findEntryById(snap.id);
  if (!entry) return false;
  if (matchesSnapshot(entry, snap)) return true;
  if (!snap.content.trim()) {
    // 墓碑快照没有正文；只有状态与元数据可还原。
    memoryStore.patchMemoryExperimentFields(snap.id, {
      rawContent: snap.rawContent,
      facets: snap.facets,
      generation: snap.generation,
      distilledAt: snap.distilledAt,
      purgeAfter: snap.purgeAfter,
    }, false);
  } else {
    memoryStore.updateMemory(snap.id, snap.content, "manual", {
      kind: snap.kind,
      explicitRemember: snap.explicitRemember,
      facets: snap.facets,
      rawContent: snap.rawContent,
    });
    memoryStore.patchMemoryExperimentFields(snap.id, {
      generation: snap.generation,
      distilledAt: snap.distilledAt,
      purgeAfter: snap.purgeAfter,
    }, false);
  }
  memoryStore.setMemoryStatuses([{ id: snap.id, status: snap.status }], false);
  // 撤销要连来源与时间一起还原：失真执行改写了 source / updatedAt，不回退会让
  // 「从没发生过」的记忆显示成手动编辑过、并推迟下一次维护到期时间。
  const restored = memoryStore.findEntryById(snap.id);
  if (restored) {
    restored.source = snap.source;
    if (snap.updatedAt > 0) restored.updatedAt = snap.updatedAt;
  }
  return true;
}

function recordApplyFailure(db: ReturnType<typeof openExperimentDb>, auditId: string, proposal: MaintenanceProposal, error: unknown): void {
  if (!db) return;
  recordAudit(db, {
    action: "distill_apply",
    status: "failed",
    memoryId: proposal.targetId,
    detail: {
      auditId,
      op: proposal.op,
      targetId: proposal.targetId,
      error: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    },
  });
}

/**
 * 执行一条维护计划。所有校验与模型调用在写内存之前完成；写入阶段任何异常都按
 * 执行前快照回滚，计划保持 proposed 可重试，失败留 distill_apply / failed 审计。
 */
export async function applyMaintenanceProposal(
  auditId: string,
  options: { now?: number } = {},
): Promise<ForgetApplyResult> {
  if (!memoryExperimentFeature("maintenance")) throw new Error("周期维护未开启");
  if (!memoryExperimentMutates()) throw new Error("试运行中只能生成计划，关闭试运行后才能执行");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");

  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "distill_plan") throw new Error("维护计划不存在");
  if (audit.status !== "proposed") throw new Error(`计划当前状态为 ${audit.status}，不能执行`);
  const proposal = parseMaintenanceProposal(audit.detail);
  if (!proposal) throw new Error("维护计划内容无效");

  const target = memoryStore.findEntryById(proposal.targetId);
  if (!target) throw new Error(`目标记忆 #${proposal.targetId} 不存在`);
  if (normalizeMemoryStatus(target.status) !== "active") throw new Error("目标记忆已不是有效状态，计划已过期");
  if (isProtectedMemory(target)) throw new Error("目标记忆受保护，不能执行失真");
  const targetScope = scopeKeyOfMemory(target.id);
  if (!targetScope) throw new Error("无法确认目标记忆的作用域");
  if (proposal.scopeKey && proposal.scopeKey !== targetScope) throw new Error("计划作用域与当前记忆不一致");

  const memberIds = [...new Set([proposal.targetId, ...proposal.memberIds])];
  const members: MemoryEntry[] = [];
  for (const id of memberIds) {
    const entry = memoryStore.findEntryById(id);
    if (!entry) throw new Error(`参与记忆 #${id} 不存在，计划已过期`);
    if (id !== target.id) {
      if (normalizeMemoryStatus(entry.status) !== "active") throw new Error(`记忆 #${id} 已不是有效状态，计划已过期`);
      if (isProtectedMemory(entry)) throw new Error(`记忆 #${id} 受保护，不能参与主题合并`);
      if (scopeKeyOfMemory(id) !== targetScope) throw new Error(`记忆 #${id} 与目标不在同一作用域`);
    }
    members.push(entry);
  }

  const settings = getMemoryExperimentSettings();
  const purgeDays = Math.max(0, Math.round(Number(settings.purgeAfterDays) || 0));
  const now = options.now ?? Date.now();
  const purgeAfter = purgeDays > 0 ? now + purgeDays * DAY_MS : null;
  const canUseModel = memoryExperimentLlmAllowed() && resolveMemoryModel() != null;

  // ---- 1) 先定稿内容：失败时不碰任何记忆 ----
  let content = proposal.content.trim();
  let modelUsed = false;
  if (proposal.op === "fidelity") {
    if (!canUseModel) {
      const err = new Error("保真摘要需要记忆场景模型：请先在「设置 › 模型 › 场景模型」配置记忆模型，并打开 LLM 辅助");
      recordApplyFailure(db, auditId, proposal, err);
      throw err;
    }
    try {
      content = await rewriteWithModel("fidelity", proposal, [target]);
      modelUsed = true;
    } catch (err) {
      recordApplyFailure(db, auditId, proposal, err);
      throw new Error(`保真摘要生成失败，记忆未改动：${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!content) {
    // 计划生成时没有模型（确定性预览为空）：执行阶段用同一套确定性规则兜底。
    const preview = coarsenEventContent(target);
    content = preview.content;
    if (!content || content === target.content) {
      const err = new Error("没有可以粗化的内容（原文已经是粗粒度）");
      recordApplyFailure(db, auditId, proposal, err);
      throw err;
    }
  }
  // coarsen / theme_merge 直接执行计划里展示过的预览：用户批准的是什么就写什么，
  // 不在执行阶段再偷偷调用模型改写。
  if (!content.trim()) throw new Error("失真结果为空，未改动任何记忆");

  // ---- 2) 执行前快照写进审计（撤销与失败回滚的凭据）----
  const before: ApplyBefore = { target: snapshotOf(target), members: members.map(snapshotOf) };
  updateAuditResult(db, auditId, audit.status, { applying: { at: now, modelUsed } });

  const statusChanged: Array<{ id: number; status: string }> = [];
  let edges = 0;
  let generation = before.target.generation;

  try {
    if (proposal.op === "theme_merge") {
      const survivors = members.filter((member) => member.id !== target.id);
      const nextRaw = target.rawContent == null ? target.content : target.rawContent;
      memoryStore.updateMemory(target.id, content, "ai", {
        rawContent: nextRaw,
        facets: themeFacets(target.facets),
      });
      for (const member of survivors) {
        recordMemoryEdge(db, {
          sourceId: member.id,
          targetId: target.id,
          kind: "merged_into",
          meta: { reason: proposal.reason, auditId, op: proposal.op },
        });
        edges += 1;
        statusChanged.push({ id: member.id, status: "archived" });
      }
      memoryStore.setMemoryStatuses(
        statusChanged.map((item) => ({ id: item.id, status: normalizeMemoryStatus(item.status) })),
        false,
      );
      generation = Math.max(before.target.generation, proposal.toGeneration, 2);
    } else {
      const nextRaw = target.rawContent == null ? target.content : target.rawContent;
      memoryStore.updateMemory(target.id, content, "ai", {
        rawContent: nextRaw,
        ...(proposal.op === "coarsen" ? { facets: coarseFacets(target.facets) } : {}),
      });
      generation = proposal.op === "coarsen"
        ? Math.max(before.target.generation, proposal.toGeneration)
        : before.target.generation;
    }
    memoryStore.patchMemoryExperimentFields(target.id, {
      generation,
      distilledAt: now,
      purgeAfter,
    }, false);
    void memoryStore.persistAll();
  } catch (err) {
    // 失败回滚：按快照还原目标与成员，计划保持 proposed。
    for (const snap of [before.target, ...before.members]) restoreSnapshot(snap);
    deleteMemoryEdgesByAudit(db, auditId);
    void memoryStore.persistAll();
    updateAuditResult(db, auditId, audit.status, {
      applying: { at: now, failedAt: Date.now(), error: err instanceof Error ? err.message : String(err) },
    });
    recordApplyFailure(db, auditId, proposal, err);
    throw new Error(`执行失败，已回滚：${err instanceof Error ? err.message : String(err)}`);
  }

  updateAuditResult(db, auditId, "applied", {
    appliedAt: now,
    applied: {
      op: proposal.op,
      targetId: target.id,
      generation,
      modelUsed,
      purgeAfter,
      statusChanged,
      edges,
      before,
    },
  });
  recordAudit(db, {
    action: "distill_apply",
    status: "applied",
    memoryId: target.id,
    idempotencyKey: `${auditId}:apply`,
    detail: {
      auditId,
      op: proposal.op,
      targetId: target.id,
      generation,
      modelUsed,
      purgeAfter,
      statusChanged,
    },
  });

  return {
    auditId,
    op: proposal.op,
    targetId: target.id,
    generation,
    archivedIds: statusChanged.map((item) => item.id),
    modelUsed,
    purgeAfter,
  };
}

/** 撤销一次执行：延迟清除期内可用。原文已清除 / 参与记忆已删除时拒绝。 */
export function undoDistillApply(auditId: string): ForgetUndoResult {
  if (!memoryExperimentFeature("maintenance")) throw new Error("周期维护未开启");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");
  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "distill_plan") throw new Error("维护计划不存在");
  if (audit.status !== "applied") throw new Error(`计划当前状态为 ${audit.status}，不能撤销`);
  const applied = isRecord(audit.detail.applied) ? audit.detail.applied : null;
  if (!applied) throw new Error("执行记录缺少撤销快照");
  if (Number(applied.purgedAt) > 0) throw new Error("原文已按延迟清除策略删除，不能再撤销");
  const before = parseBefore(applied.before);
  if (!before) throw new Error("撤销快照无效");

  const snapshots = [before.target, ...before.members.filter((item) => item.id !== before.target.id)];
  for (const snap of snapshots) {
    if (!memoryStore.findEntryById(snap.id)) throw new Error(`记忆 #${snap.id} 已不存在，无法完整撤销`);
    if (snap.id === before.target.id && !snap.content.trim()) throw new Error("目标记忆正文已清空，无法撤销");
  }
  for (const snap of snapshots) restoreSnapshot(snap);
  void memoryStore.persistAll();
  deleteMemoryEdgesByAudit(db, auditId);
  const now = Date.now();
  updateAuditResult(db, auditId, "rejected", { undoneAt: now });
  recordAudit(db, {
    action: "restore",
    status: "info",
    memoryId: before.target.id,
    idempotencyKey: `${auditId}:undo`,
    detail: { auditId, targetId: before.target.id, restoredIds: snapshots.map((item) => item.id), at: now },
  });
  return { auditId, targetId: before.target.id, restoredIds: snapshots.map((item) => item.id) };
}

function runStamp(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `purge:run:${date.getFullYear()}-${month}-${day}`;
}

/** 到期清除：清 rawContent；L3 主题（gen≥2 事件）到期时正文一并遗忘，留 tombstone。 */
export function runForgettingPurge(options: { now?: number; trigger?: "startup" | "manual" } = {}): PurgeResult {
  const empty: PurgeResult = { dryRun: false, scanned: 0, due: 0, purgedRaw: 0, tombstoned: 0, cleaned: 0 };
  if (!memoryExperimentFeature("maintenance")) return empty;
  const now = options.now ?? Date.now();
  const all = collectAll();
  const dryRun = !memoryExperimentMutates();
  if (dryRun) {
    const due = all.filter((entry) => {
      const purgeAt = Number(entry.purgeAfter) || 0;
      return purgeAt > 0 && purgeAt <= now;
    }).length;
    return { ...empty, dryRun: true, scanned: all.length, due };
  }
  const db = openExperimentDb();
  if (!db) return empty;

  let due = 0;
  let purgedRaw = 0;
  let tombstoned = 0;
  let cleaned = 0;
  let changed = false;

  for (const entry of all) {
    const purgeAt = Number(entry.purgeAfter) || 0;
    if (purgeAt <= 0 || purgeAt > now) continue;
    due += 1;
    const status = normalizeMemoryStatus(entry.status);
    const generation = Math.max(0, Math.round(Number(entry.generation) || 0));
    const isTheme = normalizeMemoryKind(entry.kind) === "event" && generation >= 2 && status === "active";
    if (status === "tombstone") {
      // 已经是墓碑（重复扫描）：只清掉计时，不重复记审计。
      memoryStore.patchMemoryExperimentFields(entry.id, { rawContent: null, purgeAfter: null }, false);
      changed = true;
      cleaned += 1;
      continue;
    }
    if (isTheme) {
      memoryStore.tombstoneMemory(entry.id, false);
      recordAudit(db, {
        action: "tombstone",
        status: "info",
        memoryId: entry.id,
        idempotencyKey: `tombstone:${entry.id}:${purgeAt}`,
        detail: { at: now, generation, field: "content", reason: "L3 主题到期，删除正文留墓碑" },
      });
      scrubMemoryAudits(db, entry.id, now);
      changed = true;
      tombstoned += 1;
      continue;
    }
    if (entry.rawContent != null) {
      memoryStore.patchMemoryExperimentFields(entry.id, { rawContent: null, purgeAfter: null }, false);
      recordAudit(db, {
        action: "purge",
        status: "info",
        memoryId: entry.id,
        idempotencyKey: `purge:${entry.id}:${purgeAt}`,
        detail: { at: now, generation, field: "rawContent" },
      });
      scrubMemoryAudits(db, entry.id, now);
      changed = true;
      purgedRaw += 1;
      continue;
    }
    // purgeAfter 到期但已无原文可删：清计时。
    memoryStore.patchMemoryExperimentFields(entry.id, { purgeAfter: null }, false);
    changed = true;
    cleaned += 1;
  }

  if (changed) void memoryStore.persistAll();

  // 启动补算每天只留一条 info 汇总；手动执行靠返回值与单条审计。
  if (options.trigger === "startup") {
    const key = runStamp(now);
    if (!getAuditByIdempotencyKey(db, key)) {
      recordAudit(db, {
        action: "purge",
        status: "info",
        idempotencyKey: key,
        detail: { run: "startup", at: now, scanned: all.length, due, purgedRaw, tombstoned },
      });
    }
  }

  return { dryRun: false, scanned: all.length, due, purgedRaw, tombstoned, cleaned };
}

/**
 * 到期的记忆在审计里也只留占位符：原文删除后，计划 / 执行快照里的 currentContent、
 * involved 与 before 快照同步抹字，并标记 applied.purgedAt（此后撤销被拒绝）。
 */
function scrubMemoryAudits(db: NonNullable<ReturnType<typeof openExperimentDb>>, memoryId: number, now: number): void {
  const audits = listAudit(db, { memoryId, limit: 500 });
  for (const audit of audits) {
    const detail = { ...audit.detail };
    let touched = false;
    if (typeof detail.currentContent === "string" && detail.currentContent.trim()) {
      detail.currentContent = PURGED_TEXT;
      touched = true;
    }
    if (Array.isArray(detail.involved)) {
      detail.involved = detail.involved.map((item) => {
        if (!isRecord(item) || Number(item.id) !== memoryId) return item;
        if (typeof item.content !== "string" || !item.content.trim()) return item;
        touched = true;
        return { ...item, content: PURGED_TEXT };
      });
    }
    if (isRecord(detail.applied)) {
      const applied = { ...detail.applied };
      const before = isRecord(applied.before) ? { ...applied.before } : null;
      if (before) {
        const targetSnapshot = isRecord(before.target) ? { ...before.target } : null;
        if (targetSnapshot && Number(targetSnapshot.id) === memoryId) {
          targetSnapshot.content = PURGED_TEXT;
          targetSnapshot.rawContent = null;
          before.target = targetSnapshot;
          touched = true;
        }
        if (Array.isArray(before.members)) {
          before.members = before.members.map((item) => {
            if (!isRecord(item) || Number(item.id) !== memoryId) return item;
            touched = true;
            return { ...item, content: PURGED_TEXT, rawContent: null };
          });
        }
        applied.before = before;
      }
      if (audit.status === "applied") {
        applied.purgedAt = now;
        touched = true;
      }
      detail.applied = applied;
    }
    if (touched) updateAuditDetail(db, audit.auditId, detail);
  }
}

export function listAppliedDistillations(): ForgetAppliedRecord[] {
  const db = openExperimentDb();
  if (!db) return [];
  const records = listAudit(db, { action: "distill_plan", status: "applied", limit: 100 });
  const out: ForgetAppliedRecord[] = [];
  for (const audit of records) {
    const proposal = parseMaintenanceProposal(audit.detail);
    if (!proposal) continue;
    const applied = isRecord(audit.detail.applied) ? audit.detail.applied : {};
    out.push({
      auditId: audit.auditId,
      at: Number(audit.detail.appliedAt) || audit.at,
      op: proposal.op,
      targetId: proposal.targetId,
      content: proposal.content,
      currentContent: proposal.currentContent,
      scopeLabel: proposal.scopeLabel,
      modelUsed: applied.modelUsed === true,
      purgedAt: Number(applied.purgedAt) > 0 ? Number(applied.purgedAt) : null,
    });
  }
  return out;
}

export function forgettingSummary(options: { now?: number } = {}): ForgettingSummary {
  const now = options.now ?? Date.now();
  const empty: ForgettingSummary = {
    now,
    lastPurgeAt: null,
    pendingRawPurges: 0,
    pendingTombstones: 0,
    scheduledPurges: 0,
    earliestPurgeAt: null,
    applied: [],
  };
  if (!memoryExperimentFeature("maintenance")) return empty;
  const db = openExperimentDb();
  if (!db) return empty;

  let pendingRawPurges = 0;
  let pendingTombstones = 0;
  let scheduledPurges = 0;
  let earliestPurgeAt: number | null = null;
  for (const entry of collectAll()) {
    const purgeAt = Number(entry.purgeAfter) || 0;
    if (purgeAt <= 0) continue;
    if (purgeAt > now) {
      scheduledPurges += 1;
      earliestPurgeAt = earliestPurgeAt == null ? purgeAt : Math.min(earliestPurgeAt, purgeAt);
      continue;
    }
    const status = normalizeMemoryStatus(entry.status);
    const generation = Math.max(0, Math.round(Number(entry.generation) || 0));
    if (status === "active" && normalizeMemoryKind(entry.kind) === "event" && generation >= 2) {
      pendingTombstones += 1;
    } else if (entry.rawContent != null) {
      pendingRawPurges += 1;
    }
  }
  const latest = listAudit(db, { action: "purge", status: "info", limit: 1 })[0];
  return {
    now,
    lastPurgeAt: latest?.at ?? null,
    pendingRawPurges,
    pendingTombstones,
    scheduledPurges,
    earliestPurgeAt,
    applied: listAppliedDistillations(),
  };
}

let catchUpScheduled = false;

/** 启动补算清除：在维护计划之后延迟执行（同样不阻塞启动、不驻留定时器）。 */
export function scheduleForgettingPurge(): void {
  if (catchUpScheduled) return;
  if (!memoryExperimentFeature("maintenance")) return;
  catchUpScheduled = true;
  const timer = setTimeout(() => {
    try {
      runForgettingPurge({ trigger: "startup" });
    } catch (err) {
      reportError("persistence", "warn", "到期清除补算失败", err, "memory_forget_catch_up_failed");
    }
  }, 8_000) as unknown as { unref?: () => void };
  timer.unref?.();
}

