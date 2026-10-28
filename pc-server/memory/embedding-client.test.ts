// memory/embedding-client.test.ts — 特性 C 嵌入出口的分批、重试、维度一致性与取消。
// 纪律：4xx 立即失败不烧额度；429/5xx/网络错误退避两次；任何异常都可被 AbortSignal 打断。
// 这里用「闸门委托」桩替换 callEmbeddings：默认委托真实实现，只有测试设置行为时才拦截，
// 避免 bun mock.module 跨文件残留影响其他用例。
import { afterAll, describe, expect, mock, test } from "bun:test";

import * as actualEmbeddings from "../model-providers/embeddings";
import type { SceneModelRef } from "./scene-models";

type EmbedOverride = (texts: string[], opts?: { signal?: AbortSignal }) => Promise<number[][]>;
let override: EmbedOverride | null = null;
let calls: string[][] = [];

// mock.module 替换注册表后命名空间会指向桩自身(委托即自我递归);必须先捕获真实函数。
const realCallEmbeddings = actualEmbeddings.callEmbeddings;

mock.module("../model-providers/embeddings", () => ({
  ...actualEmbeddings,
  callEmbeddings: async (
    provider: Parameters<typeof realCallEmbeddings>[0],
    model: Parameters<typeof realCallEmbeddings>[1],
    texts: string[],
    opts?: Parameters<typeof realCallEmbeddings>[3],
  ) => {
    if (!override) return realCallEmbeddings(provider, model, texts, opts);
    calls.push(texts);
    const vectors = await override(texts, opts);
    return { vectors, dim: vectors[0]?.length ?? 0, usage: {} };
  },
}));

const {
  EMBEDDING_BATCH_SIZE,
  chunkItems,
  embedQueryVector,
  embedTextsInBatches,
  isRetryableEmbeddingError,
  throwIfAborted,
} = await import("./embedding-client");

const ref = {
  provider: { id: "p1", name: "Mock", type: "openai", baseUrl: "http://127.0.0.1:1/v1", models: [] },
  model: { id: "m1", modelId: "mock-embed", type: "EMBEDDING" },
  modelKey: "p1::mock-embed",
  displayName: "Mock Embed",
} as unknown as SceneModelRef;

function setOverride(fn: EmbedOverride | null): void {
  override = fn;
  calls = [];
}

function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

afterAll(() => {
  setOverride(null);
});

describe("分批", () => {
  test("chunkItems 按大小切分,非法大小至少为 1", () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkItems([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkItems([], 64)).toEqual([]);
  });

  test("130 条按 64/64/2 三批,进度回调累进", async () => {
    setOverride(async (texts) => texts.map((_, i) => [i, 1, 0]));
    const progress: Array<[number, number]> = [];
    const texts = Array.from({ length: 130 }, (_, i) => `t${i}`);
    const result = await embedTextsInBatches(ref, texts, {
      onBatch: (done, total) => progress.push([done, total]),
    });

    expect(EMBEDDING_BATCH_SIZE).toBe(64);
    expect(calls.map((batch) => batch.length)).toEqual([64, 64, 2]);
    expect(result.vectors).toHaveLength(130);
    expect(result.dim).toBe(3);
    expect(progress).toEqual([
      [64, 130],
      [128, 130],
      [130, 130],
    ]);
  });

  test("空输入不发请求", async () => {
    setOverride(async () => {
      throw new Error("不应调用");
    });
    const result = await embedTextsInBatches(ref, []);
    expect(result).toEqual({ vectors: [], dim: 0 });
    expect(calls).toEqual([]);
  });
});

describe("错误与重试策略", () => {
  test("只有 429、5xx 与网络错误可重试;4xx 直接失败", () => {
    expect(isRetryableEmbeddingError(httpError(429))).toBe(true);
    expect(isRetryableEmbeddingError(httpError(500))).toBe(true);
    expect(isRetryableEmbeddingError(httpError(503))).toBe(true);
    expect(isRetryableEmbeddingError(httpError(400))).toBe(false);
    expect(isRetryableEmbeddingError(httpError(401))).toBe(false);
    expect(isRetryableEmbeddingError(httpError(404))).toBe(false);
    expect(isRetryableEmbeddingError(new Error("socket closed"))).toBe(true);
  });

  test("4xx 立即失败,不进入退避", async () => {
    setOverride(async () => {
      throw httpError(401);
    });
    const started = Date.now();
    await expect(embedTextsInBatches(ref, ["a"])).rejects.toThrow("HTTP 401");
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("429 退避后重试成功(1s)", async () => {
    let attempt = 0;
    setOverride(async () => {
      attempt += 1;
      if (attempt === 1) throw httpError(429);
      return [[1, 2]];
    });
    const started = Date.now();
    const result = await embedTextsInBatches(ref, ["a"]);
    expect(result.dim).toBe(2);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test("退避期间取消立即抛 AbortError,不等满 1s", async () => {
    setOverride(async () => {
      throw httpError(503);
    });
    const controller = new AbortController();
    const run = embedTextsInBatches(ref, ["a"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "记忆索引已取消" });
    expect(Date.now() - started).toBeLessThan(900);
    expect(calls).toHaveLength(1);
  });

  test("调用前已取消:一个请求都不发", async () => {
    setOverride(async () => [[1]]);
    const controller = new AbortController();
    controller.abort();
    await expect(embedTextsInBatches(ref, ["a"], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toEqual([]);
  });
});

describe("响应校验", () => {
  test("返回条数不符直接报错", async () => {
    setOverride(async () => [[1], [2]]);
    await expect(embedTextsInBatches(ref, ["a", "b", "c"])).rejects.toThrow("嵌入响应条数不符");
  });

  test("跨批维度不一致直接报错(换模型/供应商异常)", async () => {
    setOverride(async (texts) => texts.map(() => (texts.length > 32 ? [1, 2, 3] : [1, 2])));
    const texts = Array.from({ length: 65 }, (_, i) => `t${i}`);
    await expect(embedTextsInBatches(ref, texts)).rejects.toThrow("维度不一致");
  });

  test("向量长度为 0 直接报错", async () => {
    setOverride(async () => [[]]);
    await expect(embedTextsInBatches(ref, ["a"])).rejects.toThrow("向量长度为 0");
  });
});

describe("查询向量", () => {
  test("单条文本走同一出口,返回 Float32Array", async () => {
    setOverride(async (texts) => texts.map(() => [0.25, 0.5]));
    const vector = await embedQueryVector(ref, "查询");
    expect(vector).toBeInstanceOf(Float32Array);
    expect([...vector]).toEqual([0.25, 0.5]);
    expect(calls).toEqual([["查询"]]);
  });
});

describe("throwIfAborted", () => {
  test("未取消静默通过,已取消抛 AbortError", () => {
    expect(() => throwIfAborted()).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow("记忆索引已取消");
  });
});
