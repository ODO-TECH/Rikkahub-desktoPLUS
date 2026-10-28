// memory/recall.ts — 会话开场记忆召回（直接联想 + 语义联想 + 关联扩展 + 可选重排）
// 触发时机：会话首次编码前（orchestrator 两条链路 + pi resources 各调一次）。
// 结果冻结在 recall-cache，同会话后续轮次逐字节复用；任何失败都退回全量注入，不阻塞对话。

import type { Assistant, Conversation, MemoryEntry } from "../foundation/types";
import { textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { allMemoriesForRecall, memoriesForAssistant } from "./index";
import { contentHash, loadMemoryVectors, openVectorDb } from "./vector-store";
import { resolveEmbeddingModel, resolveRerankModel } from "./scene-models";
import { embedQueryVector } from "./embedding-client";
import { rerankMemoryCandidates } from "./rerank-client";
import { getRecallSelection, putRecallSelection, recallCacheGeneration } from "./recall-cache";
import type { MemoryVectorSettings } from "../foundation/types/settings/memory-vector-config";

const QUERY_MAX_CHARS = 2000;
const LEX_WEIGHT = 0.45;
const COS_WEIGHT = 0.55;
const NEIGHBOR_SEEDS = 5;
const NEIGHBOR_MIN_COS = 0.78;
const NEIGHBOR_PER_SEED = 2;
const NEIGHBOR_MAX = 10;
const ALWAYS_RECENT = 3;
const ALWAYS_UNINDEXED = 3;
const QUERY_EMBED_TIMEOUT_MS = 8_000;
const RERANK_TIMEOUT_MS = 15_000;

export interface RecallVector {
  vector: Float32Array;
  contentHash: string;
}

export interface RecallScore {
  id: number;
  lex: number;
  cos: number;
  score: number;
  hasVector: boolean;
}

export interface RecallCandidate extends RecallScore {
  content: string;
  updatedAt: number;
}

export interface RecallCandidateInput {
  memories: readonly MemoryEntry[];
  query: string;
  queryVector: Float32Array | null;
  /** 当前模型下已落库的向量，按 memoryId 索引。 */
  vectors: ReadonlyMap<number, RecallVector>;
  settings: MemoryVectorSettings;
}

const CJK_SEQUENCE = /[\u3400-\u9fff]+/g;

/** 空白/标点切词 + 中文 2-gram（单字中文查询保留单字）。 */
export function tokenizeForLex(text: string): string[] {
  const lower = String(text ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const part of lower.split(/[\s\p{P}\p{S}]+/u)) {
    if (part) tokens.add(part);
  }
  for (const sequence of lower.match(CJK_SEQUENCE) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let i = 0; i + 1 < sequence.length; i += 1) tokens.add(sequence.slice(i, i + 2));
  }
  return [...tokens];
}

export function lexicalScore(query: string, content: string): number {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return 0;
  const memory = String(content ?? "").toLowerCase();
  const queryTokens = tokenizeForLex(q);
  if (queryTokens.length === 0) return 0;
  const memoryTokens = new Set(tokenizeForLex(memory));
  let hits = 0;
  for (const token of queryTokens) if (memoryTokens.has(token)) hits += 1;
  const ratio = hits / queryTokens.length;
  const substring = memory.includes(q) ? 1 : 0;
  return Math.min(1, Math.max(0, 0.5 * ratio + 0.5 * substring));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.min(1, Math.max(0, cos));
}

function usableVector(
  memory: { id: number; content: string },
  vectors: ReadonlyMap<number, RecallVector>,
): Float32Array | null {
  const stored = vectors.get(memory.id);
  if (!stored) return null;
  if (stored.contentHash !== contentHash(memory.content)) return null;
  return stored.vector;
}

export function buildRecallCandidates(input: RecallCandidateInput): {
  candidates: RecallCandidate[];
  scored: RecallCandidate[];
} {
  const { memories, query, queryVector, vectors, settings } = input;
  const scored: RecallCandidate[] = memories.map((memory) => {
    const vector = usableVector(memory, vectors);
    const lex = lexicalScore(query, memory.content);
    const cos = queryVector && vector ? cosineSimilarity(queryVector, vector) : 0;
    return {
      id: memory.id,
      lex,
      cos,
      score: LEX_WEIGHT * lex + COS_WEIGHT * cos,
      hasVector: vector != null,
      content: memory.content,
      updatedAt: memory.updatedAt,
    };
  });
  const base = [...scored].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || b.id - a.id);
  const candidateLimit = Math.max(settings.topK, settings.rerankTopN);
  const candidates = base.slice(0, candidateLimit);
  if (!settings.expandNeighbors || candidates.length === 0) return { candidates, scored };

  const chosen = new Set(candidates.map((item) => item.id));
  let expanded = 0;
  for (const seed of base.slice(0, NEIGHBOR_SEEDS)) {
    const seedVector = usableVector(seed, vectors);
    if (!seedVector) continue;
    const neighbors: Array<{ item: RecallCandidate; cos: number }> = [];
    for (const item of scored) {
      // 种子本身可能还没被候选截断选中(topK/rerankTopN 小于 5 的旧配置),
      // 它的自相似度恒为 1,必须跳过,否则会把自己补成自己的邻居。
      if (item.id === seed.id || chosen.has(item.id)) continue;
      const vector = usableVector(item, vectors);
      if (!vector) continue;
      const cos = cosineSimilarity(seedVector, vector);
      if (cos >= NEIGHBOR_MIN_COS) neighbors.push({ item, cos });
    }
    neighbors.sort((a, b) => b.cos - a.cos);
    for (const neighbor of neighbors.slice(0, NEIGHBOR_PER_SEED)) {
      if (expanded >= NEIGHBOR_MAX) break;
      chosen.add(neighbor.item.id);
      candidates.push(neighbor.item);
      expanded += 1;
    }
    if (expanded >= NEIGHBOR_MAX) break;
  }
  return { candidates, scored };
}

/** 应用重排结果并截到 topK；无论分数如何，最近 3 条与最多 3 条从未索引的近期记忆兜底注入。 */
export function finalizeRecall(
  input: RecallCandidateInput,
  candidates: RecallCandidate[],
  rerankResults: Array<{ index: number; score: number }> | null,
): { selectedIds: number[]; reranked: boolean } {
  const { settings } = input;
  let ordered: RecallCandidate[];
  let reranked = false;
  if (rerankResults && rerankResults.length > 0) {
    const picked: RecallCandidate[] = [];
    const seen = new Set<number>();
    for (const result of rerankResults) {
      const item = candidates[result.index];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
      if (picked.length >= settings.topK) break;
    }
    if (picked.length > 0) {
      reranked = true;
      ordered = picked;
      for (const item of [...candidates].sort((a, b) => b.score - a.score)) {
        if (ordered.length >= settings.topK) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        ordered.push(item);
      }
    } else {
      ordered = [...candidates].sort((a, b) => b.score - a.score).slice(0, settings.topK);
    }
  } else {
    ordered = [...candidates].sort((a, b) => b.score - a.score).slice(0, settings.topK);
  }

  const selected = ordered.map((item) => item.id);
  const included = new Set(selected);
  const byRecent = [...input.memories].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const memory of byRecent.slice(0, ALWAYS_RECENT)) {
    if (included.has(memory.id)) continue;
    included.add(memory.id);
    selected.push(memory.id);
  }
  for (const memory of byRecent.filter((item) => !usableVector(item, input.vectors)).slice(0, ALWAYS_UNINDEXED)) {
    if (included.has(memory.id)) continue;
    included.add(memory.id);
    selected.push(memory.id);
  }
  return { selectedIds: selected, reranked };
}

export function firstUserText(conversation: Conversation): string {
  for (const node of conversation.messages ?? []) {
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (!message) continue;
    if (String(message.role ?? "").toUpperCase() !== "USER") continue;
    const text = textFromParts(message.parts).trim();
    if (text) return text.slice(0, QUERY_MAX_CHARS);
  }
  return "";
}

/** 会话首次编码前调用；命中冻结缓存或任何前置条件不满足时立即返回。 */
export async function prepareMemoryRecall(
  conversation: Conversation,
  assistant: Assistant,
): Promise<void> {
  try {
    const settings = state.settings.memoryVectorSettings;
    if (!settings.enabled) return;
    // 实验：语义召回只从 active 池取候选（statusRecall 关闭时与原行为一致）。
    const visible = memoriesForAssistant(assistant, "recall");
    if (visible.length === 0 || visible.length <= settings.minMemories) return;
    const ref = resolveEmbeddingModel();
    if (!ref) return;
    // 代际在任何 await 之前取；期间被「重匹配/清缓存/改设置」打断时，本轮结果不许落缓存。
    const generation = recallCacheGeneration(conversation.id);
    const cached = getRecallSelection(conversation.id);
    if (cached && cached.assistantId === assistant.id && cached.modelKey === ref.modelKey) return;

    const query = firstUserText(conversation);
    if (!query) return;

    const db = openVectorDb();
    const stored = db ? loadMemoryVectors(db, ref.modelKey) : new Map();
    const vectors = new Map<number, RecallVector>();
    for (const [id, row] of stored) vectors.set(id, { vector: row.vector, contentHash: row.contentHash });

    let queryVector: Float32Array | null = null;
    const hasUsableVector = visible.some((memory) => usableVector(memory, vectors) != null);
    if (hasUsableVector) {
      try {
        queryVector = await embedQueryVector(ref, query, AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS));
      } catch (err) {
        // 降级：只用词法分（比全量整包好），本会话冻结该结果。
        console.warn(`[memory] 查询向量失败，本次按词法召回：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const input: RecallCandidateInput = { memories: visible, query, queryVector, vectors, settings };
    const { candidates } = buildRecallCandidates(input);
    const rerankRef = settings.rerankEnabled ? resolveRerankModel() : null;
    const rerankResults = rerankRef && candidates.length > 0
      ? await rerankMemoryCandidates(
          rerankRef,
          query,
          candidates.map((item) => item.content),
          settings.topK,
          AbortSignal.timeout(RERANK_TIMEOUT_MS),
        )
      : null;
    const { selectedIds, reranked } = finalizeRecall(input, candidates, rerankResults);
    putRecallSelection({
      conversationId: conversation.id,
      assistantId: assistant.id,
      selectedIds,
      modelKey: ref.modelKey,
      queryHash: contentHash(query),
      total: visible.length,
      builtAt: Date.now(),
      reranked,
      invalidationGeneration: generation,
    }, generation);
  } catch (err) {
    console.warn(`[memory] 召回失败，退回全量注入：${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface RecallPreviewItem extends RecallScore {
  content: string;
  reranked: boolean;
}

/** 设置页「测试召回」：对全部记忆按同一套混合打分排序；显式用户动作，允许触发一次重排。 */
export async function previewMemoryRecall(query: string, limit: number): Promise<RecallPreviewItem[]> {
  const text = String(query ?? "").trim().slice(0, QUERY_MAX_CHARS);
  if (!text) return [];
  const settings = state.settings.memoryVectorSettings;
  const memories: MemoryEntry[] = allMemoriesForRecall();
  if (memories.length === 0) return [];

  const ref = resolveEmbeddingModel();
  const db = openVectorDb();
  const stored = db && ref ? loadMemoryVectors(db, ref.modelKey) : new Map();
  const vectors = new Map<number, RecallVector>();
  for (const [id, row] of stored) vectors.set(id, { vector: row.vector, contentHash: row.contentHash });

  let queryVector: Float32Array | null = null;
  if (ref && memories.some((memory) => usableVector(memory, vectors) != null)) {
    try {
      queryVector = await embedQueryVector(ref, text, AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS));
    } catch (err) {
      console.warn(`[memory] 预览查询向量失败，按词法打分：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const input: RecallCandidateInput = { memories, query: text, queryVector, vectors, settings };
  const { scored } = buildRecallCandidates({ ...input, settings: { ...settings, expandNeighbors: false } });
  const top = [...scored]
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || b.id - a.id)
    .slice(0, Math.max(1, limit));

  const rerankRef = settings.rerankEnabled ? resolveRerankModel() : null;
  const rerankResults = rerankRef && top.length > 0
    ? await rerankMemoryCandidates(
        rerankRef,
        text,
        top.map((item) => item.content),
        limit,
        AbortSignal.timeout(RERANK_TIMEOUT_MS),
      )
    : null;
  if (!rerankResults || rerankResults.length === 0) {
    return top.map((item) => ({ ...item, reranked: false }));
  }
  const out: RecallPreviewItem[] = [];
  const seen = new Set<number>();
  for (const result of rerankResults) {
    const item = top[result.index];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ ...item, reranked: true });
    if (out.length >= limit) break;
  }
  for (const item of top) {
    if (out.length >= limit) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ ...item, reranked: false });
  }
  return out;
}

export interface RecallInfo {
  enabled: boolean;
  active: boolean;
  selected: number;
  total: number;
  reranked: boolean;
  builtAt: number | null;
}

export function readRecallInfo(conversationId: string, assistant: Assistant): RecallInfo {
  const selection = getRecallSelection(conversationId);
  const settings = state.settings.memoryVectorSettings;
  // 与 buildMemoryPrompt 同一判据：助手/嵌入模型对不上的冻结值不算「已召回」。
  const modelKey = resolveEmbeddingModel()?.modelKey;
  const active = selection != null
    && selection.assistantId === assistant.id
    && modelKey != null
    && selection.modelKey === modelKey;
  return {
    enabled: settings.enabled,
    active,
    selected: active ? selection.selectedIds.length : 0,
    total: memoriesForAssistant(assistant, "recall").length,
    reranked: active ? selection.reranked : false,
    builtAt: active ? selection.builtAt : null,
  };
}
