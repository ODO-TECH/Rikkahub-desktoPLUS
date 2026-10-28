// memory/recall.test.ts — 特性 C 召回的纯逻辑锁：词法/余弦/混合分、候选截断、邻域扩展、
// 重排收尾与固定兜底；以及「功能关闭时记忆提示词逐字节不变」的回归锁。
// 纪律：任何网络/索引失败都退回全量注入；这些测试零真实请求。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Assistant, Conversation, MemoryEntry } from "../foundation/types";
import type { MemoryVectorSettings } from "../foundation/types/settings/memory-vector-config";
import type { RecallCandidateInput, RecallVector } from "./recall";
import type { RecallSelection } from "./recall-cache";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-recall-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const {
  buildRecallCandidates,
  cosineSimilarity,
  finalizeRecall,
  firstUserText,
  lexicalScore,
  prepareMemoryRecall,
  readRecallInfo,
  tokenizeForLex,
} = await import("./recall");
const {
  clearConversationRecall,
  clearRecallCache,
  getRecallSelection,
  putRecallSelection,
  recallCacheGeneration,
} = await import("./recall-cache");
// state 是活绑定,必须保留命名空间读取;解构会拿到 import 时的 undefined 快照。
const store = await import("../persistence/json-store");
const { buildMemoryPrompt, memoryStore, allMemoriesForRecall } = await import("./index");
const { contentHash } = await import("./vector-store");

const DEFAULT_SETTINGS: MemoryVectorSettings = {
  enabled: false,
  autoIndex: true,
  topK: 20,
  minMemories: 24,
  expandNeighbors: true,
  rerankEnabled: true,
  rerankTopN: 40,
};

function settings(patch: Partial<MemoryVectorSettings> = {}): MemoryVectorSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

const MOCK_EMBEDDING_MODEL = { id: "emb", modelId: "emb", displayName: "Emb", type: "EMBEDDING" };
const MOCK_RERANK_MODEL = { id: "rr", modelId: "rr", displayName: "Rerank", type: "RERANK" };

/** 与 asr-mimo 同款最小供应商形状：openai 兼容 + apiKey 轨，不触任何外部网络。 */
function mockProvider(baseUrl = "http://127.0.0.1:9/v1") {
  return {
    id: "p",
    type: "openai",
    enabled: true,
    name: "Mock",
    builtIn: false,
    shortDescription: "",
    description: "",
    apiKey: "sk-test",
    baseUrl,
    models: [MOCK_EMBEDDING_MODEL, MOCK_RERANK_MODEL],
    balanceOption: { enabled: false, apiPath: "", resultPath: "" },
  };
}

function mockSettings(patch: Partial<MemoryVectorSettings> = {}) {
  return {
    assistants: [],
    providers: [mockProvider()],
    embeddingModelId: "emb",
    rerankModelId: "rr",
    memorySettings: { globalEnabled: true, writeStrategy: "ask" },
    memoryVectorSettings: settings(patch),
  };
}

function applyMockSettings(patch: Partial<MemoryVectorSettings> = {}): void {
  store.setState({ settings: mockSettings(patch) } as unknown as typeof store.state);
}

function memory(id: number, content: string, updatedAt = id): MemoryEntry {
  return { id, content, createdAt: updatedAt, updatedAt, source: "manual" };
}

function vectorsOf(...items: Array<[MemoryEntry, number[]]>): Map<number, RecallVector> {
  return new Map(
    items.map(([entry, vector]) => [
      entry.id,
      { vector: Float32Array.from(vector), contentHash: contentHash(entry.content) },
    ]),
  );
}

function inputOf(
  memories: MemoryEntry[],
  query: string,
  queryVector: number[] | null,
  vectors: Map<number, RecallVector>,
  patch: Partial<MemoryVectorSettings> = {},
): RecallCandidateInput {
  return {
    memories,
    query,
    queryVector: queryVector ? Float32Array.from(queryVector) : null,
    vectors,
    settings: settings(patch),
  };
}

afterAll(() => {
  clearRecallCache();
  try {
    memoryStore.clearAll();
  } catch { /* 库未初始化时无副作用 */ }
});

describe("切词与词法分", () => {
  test("英文按空白/标点切、统一小写;中文补 2-gram", () => {
    expect(tokenizeForLex("Hello, WORLD!").sort()).toEqual(["hello", "world"]);
    const cjk = tokenizeForLex("我喜欢旅行");
    expect(cjk).toContain("旅行");
    expect(cjk).toContain("喜欢");
    expect(cjk).not.toContain("我");
    expect(tokenizeForLex("旅")).toEqual(["旅"]);
  });

  test("整段包含得满分,乱序词命中得半分,无交集为零", () => {
    expect(lexicalScore("旅行", "我喜欢旅行")).toBe(1);
    expect(lexicalScore("python 常用", "常用 Python")).toBe(0.5);
    expect(lexicalScore("旅行", "今天天气不错")).toBe(0);
    expect(lexicalScore("", "任意")).toBe(0);
  });
});

describe("余弦相似度", () => {
  test("同向为 1、正交为 0、反向夹到 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([-1, 0], [1, 0])).toBe(0);
  });

  test("零向量/长度不一致返回 0,不抛错", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("混合分与候选截断", () => {
  test("词法 0.45 + 余弦 0.55;内容变过的旧向量不参与打分", () => {
    const a = memory(1, "alpha project notes", 100);
    const b = memory(2, "gamma unrelated", 90);
    const stale = memory(3, "alpha project old", 80);
    const vectors = vectorsOf([a, [1, 0, 0]], [b, [0.9, 0.1, 0]], [stale, [1, 0, 0]]);
    // 手动篡改 stale 的 hash,模拟记忆内容已编辑。
    vectors.get(3)!.contentHash = contentHash("旧内容");
    const { scored } = buildRecallCandidates(inputOf([a, b, stale], "alpha project", [1, 0, 0], vectors));

    const byId = new Map(scored.map((item) => [item.id, item]));
    expect(byId.get(1)!.lex).toBe(1);
    expect(byId.get(1)!.cos).toBeCloseTo(1);
    expect(byId.get(1)!.score).toBeCloseTo(0.45 + 0.55);
    expect(byId.get(2)!.lex).toBe(0);
    expect(byId.get(2)!.cos).toBeCloseTo(0.9939, 3);
    expect(byId.get(2)!.score).toBeCloseTo(0.55 * 0.9939, 3);
    expect(byId.get(2)!.hasVector).toBe(true);
    expect(byId.get(3)!.hasVector).toBe(false);
    expect(byId.get(3)!.cos).toBe(0);
  });

  test("候选按 max(topK, rerankTopN) 截断", () => {
    const memories = Array.from({ length: 10 }, (_, i) => memory(i + 1, `记忆 ${i + 1}`, 100 - i));
    const { candidates } = buildRecallCandidates(
      inputOf(memories, "记忆", null, new Map(), { topK: 2, rerankTopN: 5, expandNeighbors: false }),
    );
    expect(candidates).toHaveLength(5);
  });

  test("无查询向量时纯按词法(不再算余弦)", () => {
    const a = memory(1, "alpha project", 100);
    const { scored } = buildRecallCandidates(
      inputOf([a], "alpha", null, vectorsOf([a, [1, 0]]), { expandNeighbors: false }),
    );
    expect(scored[0].cos).toBe(0);
    expect(scored[0].score).toBeCloseTo(0.45);
  });
});

describe("邻域扩展", () => {
  test("扩展只补未入选的高相似记忆,不重复", () => {
    const a = memory(1, "needle", 100);
    const unrelated = memory(2, "haystack", 90);
    const related = memory(3, "semantically close", 80);
    const vectors = vectorsOf([a, [1, 0]], [unrelated, [0, 1]], [related, [0.99, 0.141]]);
    const { candidates } = buildRecallCandidates(
      inputOf([a, unrelated, related], "needle", [1, 0], vectors, { topK: 1, rerankTopN: 1 }),
    );
    expect(candidates.map((item) => item.id)).toEqual([1, 3]);
    expect(new Set(candidates.map((item) => item.id)).size).toBe(candidates.length);
  });

  test("关闭扩展时只保留候选截断结果", () => {
    const a = memory(1, "needle", 100);
    const related = memory(2, "semantically close", 90);
    const vectors = vectorsOf([a, [1, 0]], [related, [1, 0]]);
    const { candidates } = buildRecallCandidates(
      inputOf([a, related], "needle", [1, 0], vectors, {
        topK: 1,
        rerankTopN: 1,
        expandNeighbors: false,
      }),
    );
    expect(candidates.map((item) => item.id)).toEqual([1]);
  });

  test("扩展最多补 10 条", () => {
    const memories = Array.from({ length: 13 }, (_, i) => memory(i + 1, `条目 ${i + 1}`, 100 - i));
    const vectors = vectorsOf(...memories.map((item): [MemoryEntry, number[]] => [item, [1, 0]]));
    const { candidates } = buildRecallCandidates(
      inputOf(memories, "条目", [1, 0], vectors, { topK: 1, rerankTopN: 1, expandNeighbors: true }),
    );
    expect(candidates.length).toBe(1 + 10);
  });
});

describe("finalizeRecall", () => {
  test("无重排时按本地分截 topK,再补最近 3 条与未索引近期记忆(去重)", () => {
    const m1 = memory(1, "alpha", 10);
    const m2 = memory(2, "beta", 20);
    const m3 = memory(3, "gamma", 30);
    const m4 = memory(4, "delta", 40);
    const m5 = memory(5, "epsilon", 50);
    const vectors = vectorsOf([m2, [1, 0]], [m3, [1, 0]], [m4, [1, 0]], [m5, [1, 0]]);
    const input = inputOf([m1, m2, m3, m4, m5], "alpha", [1, 0], vectors, {
      topK: 2,
      rerankTopN: 2,
      expandNeighbors: false,
    });
    // 手动构造分数顺序:m5 > m4 > m1 > m2 > m3(与 updatedAt 无关)。
    const ordered = [
      { ...input.memories[4], lex: 1, cos: 1, score: 1, hasVector: true },
      { ...input.memories[3], lex: 1, cos: 1, score: 0.9, hasVector: true },
      { ...input.memories[0], lex: 1, cos: 0, score: 0.8, hasVector: false },
      { ...input.memories[1], lex: 1, cos: 0, score: 0.7, hasVector: true },
      { ...input.memories[2], lex: 1, cos: 0, score: 0.6, hasVector: true },
    ];
    const { selectedIds, reranked } = finalizeRecall(input, ordered, null);
    // topK 2 → [5,4];最近 3 条 [5,4,3] 只补 3;未索引近期中 m1 不在最近 3 → 补 1。
    expect(selectedIds).toEqual([5, 4, 3, 1]);
    expect(reranked).toBe(false);
  });

  test("重排结果决定顺序并标记 reranked", () => {
    const a = memory(1, "alpha", 10);
    const b = memory(2, "beta", 20);
    const vectors = vectorsOf([a, [1, 0]], [b, [0, 1]]);
    const input = inputOf([a, b], "alpha", [1, 0], vectors, { topK: 2, rerankTopN: 2 });
    const candidates = buildRecallCandidates(input).candidates;
    const { selectedIds, reranked } = finalizeRecall(input, candidates, [
      { index: 1, score: 0.99 },
      { index: 0, score: 0.5 },
    ]);
    expect(selectedIds).toEqual([b.id, a.id]);
    expect(reranked).toBe(true);
  });

  test("重排返回空时保持本地顺序,不标记 reranked", () => {
    const a = memory(1, "alpha", 10);
    const b = memory(2, "beta", 20);
    const input = inputOf([a, b], "alpha", null, new Map(), { topK: 2, rerankTopN: 2 });
    const candidates = buildRecallCandidates(input).candidates;
    const { selectedIds, reranked } = finalizeRecall(input, candidates, []);
    expect(reranked).toBe(false);
    expect(selectedIds.slice(0, 2)).toEqual(
      [...candidates].sort((x, y) => y.score - x.score).slice(0, 2).map((item) => item.id),
    );
  });
});

describe("firstUserText", () => {
  function conversation(messages: unknown[], selectIndex = 0): Conversation {
    return { id: "c1", messages } as unknown as Conversation;
  }

  test("跳过助手消息,取首条用户文本并去空白", () => {
    const conv = conversation([
      { id: "n1", selectIndex: 0, messages: [{ role: "ASSISTANT", parts: [{ type: "text", text: "你好" }] }] },
      { id: "n2", selectIndex: 0, messages: [{ role: "USER", parts: [{ type: "text", text: "  第一问  " }] }] },
    ]);
    expect(firstUserText(conv)).toBe("第一问");
  });

  test("尊重分支 selectIndex;超过 2000 字截断", () => {
    const longText = "长".repeat(2500);
    const conv = conversation(
      [
        {
          id: "n1",
          selectIndex: 1,
          messages: [
            { role: "USER", parts: [{ type: "text", text: "旧分支" }] },
            { role: "USER", parts: [{ type: "text", text: longText }] },
          ],
        },
      ],
      1,
    );
    expect(firstUserText(conv)).toHaveLength(2000);
  });

  test("没有用户消息返回空串", () => {
    expect(firstUserText(conversation([]))).toBe("");
  });
});

describe("召回选择的冻结缓存", () => {
  function selection(conversationId: string): RecallSelection {
    return {
      conversationId,
      assistantId: "a1",
      selectedIds: [1],
      modelKey: "p::m",
      queryHash: "h",
      total: 1,
      builtAt: 1,
      reranked: false,
      invalidationGeneration: recallCacheGeneration(conversationId),
    };
  }

  test("超过 200 条淘汰最旧;读取会触活", () => {
    clearRecallCache();
    for (let i = 0; i < 200; i += 1) putRecallSelection(selection(`c-${i}`));
    getRecallSelection("c-0");
    putRecallSelection(selection("c-new"));
    expect(getRecallSelection("c-1")).toBeNull();
    expect(getRecallSelection("c-0")).not.toBeNull();
  });

  test("按会话清理与整体清理", () => {
    clearRecallCache();
    putRecallSelection(selection("c-a"));
    putRecallSelection(selection("c-b"));
    expect(clearConversationRecall("c-a")).toBe(true);
    expect(clearConversationRecall("c-a")).toBe(false);
    expect(getRecallSelection("c-b")).not.toBeNull();
    clearRecallCache();
    expect(getRecallSelection("c-b")).toBeNull();
  });

  test("失效后旧代际的异步结果写不回来,读侧也不认", () => {
    clearRecallCache();
    const generation = recallCacheGeneration("c-stale");
    expect(putRecallSelection(selection("c-stale"), generation)).toBe(true);

    clearConversationRecall("c-stale");
    expect(putRecallSelection(selection("c-stale"), generation)).toBe(false);
    expect(getRecallSelection("c-stale")).toBeNull();

    // 绕过写入闸门硬塞的旧代际条目,读取时同样作废。
    const stale = { ...selection("c-stale"), invalidationGeneration: generation };
    putRecallSelection(stale);
    expect(getRecallSelection("c-stale")).toBeNull();

    // 全局清空会推进所有会话的代际。
    const otherGeneration = recallCacheGeneration("c-other");
    clearRecallCache();
    expect(putRecallSelection(selection("c-other"), otherGeneration)).toBe(false);
  });
});

describe("记忆提示词:关闭特性时逐字节不变", () => {
  const assistant = { id: "a1", enableMemory: false, enableRecentChatsReference: false } as Assistant;

  function putSelection(conversationId: string, overrides: Partial<RecallSelection> = {}): void {
    clearConversationRecall(conversationId);
    putRecallSelection({
      conversationId,
      assistantId: assistant.id,
      selectedIds: memoryStore.getGlobalMemories().map((item) => item.id),
      modelKey: "p::emb",
      queryHash: "h",
      total: memoryStore.getGlobalMemories().length,
      builtAt: 1,
      reranked: false,
      invalidationGeneration: recallCacheGeneration(conversationId),
      ...overrides,
    });
  }

  test("关闭 / 开启但尚无召回选择时输出一致;有选择时只注入选中项", () => {
    applyMockSettings({ enabled: false });
    memoryStore.clearAll();
    memoryStore.addMemory({ scope: "global", content: "喜欢简洁回复", source: "manual" }, false);
    memoryStore.addMemory({ scope: "global", content: "常用 TypeScript", source: "manual" }, false);
    memoryStore.addMemory({ scope: "global", content: "住在杭州", source: "manual" }, false);

    const baseline = buildMemoryPrompt(assistant, "conv-off");
    expect(baseline).toContain("Memories");
    expect(baseline).not.toContain("Ordered by relevance");

    (store.state.settings as { memoryVectorSettings: MemoryVectorSettings }).memoryVectorSettings = settings({ enabled: true });
    expect(buildMemoryPrompt(assistant, "conv-on")).toBe(baseline);

    const ids = memoryStore.getGlobalMemories().map((item) => item.id);
    putSelection("conv-on", { selectedIds: [ids[2], ids[0], 99999] });
    const recalled = buildMemoryPrompt(assistant, "conv-on");
    expect(recalled).toContain("Ordered by relevance");
    expect(recalled).toContain("住在杭州");
    expect(recalled).toContain("喜欢简洁回复");
    expect(recalled).not.toContain("常用 TypeScript");
    // 选中顺序即注入顺序;不存在的 id 被丢弃而不是报错。
    expect(recalled.indexOf("住在杭州")).toBeLessThan(recalled.indexOf("喜欢简洁回复"));

    clearConversationRecall("conv-on");
    expect(buildMemoryPrompt(assistant, "conv-on")).toBe(baseline);
  });

  test("助手、嵌入模型或代际对不上的选择不注入", () => {
    applyMockSettings({ enabled: true });
    memoryStore.clearAll();
    memoryStore.addMemory({ scope: "global", content: "记住甲", source: "manual" }, false);
    memoryStore.addMemory({ scope: "global", content: "记住乙", source: "manual" }, false);
    const baseline = buildMemoryPrompt(assistant, "conv-identity");

    putSelection("conv-identity");
    expect(buildMemoryPrompt(assistant, "conv-identity")).toContain("Ordered by relevance");
    expect(readRecallInfo("conv-identity", assistant).active).toBe(true);

    putSelection("conv-identity", { assistantId: "other-assistant" });
    expect(buildMemoryPrompt(assistant, "conv-identity")).toBe(baseline);
    expect(readRecallInfo("conv-identity", assistant).active).toBe(false);

    putSelection("conv-identity", { modelKey: "p::other-model" });
    expect(buildMemoryPrompt(assistant, "conv-identity")).toBe(baseline);

    putSelection("conv-identity", { invalidationGeneration: "stale-generation" });
    expect(buildMemoryPrompt(assistant, "conv-identity")).toBe(baseline);
    expect(readRecallInfo("conv-identity", assistant).active).toBe(false);
  });
});

describe("实验状态感知召回", () => {
  const assistant = { id: "a-status", enableMemory: false, enableRecentChatsReference: false } as Assistant;

  function setStatusRecall(enabled: boolean): void {
    (store.state.settings as unknown as { memoryExperimentSettings: Record<string, unknown> })
      .memoryExperimentSettings = { enabled, statusRecall: enabled };
  }

  test("注入面排除取代/归档/墓碑并保留 stale；召回池只收 active", () => {
    applyMockSettings();
    memoryStore.clearAll();
    const active = memoryStore.addMemory({ scope: "global", content: "现在喜欢帕秋莉", source: "manual" }, false);
    const stale = memoryStore.addMemory({ scope: "global", content: "每周三打球（摘要变粗）", source: "manual" }, false);
    const superseded = memoryStore.addMemory({ scope: "global", content: "以前喜欢蕾米莉亚", source: "manual" }, false);
    const archived = memoryStore.addMemory({ scope: "global", content: "已归档的旧安排", source: "manual" }, false);
    const tombstone = memoryStore.addMemory({ scope: "global", content: "已完成的提醒", source: "manual" }, false);
    memoryStore.setMemoryStatuses([
      { id: stale.id, status: "stale" },
      { id: superseded.id, status: "superseded" },
      { id: archived.id, status: "archived" },
      { id: tombstone.id, status: "tombstone" },
    ], false);

    // 实验关闭：状态不参与过滤（与旧实现一致）。唯一例外是 S14 墓碑——正文已被
    // 清除的条目任何时候都不再注入；旧数据没有 tombstone 状态，行为仍逐字节一致。
    setStatusRecall(false);
    const baseline = buildMemoryPrompt(assistant, "conv-status-off");
    for (const entry of [active, stale, superseded, archived]) {
      expect(baseline).toContain(entry.content);
    }
    expect(baseline).not.toContain(tombstone.content);
    expect(allMemoriesForRecall().map((entry) => entry.id)).not.toContain(tombstone.id);

    setStatusRecall(true);
    const visible = buildMemoryPrompt(assistant, "conv-status-on");
    expect(visible).toContain(active.content);
    expect(visible).toContain(stale.content);
    expect(visible).not.toContain(superseded.content);
    expect(visible).not.toContain(archived.content);
    expect(visible).not.toContain(tombstone.content);

    // 语义召回池只看 active：stale 可注入但不参与相似度竞争。
    expect(allMemoriesForRecall().map((entry) => entry.id)).toEqual([active.id]);

    setStatusRecall(false);
    expect(buildMemoryPrompt(assistant, "conv-status-off")).toBe(baseline);
  });
});

describe("prepareMemoryRecall 的代际闸门", () => {
  test("等待重排期间被失效,旧结果不写回", async () => {
    let holdNext = false;
    let notifyStarted: (() => void) | null = null;
    let release!: () => void;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/rerank")) {
          return new Response("not found", { status: 404 });
        }
        if (holdNext) {
          await new Promise<void>((resolve) => {
            release = resolve;
            notifyStarted?.();
          });
        }
        return Response.json({ results: [{ index: 0, relevance_score: 0.9 }] });
      },
    });
    try {
      store.setState({
        settings: {
          ...mockSettings({ enabled: true, minMemories: 0, topK: 2, rerankTopN: 2, expandNeighbors: false }),
          providers: [mockProvider(`http://127.0.0.1:${server.port}/v1`)],
        },
        stats: { totalRequests: 0, failedRequests: 0, byProvider: {}, byGroup: {} },
        logs: [],
      } as unknown as typeof store.state);
      memoryStore.clearAll();
      memoryStore.addMemory({ scope: "global", content: "alpha project notes", source: "manual" }, false);
      memoryStore.addMemory({ scope: "global", content: "unrelated weather", source: "manual" }, false);

      const assistant = { id: "a1", enableMemory: true, enableRecentChatsReference: false } as Assistant;
      const conversation = {
        id: "conv-race",
        messages: [{
          id: "n1",
          selectIndex: 0,
          messages: [{ role: "USER", parts: [{ type: "text", text: "alpha" }] }],
        }],
      } as unknown as Conversation;

      await prepareMemoryRecall(conversation, assistant);
      expect(getRecallSelection("conv-race")?.reranked).toBe(true);

      clearConversationRecall("conv-race");
      holdNext = true;
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      const pending = prepareMemoryRecall(conversation, assistant);
      await started;
      // 等待期间用户点了「重新匹配」：新代际的召回先行完成并落缓存，
      // 随后旧请求才返回——旧结果不得覆盖新结果。
      clearConversationRecall("conv-race");
      const freshGeneration = recallCacheGeneration("conv-race");
      putRecallSelection({
        conversationId: "conv-race",
        assistantId: assistant.id,
        selectedIds: [1],
        modelKey: "p::emb",
        queryHash: "fresh",
        total: 2,
        builtAt: 2,
        reranked: false,
        invalidationGeneration: freshGeneration,
      }, freshGeneration);
      release();
      await pending;
      expect(getRecallSelection("conv-race")?.queryHash).toBe("fresh");
    } finally {
      server.stop(true);
    }
  });
});
