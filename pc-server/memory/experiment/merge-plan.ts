// 第一轮合并：确定性规则生成「覆盖 / 完成 / 同类合并」提案。
// 只读记忆并写审计（merge_plan / proposed），不修改任何记忆——执行留给 S8 的批准入口。
// LLM 参与是可选增强：关闭时（默认）只用字符相似度、facets.person 与完成标记。
import type { MemoryEntry, MemoryFacets, MemoryKind, MemoryStatus } from "../../foundation/types";
import { state } from "../../persistence/json-store";
import { memoryStore } from "../index";
import { memoryExperimentFeature } from "./gate";
import { isProtectedMemory, memoryWeight, normalizeMemoryFacets, normalizeMemoryKind, normalizeMemoryStatus } from "./entry";
import { listAudit, openExperimentDb, recordAudit, type MemoryAuditStatus } from "./store";
import { normalizeMemoryContent } from "../dedup";

export type MergeProposalOp = "overwrite" | "complete" | "merge";

export interface MergeCandidate {
  id: number;
  scopeKey: string;
  scopeLabel: string;
  content: string;
  kind: MemoryKind;
  status: MemoryStatus;
  explicitRemember: boolean;
  facets: MemoryFacets | null;
  mentionCount: number;
  updatedAt: number;
}

export interface MergeProposal {
  op: MergeProposalOp;
  targetId: number;
  sourceIds: number[];
  deleteIds: number[];
  content: string;
  reason: string;
  confidence: number;
  scopeKey: string;
  scopeLabel: string;
  protectedIds: number[];
  involved: Array<{ id: number; content: string; role: "target" | "source" }>;
  key: string;
}

export interface MergeProposalRecord extends MergeProposal {
  auditId: string;
  status: MemoryAuditStatus;
  at: number;
}

const COMPLETED_RE = /(已经?完成|已经?交|已办|做完了|搞定了|完成了|\bdone\b|\bfinished\b)/i;
const REMINDER_RE = /(提醒|记得|别忘|待办|要交|需要交|\btodo\b|\bto-do\b|\bremind)/i;
const MERGE_SIMILARITY = 0.55;
const OVERWRITE_SIMILARITY = 0.42;
const COMPLETE_SIMILARITY = 0.3;
const MAX_PROPOSALS = 20;
const MAX_MERGE_CONTENT = 240;

function bigrams(text: string): string[] {
  const normalized = text.replace(/\s+/g, "");
  if (normalized.length <= 2) return normalized ? [normalized] : [];
  const grams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i += 1) grams.push(normalized.slice(i, i + 2));
  return grams;
}

/** 中文字符二元组 Dice 相似度；英文/数字同样按字符处理。 */
export function contentSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram);
    if (count && count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length);
}

interface VaryingParts {
  prefix: string;
  midA: string;
  midB: string;
  suffix: string;
}

function splitVarying(a: string, b: string): VaryingParts | null {
  const left = a.trim();
  const right = b.trim();
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  const midA = left.slice(prefix, left.length - suffix);
  const midB = right.slice(prefix, right.length - suffix);
  if (!midA || !midB) return null;
  if (midA.length + midB.length > 24) return null;
  return { prefix: left.slice(0, prefix), midA, midB, suffix: left.slice(left.length - suffix) };
}

/** 同类合并的建议内容："用户喜欢草莓" + "用户喜欢西瓜" → "用户喜欢草莓、西瓜"。 */
export function mergeContents(a: string, b: string): string {
  const parts = splitVarying(a, b);
  if (parts && !parts.midA.includes("；") && !parts.midB.includes("；")) {
    return `${parts.prefix}${parts.midA}、${parts.midB}${parts.suffix}`.trim();
  }
  const left = a.trim();
  const right = b.trim();
  return left === right ? left : `${left}；${right}`;
}

function personOf(candidate: MergeCandidate): string | null {
  const facets = normalizeMemoryFacets(candidate.facets);
  const person = facets?.person?.trim().toLowerCase();
  return person || null;
}

function sharesTopic(a: string, b: string): boolean {
  const left = bigrams(normalizeMemoryContent(a));
  const right = new Set(bigrams(normalizeMemoryContent(b)));
  let shared = 0;
  const seen = new Set<string>();
  for (const gram of left) {
    if (seen.has(gram)) continue;
    seen.add(gram);
    if (right.has(gram)) shared += 1;
  }
  return shared >= 2;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function proposalKey(op: MergeProposalOp, target: MergeCandidate, sources: MergeCandidate[]): string {
  const sourcePart = sources.map((item) => `${item.id}:${fnv1a(item.content)}`).join(",");
  return `merge:${op}:${target.id}:${fnv1a(target.content)}:${sourcePart}`;
}

function buildProposal(
  op: MergeProposalOp,
  target: MergeCandidate,
  sources: MergeCandidate[],
  content: string,
  reason: string,
  confidence: number,
): MergeProposal {
  const sourceIds = sources.map((item) => item.id);
  const deleteIds = sources.filter((item) => item.id !== target.id).map((item) => item.id);
  // 单条「已完成提醒」：目标自身就是待删除项。
  if (op === "complete" && deleteIds.length === 0 && sources.some((item) => item.id === target.id)) {
    deleteIds.push(target.id);
  }
  const protectedIds = [target, ...sources]
    .filter((item) => isProtectedMemory(item))
    .map((item) => item.id);
  const involved: MergeProposal["involved"] = [
    { id: target.id, content: target.content, role: "target" },
    ...sources
      .filter((item) => item.id !== target.id)
      .map((item) => ({ id: item.id, content: item.content, role: "source" as const })),
  ];
  return {
    op,
    targetId: target.id,
    sourceIds,
    deleteIds,
    content,
    reason,
    confidence,
    scopeKey: target.scopeKey,
    scopeLabel: target.scopeLabel,
    protectedIds,
    involved,
    key: proposalKey(op, target, sources),
  };
}

/** 规则规划：同一作用域内两两比较，按置信度贪心去重（一条记忆只进一个提案）。 */
export function planMergeProposals(candidates: MergeCandidate[]): MergeProposal[] {
  const active = candidates.filter((item) => normalizeMemoryStatus(item.status) === "active");
  const proposals: MergeProposal[] = [];

  // 单条即可判定的「已完成提醒」：内容同时出现提醒与完成标记。
  // 受保护（设定 / 显式记住）的条目不自动进入删除提案。
  for (const item of active) {
    const text = item.content.trim();
    if (text.length > 200) continue;
    if (isProtectedMemory(item)) continue;
    if (COMPLETED_RE.test(text) && REMINDER_RE.test(text)) {
      proposals.push(buildProposal("complete", item, [item], "", "提醒已完成，整条不再保留", 0.82));
    }
  }

  const pairs: Array<{ proposal: MergeProposal; score: number }> = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.scopeKey !== b.scopeKey) continue;
      if (normalizeMemoryContent(a.content) === normalizeMemoryContent(b.content)) continue;
      const similarity = contentSimilarity(a.content, b.content);
      const personA = personOf(a);
      const personB = personOf(b);
      const newer = a.updatedAt >= b.updatedAt ? a : b;
      const older = newer.id === a.id ? b : a;

      const aDone = COMPLETED_RE.test(a.content) && !REMINDER_RE.test(a.content);
      const bDone = COMPLETED_RE.test(b.content) && !REMINDER_RE.test(b.content);
      const aReminder = REMINDER_RE.test(a.content) && !COMPLETED_RE.test(a.content);
      const bReminder = REMINDER_RE.test(b.content) && !COMPLETED_RE.test(b.content);
      const completion = aDone ? a : bDone ? b : null;
      const reminder = aDone ? b : bDone ? a : null;
      if (
        completion
        && reminder
        && (aReminder || bReminder)
        && !isProtectedMemory(reminder)
        && (similarity >= COMPLETE_SIMILARITY || sharesTopic(a.content, b.content))
      ) {
        pairs.push({
          proposal: buildProposal("complete", completion, [completion, reminder], completion.content, "提醒已完成，删除提醒条目", 0.78),
          score: 0.78,
        });
        continue;
      }

      if (personA && personB && personA !== personB && similarity >= OVERWRITE_SIMILARITY) {
        pairs.push({
          proposal: buildProposal("overwrite", newer, [newer, older], newer.content, `人物从「${personOf(older)}」更新为「${personOf(newer)}」`, 0.8),
          score: 0.8,
        });
        continue;
      }

      const mergeableKind = (candidate: MergeCandidate) => normalizeMemoryKind(candidate.kind) !== "event";
      if (
        similarity >= MERGE_SIMILARITY
        && mergeableKind(a)
        && mergeableKind(b)
        && a.content.length <= MAX_MERGE_CONTENT
        && b.content.length <= MAX_MERGE_CONTENT
        && !a.explicitRemember
        && !b.explicitRemember
      ) {
        const target = memoryWeight(a) >= memoryWeight(b) ? a : b;
        const source = target.id === a.id ? b : a;
        pairs.push({
          proposal: buildProposal("merge", target, [target, source], mergeContents(target.content, source.content), "同类偏好合并", 0.64),
          score: 0.64 + similarity * 0.1,
        });
      }
    }
  }

  pairs.sort((left, right) => right.score - left.score);
  const used = new Set<number>();
  for (const proposal of proposals) {
    for (const id of [proposal.targetId, ...proposal.sourceIds]) used.add(id);
  }
  for (const { proposal } of pairs) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const ids = [proposal.targetId, ...proposal.sourceIds];
    if (ids.some((id) => used.has(id))) continue;
    proposals.push(proposal);
    for (const id of ids) used.add(id);
  }
  return proposals.slice(0, MAX_PROPOSALS);
}

function collectCandidates(): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const push = (entry: MemoryEntry, scopeKey: string, scopeLabel: string) => {
    candidates.push({
      id: entry.id,
      scopeKey,
      scopeLabel,
      content: entry.content,
      kind: normalizeMemoryKind(entry.kind),
      status: normalizeMemoryStatus(entry.status),
      explicitRemember: entry.explicitRemember === true,
      facets: normalizeMemoryFacets(entry.facets),
      mentionCount: Math.max(0, Math.round(Number(entry.mentionCount) || 0)),
      updatedAt: entry.updatedAt,
    });
  };
  for (const memory of memoryStore.getGlobalMemories()) push(memory, "global", "全局记忆");
  for (const group of memoryStore.getAllAssistantGroups()) {
    const name = group.assistantName || state.settings.assistants.find((a) => a.id === group.assistantId)?.name || "助手";
    for (const memory of group.memories) push(memory, `assistant:${group.assistantId}`, name);
  }
  return candidates;
}

export interface MergePlanningResult {
  candidates: number;
  proposed: number;
  created: number;
  proposals: MergeProposal[];
}

/** 生成并持久化合并提案。已有同签名审计（含已拒绝）时跳过，避免每次启动刷一屏重复提案。 */
export function runMergePlanning(): MergePlanningResult {
  if (!memoryExperimentFeature("mergeProposals")) {
    return { candidates: 0, proposed: 0, created: 0, proposals: [] };
  }
  const db = openExperimentDb();
  if (!db) return { candidates: 0, proposed: 0, created: 0, proposals: [] };
  const candidates = collectCandidates();
  const planned = planMergeProposals(candidates);
  const existing = new Set(
    (db.query(
      "SELECT idempotency_key FROM pc_memory_audit WHERE action = 'merge_plan' AND idempotency_key IS NOT NULL",
    ).all() as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key),
  );
  let created = 0;
  for (const proposal of planned) {
    if (existing.has(proposal.key)) continue;
    const rec = recordAudit(db, {
      action: "merge_plan",
      status: "proposed",
      idempotencyKey: proposal.key,
      detail: { ...proposal },
    });
    if (rec.inserted) created += 1;
  }
  return { candidates: candidates.length, proposed: planned.length, created, proposals: planned };
}

export function listMergeProposals(status?: MemoryAuditStatus): MergeProposalRecord[] {
  const db = openExperimentDb();
  if (!db) return [];
  return listAudit(db, { action: "merge_plan", limit: 200, ...(status ? { status } : {}) })
    .filter((entry) => typeof entry.detail.op === "string")
    .map((entry) => ({
      ...(entry.detail as unknown as MergeProposal),
      auditId: entry.auditId,
      status: entry.status,
      at: entry.at,
    }));
}
