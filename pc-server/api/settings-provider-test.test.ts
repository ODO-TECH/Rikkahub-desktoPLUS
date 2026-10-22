// api/settings-provider-test.test.ts — 模型检测（settings/provider/test）按模型类型分流的路由锁。
// 锁四件事：① 嵌入/重排模型只打 /embeddings、/rerank，绝不发 chat/completions（否则工具型
// 供应商永远假红）；② 通过后照样盖章 testPassed；③ 协议不支持（claude/google）时不摸网络、
// 以 200 + ok:false 的可读文案返回；④ 普通聊天供应商的三模式行为不变（回归保护）。
// 全程打桩 globalThis.fetch，不发任何真实供应商请求。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-provider-test-"));

import type { Model, Provider, State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { defaultRequestStats } from "./logs";
import { handleSettingsRoutes } from "./handlers/settings";

interface OutboundCall {
  url: string;
  body: any;
}

let calls: OutboundCall[] = [];
let originalFetch: typeof globalThis.fetch;

function nonChatResponsesFor(url: string): { status: number; body: string } | null {
  // 取模型列表是所有检测的前置步：openai 形态看 data[]，google 形态看 models[]，一份报文两种键都给。
  if (url.includes("/models")) {
    return {
      status: 200,
      body: JSON.stringify({
        object: "list",
        data: [{ id: "bge-m3" }, { id: "bge-reranker-v2-m3" }, { id: "embedding-001" }, { id: "gpt-4o-mini" }],
        models: [{ name: "models/embedding-001" }],
      }),
    };
  }
  if (url.endsWith("/embeddings")) {
    return {
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: [0.11, 0.22, 0.33] }], usage: { prompt_tokens: 4, total_tokens: 4 } }),
    };
  }
  if (url.endsWith("/rerank")) {
    return {
      status: 200,
      body: JSON.stringify({ results: [{ index: 0, relevance_score: 0.12 }, { index: 1, relevance_score: 0.94 }] }),
    };
  }
  return null;
}

function stubFetch() {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const canned = nonChatResponsesFor(url);
    if (canned) {
      return new Response(canned.body, { status: canned.status, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`test stub got an unexpected url: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

function chatRequests() {
  return calls.filter((call) => call.url.endsWith("/chat/completions"));
}

function makeProvider(input: { id: string; name: string; baseUrl: string; type?: Provider["type"]; models: Model[] }): Provider {
  return {
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    type: input.type ?? "openai",
    enabled: true,
    apiKey: "sk-test",
    chatCompletionsPath: "/chat/completions",
    useResponseApi: false,
    models: input.models,
    balanceOption: { enabled: false, apiPath: "/credits", resultPath: "data.total_usage" },
  } as unknown as Provider;
}

function makeModel(modelId: string, type: Model["type"]): Model {
  return {
    id: `${type.toLowerCase()}-${modelId}`,
    modelId,
    displayName: modelId,
    type,
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    abilities: [],
    tools: [],
  } as unknown as Model;
}

async function postTest(providerId: string, modelId?: string): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/provider/test");
  return handleSettingsRoutes(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId }),
    }),
    url,
    "settings/provider/test",
  );
}

beforeAll(() => {
  setState({
    settings: {
      providers: [
        makeProvider({
          id: "silicon",
          name: "硅基流动",
          baseUrl: "https://api.siliconflow.cn/v1",
          models: [makeModel("bge-m3", "EMBEDDING"), makeModel("bge-reranker-v2-m3", "RERANK")],
        }),
        makeProvider({
          id: "gemini-embed",
          name: "Gemini 嵌入",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          type: "google",
          models: [makeModel("embedding-001", "EMBEDDING")],
        }),
        makeProvider({
          id: "chat-only",
          name: "聊天供应商",
          baseUrl: "https://api.openai.com/v1",
          models: [makeModel("gpt-4o-mini", "CHAT")],
        }),
      ],
      // 聊天检测会按 selectedModel 反查助手（state.settings.assistants），空数组即可。
      assistants: [],
      proxyConfig: { mode: "system", proxyServer: "" },
    },
    // 检测会写请求日志（addLog → state.stats），空态也必须带 stats/logs。
    stats: defaultRequestStats(),
    logs: [],
  } as unknown as State);
});

describe("settings/provider/test 类型分流", () => {
  test("嵌入模型：只打 /embeddings 一条，preview 是「维度 + token」，并盖章 testPassed", async () => {
    stubFetch();
    try {
      const res = await postTest("silicon", "bge-m3");
      expect(res?.status).toBe(200);
      const payload = await res!.json();
      expect(payload.checks.map((item: any) => item.mode)).toEqual(["embeddings"]);
      expect(payload.checks[0].ok).toBe(true);
      expect(payload.checks[0].endpoint).toBe("https://api.siliconflow.cn/v1/embeddings");
      expect(payload.checks[0].preview).toContain("嵌入可用：维度 3");
      expect(payload.checks[0].preview).toContain("消耗 4 token");
      expect(payload.testModelId).toBe("bge-m3");
      expect(chatRequests().length).toBe(0);
      const outbound = calls.find((call) => call.url.endsWith("/embeddings"));
      expect(outbound?.body).toEqual({ model: "bge-m3", input: ["rikkahub connectivity check"] });
      expect(state.settings.providers.find((item) => item.id === "silicon")?.testPassed).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  test("重排模型：只打 /rerank，相关度按降序进 preview，不发聊天请求", async () => {
    stubFetch();
    try {
      const res = await postTest("silicon", "bge-reranker-v2-m3");
      expect(res?.status).toBe(200);
      const payload = await res!.json();
      expect(payload.checks.map((item: any) => item.mode)).toEqual(["rerank"]);
      expect(payload.checks[0].ok).toBe(true);
      expect(payload.checks[0].endpoint).toBe("https://api.siliconflow.cn/v1/rerank");
      expect(payload.checks[0].preview).toContain("重排可用：对 2 条文档打分");
      expect(payload.checks[0].preview.indexOf("#1")).toBeLessThan(payload.checks[0].preview.indexOf("#0"));
      expect(chatRequests().length).toBe(0);
    } finally {
      restoreFetch();
    }
  });

  test("非 OpenAI 兼容协议：零网络、200 + ok:false，文案告诉用户换供应商而不是裸 404", async () => {
    stubFetch();
    try {
      const before = calls.length;
      const res = await postTest("gemini-embed", "embedding-001");
      expect(res?.status).toBe(200);
      const payload = await res!.json();
      expect(payload.checks[0].mode).toBe("embeddings");
      expect(payload.checks[0].ok).toBe(false);
      expect(payload.checks[0].preview).toContain("只支持 OpenAI 兼容供应商");
      // /models 是取列表必经的一次（models 端点），但 embeddings 线路一次都没发出去。
      expect(calls.filter((call) => call.url.endsWith("/embeddings")).length).toBe(0);
      expect(calls.length).toBeGreaterThan(before);
      expect(state.settings.providers.find((item) => item.id === "gemini-embed")?.testPassed).toBeFalsy();
    } finally {
      restoreFetch();
    }
  });

  test("回归：普通聊天供应商仍是三档，且档位结论决定盖章", async () => {
    stubFetch();
    try {
      const res = await postTest("chat-only", "gpt-4o-mini");
      expect(res?.status).toBe(200);
      const payload = await res!.json();
      expect(payload.checks.map((item: any) => item.mode)).toEqual(["non_stream", "stream", "tools"]);
      expect(chatRequests().length).toBe(3);
      expect(payload.checks.every((item: any) => item.ok === true)).toBe(true);
      expect(state.settings.providers.find((item) => item.id === "chat-only")?.testPassed).toBe(true);
    } finally {
      restoreFetch();
    }
  });

  test("供应商不存在：404，不摸网络", async () => {
    stubFetch();
    try {
      const res = await postTest("does-not-exist");
      expect(res?.status).toBe(404);
      expect(calls.length).toBe(0);
    } finally {
      restoreFetch();
    }
  });
});
