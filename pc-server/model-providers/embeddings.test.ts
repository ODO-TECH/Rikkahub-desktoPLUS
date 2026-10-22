// embeddings 单测：/embeddings 与 /rerank 两条非聊天出线路的纯函数契约 + 真实调用打桩。
// 覆盖三件事：① 端点怎么拼（各家 baseUrl 前缀约定）② 请求体/响应解析的形态族
// ③ 模型检测的分流（嵌入/重排不再打 chat/completions，因此不会假红）。
// 出站测试一律打桩 globalThis.fetch，绝不摸真实供应商。
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 出站调用会写请求日志（addLog → state.stats），所以先给测试一个隔离数据目录 + 空态，
// 而不是让 state 停在未初始化上。放在所有项目导入之前，保证 dataDir 取到的是临时目录。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-embeddings-test-"));

import { defaultRequestStats } from "../api/logs";
import type { Provider, State } from "../foundation/types";
import { setState } from "../persistence/json-store";
import {
  EMBEDDINGS_PATH,
  RERANK_PATH,
  assertOpenAiCompatible,
  callEmbeddings,
  callRerank,
  describeNonChatProbe,
  embeddingsEndpointFor,
  embeddingsRequestBody,
  isNonChatModelType,
  nonChatEndpointFor,
  parseEmbeddingsPayload,
  parseRerankPayload,
  probeNonChatModel,
  rerankEndpointFor,
  rerankRequestBody,
} from "./embeddings";
import {
  model,
  provider,
  providerTestCorePassed,
  providerTestModelType,
  providerTestModesForType,
} from "./index";

// 出站路径要写请求日志，先把全局态初始化成一份带 stats 的空态（数据目录已指向临时目录）。
setState({ stats: defaultRequestStats(), logs: [], settings: { providers: [] } } as unknown as State);

function openai(baseUrl: string, extra: Partial<Provider> = {}) {
  return provider({ id: "p1", name: "测试供应商", baseUrl, apiKey: "sk-test", type: "openai", ...extra });
}

// ── 端点拼接 ────────────────────────────────────────────────────────────────

describe("非聊天端点拼接", () => {
  it("baseUrl 剥尾斜杠后拼固定尾缀，各家真实路径全部由 baseUrl 承载", () => {
    expect(embeddingsEndpointFor(openai("https://api.openai.com/v1"))).toBe("https://api.openai.com/v1/embeddings");
    expect(embeddingsEndpointFor(openai("https://api.openai.com/v1/"))).toBe("https://api.openai.com/v1/embeddings");
    expect(rerankEndpointFor(openai("https://api.cohere.com/v2"))).toBe("https://api.cohere.com/v2/rerank");
    expect(rerankEndpointFor(openai("https://api.siliconflow.cn/v1///"))).toBe("https://api.siliconflow.cn/v1/rerank");
    // 中转深路径不剥前缀（与 claude 归一化不同）：网关自定义前缀要原样保留。
    expect(embeddingsEndpointFor(openai("https://relay.example.com/lmstudio"))).toBe("https://relay.example.com/lmstudio/embeddings");
  });

  it("模型级 providerOverwrite.baseUrl 覆盖供应商 baseUrl（空串回落）", () => {
    expect(nonChatEndpointFor(openai("https://api.openai.com/v1"), "EMBEDDING", "https://gw.internal/v3/")).toBe(
      "https://gw.internal/v3/embeddings",
    );
    expect(nonChatEndpointFor(openai("https://api.openai.com/v1"), "RERANK", "   ")).toBe("https://api.openai.com/v1/rerank");
    expect(nonChatEndpointFor(openai("https://x/v1"), "EMBEDDING")).toContain(EMBEDDINGS_PATH);
    expect(nonChatEndpointFor(openai("https://x/v1"), "RERANK")).toContain(RERANK_PATH);
  });

  it("只有 OpenAI 兼容协议有这两条线路：claude/google 给可读中文错误", () => {
    const claude = provider({ id: "c", name: "Claude", baseUrl: "https://api.anthropic.com", apiKey: "sk", type: "claude" });
    expect(() => assertOpenAiCompatible(claude, "EMBEDDING")).toThrow(/只支持 OpenAI 兼容供应商/);
    expect(() => assertOpenAiCompatible(claude, "RERANK")).toThrow(/重排只支持/);
    expect(() => assertOpenAiCompatible(openai("https://api.openai.com/v1"), "RERANK")).not.toThrow();
  });

  it("isNonChatModelType 认大小写混写，其余一律 false", () => {
    expect(isNonChatModelType("embedding")).toBe(true);
    expect(isNonChatModelType("RERANK")).toBe(true);
    expect(isNonChatModelType("CHAT")).toBe(false);
    expect(isNonChatModelType(undefined)).toBe(false);
  });
});

// ── 请求体 ──────────────────────────────────────────────────────────────────

describe("非聊天请求体", () => {
  it("嵌入：input 恒为字符串数组并丢掉空条目，全空直接拒发", () => {
    expect(embeddingsRequestBody("m", ["a", "", "b"])).toEqual({ model: "m", input: ["a", "b"] });
    expect(() => embeddingsRequestBody("m", [])).toThrow(/input 为空/);
    expect(() => embeddingsRequestBody("m", ["", ""])).toThrow(/input 为空/);
  });

  it("重排：query/documents 缺一不发", () => {
    expect(rerankRequestBody("m", "q", ["a", "b"])).toEqual({ model: "m", query: "q", documents: ["a", "b"] });
    expect(() => rerankRequestBody("m", "  ", ["a"])).toThrow(/query 为空/);
    expect(() => rerankRequestBody("m", "q", [""])).toThrow(/documents 为空/);
  });

  it("重排：top_n 缺省不写、越界夹到文档数、非正数当没写", () => {
    expect("top_n" in rerankRequestBody("m", "q", ["a", "b"])).toBe(false);
    expect(rerankRequestBody("m", "q", ["a", "b"], 1).top_n).toBe(1);
    expect(rerankRequestBody("m", "q", ["a", "b"], 99).top_n).toBe(2);
    expect("top_n" in rerankRequestBody("m", "q", ["a"], 0)).toBe(false);
    expect("top_n" in rerankRequestBody("m", "q", ["a"], Number.NaN)).toBe(false);
  });
});

// ── 响应解析 ────────────────────────────────────────────────────────────────

describe("parseEmbeddingsPayload", () => {
  it("OpenAI 形态：data[].embedding + usage", () => {
    const result = parseEmbeddingsPayload(
      {
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      },
      2,
    );
    expect(result.dim).toBe(3);
    expect(result.vectors[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.usage).toEqual({ promptTokens: 5, totalTokens: 5 });
  });

  it("index 乱序按 index 归位，不靠返回顺序", () => {
    const result = parseEmbeddingsPayload({
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
    });
    expect(result.vectors).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("兼容三种变体：向量被序列化成字符串 / embeddings[] / output.embeddings[]", () => {
    expect(parseEmbeddingsPayload({ data: [{ embedding: "[0.5,0.25]" }] }).vectors).toEqual([[0.5, 0.25]]);
    expect(parseEmbeddingsPayload({ embeddings: [[0.5, 0.25]] }).dim).toBe(2);
    expect(parseEmbeddingsPayload({ output: { embeddings: [{ embedding: [0.5, 0.25] }] } }).dim).toBe(2);
    // Voyage 旧形态：数组元素直接就是向量本身
    expect(parseEmbeddingsPayload({ embeddings: [[0.5, 0.25]] }).vectors[0]).toEqual([0.5, 0.25]);
  });

  it("形态不认识时报的是「响应形态」而不是裸崩溃", () => {
    expect(() => parseEmbeddingsPayload({})).toThrow(/非预期形态/);
    expect(() => parseEmbeddingsPayload({ data: [] })).toThrow(/非预期形态/);
    expect(() => parseEmbeddingsPayload({ data: [{ embedding: "not-json" }] })).toThrow(/不是数字数组/);
    expect(() => parseEmbeddingsPayload({ data: [{ embedding: [0.1, "x"] }] })).toThrow(/不是数字数组/);
  });

  it("维度不一致 / 长度为 0 / 条数不符都单独报错", () => {
    expect(() =>
      parseEmbeddingsPayload({ data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1, 2, 3] }] }),
    ).toThrow(/维度不一致（2 \/ 3）/);
    expect(() => parseEmbeddingsPayload({ data: [{ index: 0, embedding: [] }] })).toThrow(/长度为 0/);
    expect(() => parseEmbeddingsPayload({ data: [{ index: 0, embedding: [1, 2] }] }, 3)).toThrow(/请求 3 条，返回 1 条/);
  });
});

describe("parseRerankPayload", () => {
  it("relevance_score 按分数降序，index 指向请求文档下标", () => {
    const result = parseRerankPayload({
      results: [
        { index: 0, relevance_score: 0.11 },
        { index: 1, relevance_score: 0.97 },
      ],
    });
    expect(result.results).toEqual([
      { index: 1, score: 0.97 },
      { index: 0, score: 0.11 },
    ]);
  });

  it("认 score / relevanceScore 两种别名，并丢掉无分条目", () => {
    expect(parseRerankPayload({ results: [{ index: 0, score: 0.4 }] }).results[0].score).toBe(0.4);
    expect(parseRerankPayload({ results: [{ index: 0, relevanceScore: 0.4 }] }).results[0].score).toBe(0.4);
    expect(parseRerankPayload({ results: [{ index: 0, relevance_score: 0.4 }, { index: 1 }] }).results.length).toBe(1);
  });

  it("Xinference 形态：只有 scores[]，下标即文档序", () => {
    const result = parseRerankPayload({ scores: [0.2, 0.8] });
    expect(result.results).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.2 },
    ]);
  });

  it("空响应报「响应形态不认识」；index 越界单独报供应商返回异常", () => {
    expect(() => parseRerankPayload({})).toThrow(/没有 results\[\]\.relevance_score/);
    expect(() => parseRerankPayload({ results: [{ index: 5, relevance_score: 0.9 }] }, 2)).toThrow(/index 越界（文档共 2 条）/);
  });
});

// ── 出站调用（打桩 fetch，零真实网络）────────────────────────────────────────

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(
  respond: () => { status?: number; body: string },
): { calls: StubCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({
      url: String(typeof input === "string" ? input : input?.url ?? input),
      method: String(init.method ?? "GET"),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      ),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { status = 200, body } = respond();
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("callEmbeddings / callRerank 出站", () => {
  it("嵌入：POST 到 /embeddings，带 Bearer 凭据与 {model, input}，返回同序向量", async () => {
    const stub = stubFetch(() => ({
      body: JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }] }),
    }));
    try {
      const result = await callEmbeddings(openai("https://api.siliconflow.cn/v1"), model("bge-m3"), ["甲", "乙"]);
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0].url).toBe("https://api.siliconflow.cn/v1/embeddings");
      expect(stub.calls[0].method).toBe("POST");
      expect(stub.calls[0].headers.Authorization).toBe("Bearer sk-test");
      expect(stub.calls[0].body).toEqual({ model: "bge-m3", input: ["甲", "乙"] });
      expect(result.dim).toBe(2);
      expect(result.vectors[1]).toEqual([0.3, 0.4]);
    } finally {
      stub.restore();
    }
  });

  it("重排：POST 到 /rerank，响应归一为降序 {index, score}", async () => {
    const stub = stubFetch(() => ({
      body: JSON.stringify({ results: [{ index: 0, relevance_score: 0.05 }, { index: 1, relevance_score: 0.9 }] }),
    }));
    try {
      const result = await callRerank(openai("https://api.cohere.com/v2"), model("rerank-v3.5"), "问", ["A", "B"], { topN: 1 });
      expect(stub.calls[0].url).toBe("https://api.cohere.com/v2/rerank");
      expect(stub.calls[0].body).toEqual({ model: "rerank-v3.5", query: "问", documents: ["A", "B"], top_n: 1 });
      expect(result.results[0]).toEqual({ index: 1, score: 0.9 });
    } finally {
      stub.restore();
    }
  });

  it("模型级自定义请求体能进真实请求（供应商头 < 模型头）", async () => {
    const stub = stubFetch(() => ({ body: JSON.stringify({ data: [{ embedding: [1, 2] }] }) }));
    try {
      const p = openai("https://api.openai.com/v1", {
        customHeaders: [{ name: "X-Provider", value: "p" }],
      } as any);
      const m = { ...model("text-embedding-3-small"), type: "EMBEDDING" as const, customHeaders: [{ name: "X-Model", value: "m" }] } as any;
      await callEmbeddings(p, m, ["x"]);
      expect(stub.calls[0].headers["X-Provider"]).toBe("p");
      expect(stub.calls[0].headers["X-Model"]).toBe("m");
    } finally {
      stub.restore();
    }
  });

  it("上游 4xx：错误对象带 status（检测面板要显示状态码），且不发第二次请求", async () => {
    const stub = stubFetch(() => ({ status: 404, body: "model not found" }));
    try {
      const err = await callEmbeddings(openai("https://api.openai.com/v1"), { ...model("nope"), type: "EMBEDDING" } as any, ["x"]).catch((e) => e);
      expect((err as Error & { status?: number }).status).toBe(404);
      expect(stub.calls.length).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it("非 OpenAI 兼容供应商：零网络直接失败（不是裸 404）", async () => {
    const original = globalThis.fetch;
    let touched = 0;
    globalThis.fetch = (async () => {
      touched += 1;
      throw new Error("network must not be touched");
    }) as unknown as typeof fetch;
    try {
      const google = provider({ id: "g", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "k", type: "google" });
      await expect(callEmbeddings(google, { ...model("embedding-001"), type: "EMBEDDING" } as any, ["x"])).rejects.toThrow(/只支持 OpenAI 兼容供应商/);
      expect(touched).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── 模型检测分流 ────────────────────────────────────────────────────────────

describe("模型检测按类型分流", () => {
  it("嵌入/重排只打自己那条线路，聊天仍是三档", () => {
    expect(providerTestModesForType("EMBEDDING")).toEqual(["embeddings"]);
    expect(providerTestModesForType("rerank")).toEqual(["rerank"]);
    expect(providerTestModesForType("IMAGE")).toEqual(["non_stream", "stream", "tools"]);
    expect(providerTestModesForType(undefined)).toEqual(["non_stream", "stream", "tools"]);
  });

  it("所选模型类型取自供应商登记表（大小写不敏感），未登记回落 CHAT", () => {
    const p = openai("https://api.openai.com/v1");
    p.models = [{ ...model("bge-reranker-v2-m3"), type: "RERANK" } as any];
    expect(providerTestModelType(p, "bge-reranker-v2-m3")).toBe("RERANK");
    expect(providerTestModelType(p, "not-registered")).toBe("CHAT");
    expect(providerTestModelType(p, "", [{ ...model("text-embedding-3-small"), type: "EMBEDDING" } as any])).toBe("CHAT");
  });

  it("工具型供应商没有 chat 线路：embeddings/rerank 通过即算 testPassed", () => {
    expect(providerTestCorePassed([{ mode: "embeddings", ok: true }])).toBe(true);
    expect(providerTestCorePassed([{ mode: "rerank", ok: true }])).toBe(true);
    expect(providerTestCorePassed([{ mode: "non_stream", ok: false }, { mode: "embeddings", ok: false }])).toBe(false);
  });

  it("探测把响应折算成人能读懂的一行", async () => {
    const embedStub = stubFetch(() => ({
      body: JSON.stringify({ data: [{ index: 0, embedding: [0.1234, 0.5, 0.25, 0.1] }], usage: { total_tokens: 7 } }),
    }));
    try {
      const r = await probeNonChatModel(openai("https://api.openai.com/v1"), { ...model("text-embedding-3-small"), type: "EMBEDDING" } as any, "EMBEDDING");
      expect(embedStub.calls[0].url).toBe("https://api.openai.com/v1/embeddings");
      expect(describeNonChatProbe(r)).toContain("嵌入可用：维度 4");
      expect(describeNonChatProbe(r)).toContain("消耗 7 token");
    } finally {
      embedStub.restore();
    }
    const rerankStub = stubFetch(() => ({ body: JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }) }));
    try {
      const r = await probeNonChatModel(openai("https://api.cohere.com/v2"), { ...model("rerank-v3.5"), type: "RERANK" } as any, "RERANK");
      expect(rerankStub.calls[0].url).toBe("https://api.cohere.com/v2/rerank");
      expect(describeNonChatProbe(r)).toContain("重排可用：对 2 条文档打分");
    } finally {
      rerankStub.restore();
    }
  });
});
