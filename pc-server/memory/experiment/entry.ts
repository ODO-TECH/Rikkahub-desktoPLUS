// 记忆实验扩展字段的纯函数层：分类、状态、稀疏标签、保护与权重。
// 不读全局状态，便于单测与在 sqlite/记忆仓库两侧复用。
import type { MemoryEntry, MemoryFacets, MemoryKind, MemoryStatus } from "../../foundation/types";

export const MEMORY_KINDS: readonly MemoryKind[] = ["setting", "habit", "event", "unclassified"];
export const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "stale", "superseded", "archived", "tombstone"];

const FACET_TEXT_LIMIT = 200;
const FACET_TAG_LIMIT = 40;
const FACET_TAGS_MAX = 16;

export function normalizeMemoryKind(value: unknown): MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind) ? (value as MemoryKind) : "unclassified";
}

export function normalizeMemoryStatus(value: unknown): MemoryStatus {
  return MEMORY_STATUSES.includes(value as MemoryStatus) ? (value as MemoryStatus) : "active";
}

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.slice(0, limit);
}

/** 稀疏标签：缺项保持缺项；空串视为未提供；tags 去重、去空、限量。 */
export function normalizeMemoryFacets(raw: unknown): MemoryFacets | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const facets: MemoryFacets = {};
  for (const key of ["time", "place", "person", "event"] as const) {
    const text = cleanText(input[key], FACET_TEXT_LIMIT);
    if (text) facets[key] = text;
  }
  if (Array.isArray(input.tags)) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of input.tags) {
      const tag = cleanText(item, FACET_TAG_LIMIT);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= FACET_TAGS_MAX) break;
    }
    if (tags.length > 0) facets.tags = tags;
  }
  // 自由扩展：只保留字符串值，避免与结构化字段冲突的嵌套对象污染存储。
  for (const [key, value] of Object.entries(input)) {
    if (["time", "place", "person", "event", "tags"].includes(key)) continue;
    if (typeof value !== "string") continue;
    const text = cleanText(value, FACET_TEXT_LIMIT);
    if (text) facets[key] = text;
  }
  return Object.keys(facets).length > 0 ? facets : null;
}

export function hasExplicitRemember(entry: Pick<MemoryEntry, "explicitRemember">): boolean {
  return entry.explicitRemember === true;
}

/** 不可遗忘区：设定类、用户明确要求记住的。习惯是第二优先级，可 stale 但不删除。 */
export function isProtectedMemory(entry: Pick<MemoryEntry, "kind" | "explicitRemember">): boolean {
  return normalizeMemoryKind(entry.kind) === "setting" || hasExplicitRemember(entry);
}

/** 是否参与注入/召回：stale 仍可见（只是摘要变粗），其余非 active 状态一律隐藏。 */
export function isVisibleStatus(status: unknown): boolean {
  const normalized = normalizeMemoryStatus(status);
  return normalized === "active" || normalized === "stale";
}

/** 普通语义召回候选池：只有 active 可以参与匹配。stale 是「已变粗但仍可注入」的
 *  中间态，不参与语义相似度竞争；superseded / archived / tombstone 永不召回。 */
export function isRecallableStatus(status: unknown): boolean {
  return normalizeMemoryStatus(status) === "active";
}

/** 历史提问的候选池：active/stale/superseded/archived 都可作为「过去的样子」参考，
 *  只有 tombstone（用户要求彻底忘记）永远不可见。 */
export function isHistoryVisibleStatus(status: unknown): boolean {
  return normalizeMemoryStatus(status) !== "tombstone";
}

/** 是否可被第二轮失真：只有事件类、且未受保护。习惯升到 stale 即停，不继续遗忘。 */
export function isForgettable(entry: Pick<MemoryEntry, "kind" | "explicitRemember" | "status">): boolean {
  return normalizeMemoryKind(entry.kind) === "event"
    && !hasExplicitRemember(entry)
    && normalizeMemoryStatus(entry.status) === "active";
}

/** 热记忆：提及次数达到阈值即受保护，第二轮失真不得降级/删除。
 *  只认原始计数（透明可解释）；mentionScore 是独立的排序信号，不参与保护判定。 */
export function isHotMemory(
  entry: Pick<MemoryEntry, "mentionCount">,
  threshold: number,
): boolean {
  const count = Math.max(0, Math.round(Number(entry.mentionCount) || 0));
  return count >= Math.max(1, Math.round(Number(threshold) || 1));
}

/** 读取归一化 mentionScore（0~1）；旧数据无该键时按 0。 */
export function mentionScoreOf(entry: Pick<MemoryEntry, "mentionScore">): number {
  const score = Number(entry.mentionScore);
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

/** 排序权重：设定 100，显式记住 90，习惯 60，事件 20 + 提及加成。 */
export function memoryWeight(entry: Pick<MemoryEntry, "kind" | "explicitRemember" | "mentionCount">): number {
  const mention = Math.max(0, Number(entry.mentionCount) || 0);
  const base = hasExplicitRemember(entry) ? 90 : (() => {
    switch (normalizeMemoryKind(entry.kind)) {
      case "setting": return 100;
      case "habit": return 60;
      case "event": return 20;
      default: return 50;
    }
  })();
  return base + Math.min(30, mention * 3);
}

/** 给新写入/读出的记忆补齐实验字段；不改变 content 与时间戳。 */
export function withMemoryExperimentDefaults(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    kind: normalizeMemoryKind(entry.kind),
    status: normalizeMemoryStatus(entry.status),
    rawContent: typeof entry.rawContent === "string" && entry.rawContent.trim() ? entry.rawContent : null,
    facets: normalizeMemoryFacets(entry.facets),
    explicitRemember: entry.explicitRemember === true,
    mentionCount: Math.max(0, Math.round(Number(entry.mentionCount) || 0)),
    lastMentionedAt: Number(entry.lastMentionedAt) > 0 ? Number(entry.lastMentionedAt) : null,
    mentionScore: mentionScoreOf(entry),
    generation: Math.max(0, Math.round(Number(entry.generation) || 0)),
    distilledAt: Number(entry.distilledAt) > 0 ? Number(entry.distilledAt) : null,
    purgeAfter: Number(entry.purgeAfter) > 0 ? Number(entry.purgeAfter) : null,
    sourceConversationId: typeof entry.sourceConversationId === "string" && entry.sourceConversationId
      ? entry.sourceConversationId
      : null,
    sourceCutMessageId: typeof entry.sourceCutMessageId === "string" && entry.sourceCutMessageId
      ? entry.sourceCutMessageId
      : null,
  };
}

const KIND_STRENGTH: Record<MemoryKind, number> = {
  unclassified: 0,
  event: 1,
  habit: 2,
  setting: 3,
};

/** 合并去重时分类只升不降：事件被改写进设定/习惯条目后不能退回事件。 */
export function strongerMemoryKind(a: unknown, b: unknown): MemoryKind {
  const left = normalizeMemoryKind(a);
  const right = normalizeMemoryKind(b);
  return KIND_STRENGTH[right] > KIND_STRENGTH[left] ? right : left;
}

/** 合并标签：逐键以新值为准，tags 取并集（保持首次出现顺序，忽略大小写重复）。 */
export function mergeMemoryFacets(base: unknown, incoming: unknown): MemoryFacets | null {
  const left = normalizeMemoryFacets(base);
  const right = normalizeMemoryFacets(incoming);
  if (!left) return right;
  if (!right) return left;
  const merged: MemoryFacets = { ...left, ...right };
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...(left.tags ?? []), ...(right.tags ?? [])]) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > 0) merged.tags = tags;
  else delete merged.tags;
  return merged;
}
