// 第二轮提及计分与事件 → 习惯晋升。
//
// 只回答一个问题：用户本人是否在最新一轮里再次主动提到了某条已有记忆？
// - 只看用户消息；检索命中、记忆注入、助手复述、工具输出一律不计分；
// - 词法 / slotKey 先做保守初筛，再对少量候选做一次批量模型确认；
// - 同一会话同一记忆最多计一次（跨重启由审计幂等键保证）；
// - 提及分只更新计数，不改内容 / 状态；热记忆（计数达阈值）在后续维护中受保护；
// - 跨会话重复出现的同类事件只生成「事件 → 习惯」待确认提案，绝不自动改类。
//
// 安全纪律：功能关闭 / 无用户消息 / 模型确认失败都没有副作用；任何异常由调度方
// 吞掉并上报，绝不阻塞聊天。
import { createHash } from "node:crypto";
import type { Assistant, Conversation, MemoryEntry, Message } from "../../foundation/types";
import { textFromParts } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { reportError } from "../../observability/app-errors";
import { fetchAuxiliaryText } from "../../conversations/auxiliary";
import { getConversation } from "../../conversations/index";
import { memoriesForAssistant, memoryStore } from "../index";
import { memoryModelThinkingEnabled, resolveMemoryModel } from "../memory-model";
import { lexicalRelevance } from "../dynamic-recall";
import {
  isHotMemory,
  isProtectedMemory,
  mentionScoreOf,
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
  getAudit,
  getAuditByIdempotencyKey,
  listAudit,
  openExperimentDb,
  recordAudit,
  recordMemoryEdge,
  updateAuditResult,
  type MemoryAuditStatus,
} from "./store";

const DAY_MS = 86_400_000;
/** 单轮用户文本预算：只看最新一轮，超长只保留靠后部分（更近的诉求更重要）。 */
const TURN_TEXT_MAX_CHARS = 4_000;
/** 单轮最多确认 6 条候选，且最多一次模型调用。 */
const MAX_CANDIDATES = 6;
/** 初筛门槛：至少 3 个中文字符的实体重合，或命中结构化 slot。 */
const PREFILTER_LEXICAL = 0.6;
/** 无模型时的确定性确认门槛：更高，宁可少计。 */
const DETERMINISTIC_LEXICAL = 0.8;
/** 提及分半衰期：跨会话重复越密集分越高，长期不提会自然回落。 */
const MENTION_HALF_LIFE_DAYS = 7;
/** 单次晋升扫描的边界。 */
const MAX_PROMOTION_MEMORIES = 500;
const MAX_PROMOTIONS = 10;

export interface MentionScoreOutcome {
  status: "disabled" | "skipped" | "none" | "scored" | "failed";
  reason?: string;
  candidates: number;
  scored: number;
  confirmedBy: "model" | "lexical" | "none" | "failed";
  promotions: number;
}

export interface EventPromotionProposal {
  op: "event_to_habit";
  targetId: number;
  memberIds: number[];
  content: string;
  reason: string;
  confidence: number;
  slotKey: string;
  slotLabel: string;
  scopeKey: string;
  scopeLabel: string;
  sourceConversationIds: string[];
  involved: Array<{ id: number; content: string; sourceConversationId: string | null }>;
}

export interface EventPromotionRecord extends EventPromotionProposal {
  auditId: string;
  status: MemoryAuditStatus;
  at: number;
}

interface MentionCandidate {
  memory: MemoryEntry;
  lexical: number;
  slot: boolean;
}

interface UserTurn {
  text: string;
  messageIds: string[];
}

function selectedMessages(conversation: Conversation): Message[] {
  const out: Message[] = [];
  for (const node of conversation.messages ?? []) {
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (message) out.push(message);
  }
  return out;
}

/** 最新一轮用户消息（连续的 USER 段）。只在用户消息上计分，助手回复 / 工具输出不参与。 */
export function latestUserTurn(conversation: Conversation): UserTurn | null {
  const messages = selectedMessages(conversation);
  const turn: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const role = String(message.role ?? "").toUpperCase();
    if (role === "USER") {
      turn.unshift(message);
      continue;
    }
    // 跳过生成后的助手尾巴；一旦已经收集到用户消息，再遇到非用户消息就是上一轮。
    if (turn.length > 0) break;
  }
  if (turn.length === 0) return null;
  const text = turn
    .map((message) => textFromParts(message.parts ?? []).trim())
    .filter(Boolean)
    .join("\n");
  const trimmed = text.length > TURN_TEXT_MAX_CHARS ? text.slice(-TURN_TEXT_MAX_CHARS) : text;
  if (!trimmed.trim()) return null;
  return { text: trimmed, messageIds: turn.map((message) => message.id) };
}

/** slotKey 的来源：facets.event 优先，其次第一个可用标签。时间不参与（「上周」不是实体）。 */
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

/** 提及匹配文本：正文 + 人物 / 地点 / 事件 / 标签；不拼 time，避免「上周」误伤。 */
function mentionSearchText(memory: MemoryEntry): string {
  const parts = [memory.content];
  const facets = normalizeMemoryFacets(memory.facets);
  if (facets) {
    for (const value of [facets.person, facets.place, facets.event, ...(facets.tags ?? [])]) {
      if (value) parts.push(value);
    }
  }
  return parts.join(" ");
}

function slotAnchors(memory: MemoryEntry): string[] {
  const facets = normalizeMemoryFacets(memory.facets);
  const anchors: string[] = [];
  for (const value of [facets?.person, facets?.place, facets?.event, ...(facets?.tags ?? [])]) {
    const text = String(value ?? "").trim().toLowerCase();
    // 单字标签不做实体锚点：命中率高但没有区分度。
    if ([...text].length < 2) continue;
    anchors.push(text);
  }
  return [...new Set(anchors)];
}

function slotHit(query: string, memory: MemoryEntry): boolean {
  const lower = query.toLowerCase();
  return slotAnchors(memory).some((anchor) => lower.includes(anchor));
}

function collectCandidates(query: string, memories: readonly MemoryEntry[]): MentionCandidate[] {
  const picked: MentionCandidate[] = [];
  for (const memory of memories) {
    if (normalizeMemoryStatus(memory.status) !== "active") continue;
    if (!memory.content.trim()) continue;
    const lexical = lexicalRelevance(query, mentionSearchText(memory));
    const slot = slotHit(query, memory);
    if (!slot && lexical < PREFILTER_LEXICAL) continue;
    picked.push({ memory, lexical, slot });
  }
  return picked
    .sort((left, right) => Number(right.slot) - Number(left.slot)
      || right.lexical - left.lexical
      || right.memory.updatedAt - left.memory.updatedAt
      || right.memory.id - left.memory.id)
    .slice(0, MAX_CANDIDATES);
}

/** 疑问 / 否定的用户话语不做确定性计分：没有模型时宁可少计，也不能把
 *  「我是不是说过喜欢绿茶？」「我不喜欢绿茶了」当成再次确认。 */
const QUESTION_TAIL = /[?？]\s*$|(吗|么|呢|什么|哪个|哪里|谁|多少|怎么|为什么|是否|是不是|有没有)[^。！!]*[?？]?\s*$/;
const NEGATION = /(不是|不再|没有|没在|不喜欢|不想|讨厌|别再|别在|不爱)/;

function confirmByLexical(candidate: MentionCandidate, turnText: string): boolean {
  if (QUESTION_TAIL.test(turnText) || NEGATION.test(turnText)) return false;
  return candidate.slot || candidate.lexical >= DETERMINISTIC_LEXICAL;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let body = String(text ?? "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 模型确认结果解析：只接受候选内 id；未知 / 重复 / 非整数一律丢弃。 */
export function parseMentionConfirmation(raw: unknown, candidateIds: readonly number[]): number[] {
  const parsed = typeof raw === "string" ? extractJsonObject(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>).confirmed;
  if (!Array.isArray(list)) return [];
  const allowed = new Set(candidateIds);
  const seen = new Set<number>();
  const confirmed: number[] = [];
  for (const value of list) {
    const id = Number(value);
    if (!Number.isInteger(id) || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    confirmed.push(id);
  }
  return confirmed;
}

function buildConfirmPrompt(turnText: string, candidates: readonly MentionCandidate[]): string {
  const list = candidates.map((candidate) => ({
    id: candidate.memory.id,
    content: candidate.memory.content.slice(0, 240),
  }));
  return `你是长期记忆的提及判定器。用户最新一轮消息如下：
${turnText}

候选记忆：
${JSON.stringify(list, null, 2)}

只判断：用户本人是否在这条消息里再次主动陈述了某条候选记忆中的同一事实/偏好。
- 助手说过、系统注入过、检索命中都不算；
- 用户只是提问、否定、假设、讨论别人的事也不算；
- 只有语义上是同一断言（允许不同措辞）才确认。

只输出 JSON：{"confirmed":[记忆 id]}
没有确认项输出 {"confirmed":[]}。不要输出 JSON 之外的任何文字。`;
}

/** 批量模型确认。返回 null = 模型未配置 / 调用失败（本轮全部不计分）。 */
async function confirmByModel(
  conversation: Conversation,
  turnText: string,
  candidates: readonly MentionCandidate[],
): Promise<number[] | null> {
  const model = resolveMemoryModel();
  if (!model) return null;
  try {
    const raw = await fetchAuxiliaryText(
      model.model.id,
      buildConfirmPrompt(turnText, candidates),
      "memory-mention",
      {
        maxTokens: 300,
        conversationId: conversation.id,
        reasoningLevel: memoryModelThinkingEnabled() ? "AUTO" : undefined,
      },
    );
    return parseMentionConfirmation(raw, candidates.map((candidate) => candidate.memory.id));
  } catch (err) {
    reportError("provider", "warn", "提及确认模型调用失败", err, "memory_mention_confirm_failed", {
      conversationId: conversation.id,
    });
    return null;
  }
}

/** 下一次提及分：跨会话重复按 7 天半衰期累加，每提到一次加 1/阈值，封顶 1。 */
export function nextMentionScore(
  previousScore: number,
  lastMentionedAt: number | null,
  now: number,
  hotThreshold: number,
): number {
  const gapDays = lastMentionedAt && lastMentionedAt > 0
    ? Math.max(0, now - lastMentionedAt) / DAY_MS
    : 0;
  const decayed = mentionScoreOf({ mentionScore: previousScore }) * Math.pow(0.5, gapDays / MENTION_HALF_LIFE_DAYS);
  const increment = 1 / Math.max(2, Math.round(Number(hotThreshold) || 5));
  return Math.round(Math.min(1, decayed + increment) * 1000) / 1000;
}

function mentionAuditKey(conversationId: string, memoryId: number): string {
  return `mention:${conversationId}:${memoryId}`;
}

/**
 * 执行一轮提及计分。调用方可以是每轮生成后的后台调度，也可以是测试 / 手动入口。
 * 顺序：候选初筛 → 批量确认 → 审计占位（同会话只计一次）→ 更新计数 → 晋升提案扫描。
 */
export async function runMentionScoringNow(
  conversation: Conversation,
  assistant: Assistant,
  options: { now?: number } = {},
): Promise<MentionScoreOutcome> {
  if (!memoryExperimentFeature("mentionScoring")) {
    return { status: "disabled", candidates: 0, scored: 0, confirmedBy: "none", promotions: 0 };
  }
  const turn = latestUserTurn(conversation);
  if (!turn) {
    return { status: "skipped", reason: "no_user_message", candidates: 0, scored: 0, confirmedBy: "none", promotions: 0 };
  }
  const memories = memoriesForAssistant(assistant, "recall");
  const candidates = collectCandidates(turn.text, memories);
  if (candidates.length === 0) {
    const promotions = planEventPromotions({ now: options.now });
    return { status: "none", candidates: 0, scored: 0, confirmedBy: "none", promotions: promotions.created };
  }

  let confirmedIds: number[] = [];
  let confirmedBy: MentionScoreOutcome["confirmedBy"] = "none";
  if (memoryExperimentLlmAllowed()) {
    const confirmed = await confirmByModel(conversation, turn.text, candidates);
    if (confirmed == null) {
      const promotions = planEventPromotions({ now: options.now });
      return {
        status: "failed",
        reason: "model_confirmation_failed",
        candidates: candidates.length,
        scored: 0,
        confirmedBy: "failed",
        promotions: promotions.created,
      };
    }
    confirmedIds = confirmed;
    confirmedBy = "model";
  } else {
    confirmedIds = candidates
      .filter((candidate) => confirmByLexical(candidate, turn.text))
      .map((candidate) => candidate.memory.id);
    confirmedBy = "lexical";
  }

  const db = openExperimentDb();
  if (!db) {
    return { status: "failed", reason: "db_unavailable", candidates: candidates.length, scored: 0, confirmedBy, promotions: 0 };
  }
  const now = options.now ?? Date.now();
  const threshold = getMemoryExperimentSettings().hotMentionThreshold;
  const confirmedSet = new Set(confirmedIds);
  let scored = 0;
  for (const candidate of candidates) {
    if (!confirmedSet.has(candidate.memory.id)) continue;
    // 幂等占位：同会话同记忆只计一次；任何已存在的审计（含失败）都不再重复计数。
    const key = mentionAuditKey(conversation.id, candidate.memory.id);
    const reservation = recordAudit(db, {
      action: "mention",
      status: "proposed",
      memoryId: candidate.memory.id,
      conversationId: conversation.id,
      idempotencyKey: key,
      detail: {
        source: "user_message",
        messageIds: turn.messageIds,
        lexical: candidate.lexical,
        slotHit: candidate.slot,
        confirmedBy,
      },
    });
    if (!reservation.inserted) continue;

    const previousCount = Math.max(0, Math.round(Number(candidate.memory.mentionCount) || 0));
    const nextCount = previousCount + 1;
    const nextScore = nextMentionScore(
      candidate.memory.mentionScore ?? 0,
      candidate.memory.lastMentionedAt ?? null,
      now,
      threshold,
    );
    memoryStore.recordMemoryMention(candidate.memory.id, {
      mentionCount: nextCount,
      lastMentionedAt: now,
      mentionScore: nextScore,
    }, false);
    await memoryStore.persistAll();
    updateAuditResult(db, reservation.auditId, "applied", {
      previousCount,
      mentionCount: nextCount,
      mentionScore: nextScore,
      hot: isHotMemory({ mentionCount: nextCount }, threshold),
    });
    scored += 1;
  }

  const promotions = planEventPromotions({ now });
  return { status: scored > 0 ? "scored" : "none", candidates: candidates.length, scored, confirmedBy, promotions: promotions.created };
}

function scopeOf(memoryId: number): { key: string; label: string } | null {
  const scope = memoryStore.scopeOfMemory(memoryId);
  if (!scope) return null;
  if ("assistantId" in scope) {
    const name = state.settings.assistants.find((assistant) => assistant.id === scope.assistantId)?.name || "助手";
    return { key: `assistant:${scope.assistantId}`, label: name };
  }
  return { key: "global", label: "全局记忆" };
}

function proposalKey(targetId: number, content: string, slotKey: string): string {
  const hash = createHash("sha256").update(content.trim(), "utf8").digest("hex").slice(0, 16);
  return `promotion:event_to_habit:${targetId}:${hash}:${slotKey}`;
}

/**
 * 跨会话同类事件 → 事件到习惯的待确认提案。
 * 只读记忆并写审计，不改分类；应用入口见 applyEventPromotion。
 * 同一 slot + 目标 + 内容只生成一次（拒绝过的不会反复冒出来）。
 */
export function planEventPromotions(options: { now?: number; limit?: number } = {}): {
  proposed: number;
  created: number;
  proposals: EventPromotionProposal[];
} {
  if (!memoryExperimentFeature("mentionScoring")) return { proposed: 0, created: 0, proposals: [] };
  const db = openExperimentDb();
  if (!db) return { proposed: 0, created: 0, proposals: [] };

  const pool: MemoryEntry[] = [];
  for (const memory of memoryStore.getGlobalMemories()) pool.push(memory);
  for (const group of memoryStore.getAllAssistantGroups()) for (const memory of group.memories) pool.push(memory);
  const candidates = pool
    .filter((memory) => normalizeMemoryStatus(memory.status) === "active")
    .filter((memory) => normalizeMemoryKind(memory.kind) === "event")
    .filter((memory) => !isProtectedMemory(memory))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PROMOTION_MEMORIES);

  const clusters = new Map<string, { slotKey: string; slotLabel: string; scopeKey: string; scopeLabel: string; members: MemoryEntry[] }>();
  for (const memory of candidates) {
    const slot = eventSlot(memory);
    if (!slot) continue;
    const scope = scopeOf(memory.id);
    if (!scope) continue;
    const key = `${scope.key}|${slot.key}`;
    const cluster = clusters.get(key) ?? {
      slotKey: slot.key,
      slotLabel: slot.label,
      scopeKey: scope.key,
      scopeLabel: scope.label,
      members: [],
    };
    cluster.members.push(memory);
    clusters.set(key, cluster);
  }

  const planned: EventPromotionProposal[] = [];
  const limit = Math.min(MAX_PROMOTIONS, Math.max(1, Math.round(options.limit ?? MAX_PROMOTIONS)));
  for (const cluster of clusters.values()) {
    if (planned.length >= limit) break;
    if (cluster.members.length < 2) continue;
    const conversations = new Set(
      cluster.members
        .map((memory) => memory.sourceConversationId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    // 跨会话重复才叫习惯；同一会话里说了两遍仍是事件。
    if (conversations.size < 2) continue;
    const target = [...cluster.members].sort((left, right) =>
      right.updatedAt - left.updatedAt
      || Math.max(0, Number(right.mentionCount) || 0) - Math.max(0, Number(left.mentionCount) || 0)
      || right.id - left.id,
    )[0]!;
    const key = proposalKey(target.id, target.content, cluster.slotKey);
    if (getAuditByIdempotencyKey(db, key)) continue;
    const proposal: EventPromotionProposal = {
      op: "event_to_habit",
      targetId: target.id,
      memberIds: cluster.members.map((memory) => memory.id),
      content: target.content,
      reason: `同类事件「${cluster.slotLabel}」在 ${conversations.size} 个会话中重复出现，建议晋升为习惯`,
      confidence: Math.min(0.8, 0.6 + (cluster.members.length - 2) * 0.05),
      slotKey: cluster.slotKey,
      slotLabel: cluster.slotLabel,
      scopeKey: cluster.scopeKey,
      scopeLabel: cluster.scopeLabel,
      sourceConversationIds: [...conversations].slice(0, 20),
      involved: cluster.members
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .map((memory) => ({
          id: memory.id,
          content: memory.content,
          sourceConversationId: memory.sourceConversationId ?? null,
        })),
    };
    const rec = recordAudit(db, {
      action: "promotion",
      status: "proposed",
      memoryId: target.id,
      idempotencyKey: key,
      detail: { ...proposal },
    });
    if (rec.inserted) planned.push(proposal);
  }
  return { proposed: planned.length, created: planned.length, proposals: planned };
}

function parsePromotion(detail: Record<string, unknown>): EventPromotionProposal {
  if (detail.op !== "event_to_habit") throw new Error("无效的晋升提案类型");
  const targetId = Number(detail.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new Error("晋升提案缺少目标记忆");
  const memberIds = Array.isArray(detail.memberIds)
    ? detail.memberIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return {
    op: "event_to_habit",
    targetId,
    memberIds,
    content: String(detail.content ?? ""),
    reason: String(detail.reason ?? ""),
    confidence: Number(detail.confidence) || 0,
    slotKey: String(detail.slotKey ?? ""),
    slotLabel: String(detail.slotLabel ?? ""),
    scopeKey: String(detail.scopeKey ?? ""),
    scopeLabel: String(detail.scopeLabel ?? ""),
    sourceConversationIds: Array.isArray(detail.sourceConversationIds)
      ? detail.sourceConversationIds.map(String)
      : [],
    involved: Array.isArray(detail.involved)
      ? detail.involved as EventPromotionProposal["involved"]
      : [],
  };
}

/** 应用一条已批准的晋升：只允许 event → habit，受保护记忆与过期目标一律拒绝。 */
export function applyEventPromotion(auditId: string): {
  auditId: string;
  targetId: number;
  fromKind: "event";
  toKind: "habit";
  edges: number;
} {
  if (!memoryExperimentFeature("mentionScoring")) throw new Error("提及计分未开启");
  if (!memoryExperimentMutates()) throw new Error("试运行中只能生成提案，关闭试运行后才能执行");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");
  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "promotion") throw new Error("晋升提案不存在");
  if (audit.status !== "proposed") throw new Error(`提案当前状态为 ${audit.status}，不能执行`);
  const proposal = parsePromotion(audit.detail);

  const target = memoryStore.findEntryById(proposal.targetId);
  if (!target) throw new Error(`目标记忆 #${proposal.targetId} 不存在`);
  if (normalizeMemoryStatus(target.status) !== "active") throw new Error("目标记忆已不是有效状态，提案已过期");
  // 保护优先：目标已经被升为设定 / 习惯或标为明确记住时，绝不反向改类。
  if (isProtectedMemory(target)) throw new Error("目标记忆受保护，不能执行事件晋升");
  if (normalizeMemoryKind(target.kind) !== "event") throw new Error("目标记忆已不是事件，提案已过期");
  const scope = scopeOf(target.id);
  if (proposal.scopeKey && scope?.key !== proposal.scopeKey) throw new Error("提案作用域与当前记忆不一致");

  memoryStore.promoteMemoryKind(target.id, "habit");
  let edges = 0;
  for (const memberId of proposal.memberIds) {
    if (memberId === target.id) continue;
    const member = memoryStore.findEntryById(memberId);
    if (!member) continue;
    recordMemoryEdge(db, {
      sourceId: memberId,
      targetId: target.id,
      kind: "related",
      meta: { reason: "same_event_type", slotKey: proposal.slotKey, auditId },
    });
    edges += 1;
  }
  void memoryStore.persistAll();
  updateAuditResult(db, auditId, "applied", {
    appliedAt: Date.now(),
    applied: { targetId: target.id, fromKind: "event", toKind: "habit", edges },
  });
  return { auditId, targetId: target.id, fromKind: "event", toKind: "habit", edges };
}

/** 拒绝晋升：只改审计状态；试运行中也可拒绝（安全操作）。 */
export function rejectEventPromotion(auditId: string): { auditId: string; status: "rejected" } {
  if (!memoryExperimentFeature("mentionScoring")) throw new Error("提及计分未开启");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");
  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "promotion") throw new Error("晋升提案不存在");
  if (audit.status !== "proposed") throw new Error(`提案当前状态为 ${audit.status}，不能拒绝`);
  updateAuditResult(db, auditId, "rejected", { rejectedAt: Date.now() });
  return { auditId, status: "rejected" };
}

export function listEventPromotions(status?: MemoryAuditStatus): EventPromotionRecord[] {
  const db = openExperimentDb();
  if (!db) return [];
  return listAudit(db, { action: "promotion", limit: 200, ...(status ? { status } : {}) })
    .filter((entry) => entry.detail.op === "event_to_habit")
    .map((entry) => ({
      ...parsePromotion(entry.detail),
      auditId: entry.auditId,
      status: entry.status,
      at: entry.at,
    }));
}

/** 第二轮跨事件合并（维护阶段）的保护口径：热事件不参与，避免把近期仍有价值的事件揉碎。 */
export function isSecondRoundMergeEligible(memory: MemoryEntry, hotThreshold: number): boolean {
  return normalizeMemoryKind(memory.kind) === "event"
    && normalizeMemoryStatus(memory.status) === "active"
    && !isProtectedMemory(memory)
    && !isHotMemory(memory, hotThreshold);
}

const inFlight = new Set<string>();

/** 每轮生成结束后的后台入口：不 await、不抛错。 */
export function scheduleMentionScoring(conversationId: string): void {
  if (!memoryExperimentFeature("mentionScoring")) return;
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  const assistant = state.settings.assistants.find((item) => item.id === conversation.assistantId);
  if (!assistant) return;
  if (assistant.memoryWriteScope === "readonly") return;
  if (inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  void runMentionScoringNow(conversation, assistant)
    .catch((err) => {
      reportError("persistence", "warn", "提及计分失败", err, "memory_mention_scoring_failed", { conversationId });
    })
    .finally(() => {
      inFlight.delete(conversationId);
    });
}
