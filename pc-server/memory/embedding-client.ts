// memory/embedding-client.ts — 记忆索引的嵌入出口（/embeddings，批 64）
// 复用 model-providers/embeddings.ts 的请求构造、鉴权与响应解析；这里只加：
// 分批、429/5xx/网络错误退避重试（1s、4s）、4xx 立即失败、跨批维度一致性、取消。

import { callEmbeddings } from "../model-providers/embeddings";
import type { SceneModelRef } from "./scene-models";

export const EMBEDDING_BATCH_SIZE = 64;
/** 单批 20s（设计 C4.1）；重试在批次之外另计时，整体任务仍可取消。 */
export const EMBEDDING_BATCH_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [1000, 4000];

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/** 4xx（401/403/400…）是配置或凭据问题，重试只会烧额度；429 与 5xx 才退避。 */
export function isRetryableEmbeddingError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("记忆索引已取消");
    err.name = "AbortError";
    throw err;
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("记忆索引已取消");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("记忆索引已取消");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function embedBatchWithRetry(
  ref: SceneModelRef,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      const result = await callEmbeddings(ref.provider, ref.model, texts, {
        signal,
        timeoutMs: EMBEDDING_BATCH_TIMEOUT_MS,
      });
      return result.vectors;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        const abort = new Error("记忆索引已取消");
        abort.name = "AbortError";
        throw abort;
      }
      if (!isRetryableEmbeddingError(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleepWithSignal(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

export interface EmbedTextsResult {
  vectors: number[][];
  dim: number;
}

/** 按 64 条一批嵌入。返回与 texts 同序的向量；跨批维度不一致直接报错（换模型/供应商异常）。 */
export async function embedTextsInBatches(
  ref: SceneModelRef,
  texts: string[],
  options?: {
    signal?: AbortSignal;
    onBatch?: (done: number, total: number) => void;
  },
): Promise<EmbedTextsResult> {
  const vectors: number[][] = [];
  let dim = 0;
  const batches = chunkItems(texts, EMBEDDING_BATCH_SIZE);
  for (const batch of batches) {
    throwIfAborted(options?.signal);
    const batchVectors = await embedBatchWithRetry(ref, batch, options?.signal);
    if (batchVectors.length !== batch.length) {
      throw new Error(`嵌入响应条数不符：请求 ${batch.length} 条，返回 ${batchVectors.length} 条`);
    }
    for (const vector of batchVectors) {
      if (vector.length === 0) throw new Error("嵌入响应中的向量长度为 0");
      if (dim === 0) dim = vector.length;
      else if (vector.length !== dim) {
        throw new Error(`嵌入向量维度不一致（${dim} / ${vector.length}）：供应商返回异常`);
      }
      vectors.push(vector);
    }
    options?.onBatch?.(vectors.length, texts.length);
  }
  return { vectors, dim };
}

/** 查询向量只用一条文本，但走同一出口（与索引共享重试/回调语义）。 */
export async function embedQueryVector(ref: SceneModelRef, text: string, signal?: AbortSignal): Promise<Float32Array> {
  const { vectors, dim } = await embedTextsInBatches(ref, [text], { signal });
  if (dim === 0) throw new Error("查询向量为空");
  return Float32Array.from(vectors[0]);
}
