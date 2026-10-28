// memory/dedup.ts — 记忆写入去重（对齐 Kelivo Smart Add 的 NEW / MERGE / SKIP）
// 纪律：只做「判定 + 返回结果」，落库由 memory/write.ts 统一执行。
// 候选检索优先读向量库（余弦近邻），无向量 / 未启用时退回词法；模型未配置或调用失败
// 一律降级为「精确重复跳过，否则新增」，不阻塞写入。

import type { Assistant, MemoryEntry } from "../foundation/types";
import { state } from "../persistence/json-store";
import { fetchAuxiliaryText } from "../conversations/auxiliary";
import { embedQueryVector } from "./embedding-client";
import { memoryStore } from "./index";
import { memoryModelThinkingEnabled, resolveMemoryModel } from "./memory-model";
import { cosineSimilarity, lexicalScore } from "./recall";
import { resolveEmbeddingModel } from "./scene-models";
import { loadMemoryVectors, openVectorDb } from "./vector-store";
import type { MemoryWriteTarget } from "./write-policy";

const CANDIDATE_LIMIT = 8;
const VECTOR_MIN_COS = 0.55;
const MAX_CONTENT_CHARS = 600;

export type DedupAction = "new" | "merge" | "skip";

export interface DedupDecision {
  action: DedupAction;
  targetId?: number;
  mergedContent?: string;
  degraded: boolean;
}

export interface DedupCandidate extends MemoryEntry {
  scope: MemoryWriteTarget;
  score: number;
}

export function normalizeMemoryContent(content: string): string {
  return String(content ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildCandidatePool(assistant: Assistant): DedupCandidate[] {
  const pool: DedupCandidate[] = [];
  if (state.settings.memorySettings.globalEnabled) {
    for (const entry of memoryStore.getGlobalMemories()) {
      pool.push({ ...entry, scope: "global", score: 0 });
    }
  }
  if (assistant.enableMemory) {
    for (const entry of memoryStore.getAssistantMemories(assistant.id)) {
      pool.push({ ...entry, scope: "assistant", score: 0 });
    }
  }
  return pool;
}

/** 词法 + 向量候选合并。向量读取失败不影响写入。 */
export async function retrieveDedupCandidates(
  content: string,
  assistant: Assistant,
  pool = buildCandidatePool(assistant),
): Promise<DedupCandidate[]> {
  if (pool.length === 0) return [];
  for (const item of pool) item.score = lexicalScore(content, item.content);

  const byId = new Map<number, DedupCandidate>();
  for (const item of [...pool].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)) {
    if (item.score <= 0) break;
    byId.set(item.id, item);
    if (byId.size >= CANDIDATE_LIMIT) break;
  }

  if (state.settings.memoryVectorSettings.enabled) {
    const embedding = resolveEmbeddingModel();
    const db = embedding ? openVectorDb() : null;
    if (embedding && db) {
      try {
        const vectors = loadMemoryVectors(db, embedding.modelKey);
        if (vectors.size > 0) {
          const query = await embedQueryVector(embedding, content);
          const scored = pool
            .map((item) => {
              const vector = vectors.get(item.id)?.vector;
              return { item, cos: vector ? cosineSimilarity(query, vector) : 0 };
            })
            .filter((row) => row.cos >= VECTOR_MIN_COS)
            .sort((a, b) => b.cos - a.cos)
            .slice(0, CANDIDATE_LIMIT);
          for (const row of scored) {
            const existing = byId.get(row.item.id);
            if (existing) existing.score = Math.max(existing.score, row.cos);
            else byId.set(row.item.id, { ...row.item, score: row.cos });
          }
        }
      } catch (err) {
        console.warn("[memory] 去重向量候选检索失败，退回词法:", err);
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, CANDIDATE_LIMIT);
}

function extractJson(text: string): unknown {
  let body = String(text ?? "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(content: string, scope: MemoryWriteTarget, candidates: DedupCandidate[]): string {
  const entries = candidates.map((item) => ({
    id: item.id,
    scope: item.scope,
    content: item.content.slice(0, MAX_CONTENT_CHARS),
  }));
  return `你是记忆库的去重器。判断新记忆与候选记忆的关系，只输出 JSON。

新记忆（目标层：${scope === "global" ? "全局" : "本助手"}）：
${content.slice(0, MAX_CONTENT_CHARS)}

候选记忆（id 全局唯一）：
${JSON.stringify(entries, null, 2)}

输出格式：
{"action":"NEW|MERGE|SKIP","targetId":number|null,"mergedContent":string|null}

规则：
1. 完全重复或语义等价 → SKIP，targetId 填最接近的候选 id。
2. 同一主题可合并为更完整的一条 → MERGE，targetId 必须来自候选且 scope 与新记忆相同，mergedContent 写合并后的完整内容（保留双方关键事实）。
3. 新事实或候选无关 → NEW，targetId 为 null。
4. 不得改写不同层（scope 不同）的记忆。
5. 不要输出 JSON 之外的任何文字。`;
}

/** 判定一条待写入记忆。目标层相同的候选才允许 MERGE；跨层只能 SKIP/NEW。 */
export async function decideMemoryWrite(input: {
  content: string;
  targetScope: MemoryWriteTarget;
  assistant: Assistant;
  conversationId?: string;
}): Promise<DedupDecision> {
  const content = String(input.content ?? "").trim();
  const normalized = normalizeMemoryContent(content);
  if (!normalized) return { action: "new", degraded: false };

  // 免费路径先行：精确重复直接跳过，不触发嵌入 / 去重模型（对齐 Kelivo exact-dup fast path）。
  const pool = buildCandidatePool(input.assistant);
  const exact = pool.find((item) => normalizeMemoryContent(item.content) === normalized);
  if (exact) return { action: "skip", targetId: exact.id, degraded: false };
  if (pool.length === 0) return { action: "new", degraded: false };

  if (!state.settings.memorySettings.dedupEnabled) return { action: "new", degraded: false };
  const model = resolveMemoryModel();
  if (!model) return { action: "new", degraded: true };

  const candidates = await retrieveDedupCandidates(content, input.assistant, pool);
  if (candidates.length === 0) return { action: "new", degraded: false };

  let raw = "";
  try {
    raw = await fetchAuxiliaryText(model.model.id, buildPrompt(content, input.targetScope, candidates), "memory-dedup", {
      maxTokens: 1500,
      conversationId: input.conversationId,
      reasoningLevel: memoryModelThinkingEnabled() ? "AUTO" : undefined,
    });
  } catch (err) {
    console.warn("[memory] 去重模型调用失败，按新增处理:", err);
    return { action: "new", degraded: true };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { action: "new", degraded: true };
  }
  const record = parsed as Record<string, unknown>;
  const action = String(record.action ?? "").toUpperCase();
  const targetId = Number(record.targetId);
  const target = Number.isInteger(targetId) && targetId > 0
    ? candidates.find((item) => item.id === targetId)
    : undefined;

  if (action === "SKIP") {
    return target ? { action: "skip", targetId: target.id, degraded: false } : { action: "new", degraded: true };
  }
  if (action === "MERGE") {
    const merged = String(record.mergedContent ?? "").trim();
    if (!target || target.scope !== input.targetScope || !merged) {
      return { action: "new", degraded: true };
    }
    return { action: "merge", targetId: target.id, mergedContent: merged, degraded: false };
  }
  if (action === "NEW") return { action: "new", degraded: false };
  return { action: "new", degraded: true };
}
