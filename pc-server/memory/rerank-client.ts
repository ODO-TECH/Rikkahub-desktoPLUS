// memory/rerank-client.ts — 记忆召回的候选重排（/rerank）
// 契约与请求体由 model-providers/embeddings.ts 承载；这里只做「失败保序」的语义包装：
// 调用方拿到 null 就保持本地混合分顺序，绝不因重排失败影响对话。

import { callRerank } from "../model-providers/embeddings";
import type { SceneModelRef } from "./scene-models";

export interface RerankCandidate {
  index: number;
  score: number;
}

/** 返回按相关度降序的下标；任何异常都吞掉并返回 null（设计 C5.4：失败回退本地序）。 */
export async function rerankMemoryCandidates(
  ref: SceneModelRef,
  query: string,
  documents: string[],
  topN: number,
  signal?: AbortSignal,
): Promise<RerankCandidate[] | null> {
  if (documents.length === 0) return null;
  try {
    const result = await callRerank(ref.provider, ref.model, query, documents, {
      signal,
      topN,
      timeoutMs: 15_000,
    });
    return result.results.filter((item) => item.index >= 0 && item.index < documents.length);
  } catch (err) {
    console.warn(`[memory] rerank 失败，保持本地混合分顺序：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
