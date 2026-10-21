// Google 流式工具循环端到端单测（P1-5 批C）：mock 全局 fetch 仿真 Gemini SSE，
// 验证 functionCall 归一、modelParts 回放（含 thoughtSignature）、functionResponse
// 编码、最终文本——Google 路径首个回归网。
import { afterAll, describe, expect, mock, test } from "bun:test";

// 展开真实模块只覆盖目标导出:bun 的 mock.module 跨测试文件不回收(见 tool-loop.test.ts)。
import * as actualLogs from "../api/logs";
import * as actualSse from "../api/sse";

mock.module("../api/logs", () => ({ ...actualLogs, addLog: () => {} }));
mock.module("../api/sse", () => ({ ...actualSse, touchStream: () => {} }));

const { streamGoogleChatWithTools } = await import("./providers");

const assistant = { id: "a1", mcpServers: [] } as never;
const providerItem = { id: "p1", name: "Gemini Test" } as never;

function sse(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
}

const toolRoundStream = sse([
  {
    candidates: [{ content: { parts: [
      { text: "先说一句" },
      { functionCall: { name: "do_it", args: { a: 1 } }, thoughtSignature: "tsig" },
    ] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  },
]);

const finalRoundStream = sse([
  { candidates: [{ content: { parts: [{ text: "完成" }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } },
]);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("streamGoogleChatWithTools", () => {
  test("functionCall 轮→modelParts 回放(thoughtSignature 保留)+functionResponse→最终文本", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const streams = [toolRoundStream, finalRoundStream];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(streams.shift() ?? "", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const executed: Array<{ name: string; args: string }> = [];
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async (call: { function: { name: string; arguments: string } }) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return { output: [{ type: "text", text: "工具输出" }] };
      },
    } as never;

    const out = await streamGoogleChatWithTools(
      "https://gen.test/v1beta/",
      { "x-goog-api-key": "api-key" },
      "gemini-test",
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      providerItem,
      assistant,
      undefined,
      hooks,
    );

    // joinTextWithNewline: 第一轮"先说一句" + \n + "完成"
    expect(out).toBe("先说一句\n完成");
    expect(executed).toEqual([{ name: "do_it", args: '{"a":1}' }]);
    // issue10:鉴权走 x-goog-api-key 头,URL 不再带 ?key=
    expect(requests[0]!.url).toContain(":streamGenerateContent?alt=sse");
    expect(requests[0]!.url).not.toContain("key=api-key");

    const secondContents = requests[1]!.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(secondContents).toHaveLength(3);
    const modelReplay = secondContents[1]!;
    expect(modelReplay.role).toBe("model");
    expect(modelReplay.parts).toEqual([
      { text: "先说一句" },
      { functionCall: { name: "do_it", args: { a: 1 } }, thoughtSignature: "tsig" },
    ]);
    const responseTurn = secondContents[2]!;
    expect(responseTurn.role).toBe("user");
    const fr = responseTurn.parts[0]!.functionResponse as { name: string; response: { result: unknown } };
    expect(fr.name).toBe("do_it");
    expect(String(fr.response.result)).toContain("工具输出");
  });

  test("无工具单轮直接返回文本", async () => {
    globalThis.fetch = (async () => new Response(finalRoundStream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async () => ({ output: [] }),
    } as never;
    const out = await streamGoogleChatWithTools("https://gen.test/v1beta/", {}, "m", { contents: [] }, providerItem, assistant, undefined, hooks);
    expect(out).toBe("完成");
  });

  // 全面审查 3-1 回归:promptFeedback.blockReason 必须穿透 SSE 容错 catch 冒泡为拒绝
  // (与 Claude 侧统一改用 UpstreamStreamError 类型判别,不再做字符串前缀匹配)。
  test("promptFeedback.blockReason 冒泡为拒绝,不被容错 catch 吞掉", async () => {
    const blockedStream = sse([{ promptFeedback: { blockReason: "SAFETY" } }]);
    globalThis.fetch = (async () => new Response(blockedStream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async () => ({ output: [] }),
    } as never;
    await expect(
      streamGoogleChatWithTools("https://gen.test/v1beta/", {}, "m", { contents: [] }, providerItem, assistant, undefined, hooks),
    ).rejects.toThrow("Gemini blocked: SAFETY");
  });
});

// 专题9:助手关闭"流式输出"→ 改走 generateContent 非流式端点,响应为单个完整 JSON。
describe("streamGoogleChatWithTools 非流式模式", () => {
  const nsAssistant = { id: "a1", mcpServers: [], streamOutput: false } as never;
  const toolRoundJson = JSON.stringify({
    candidates: [{ content: { parts: [
      { text: "先说一句" },
      { functionCall: { name: "do_it", args: { a: 1 } }, thoughtSignature: "tsig" },
    ] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
  const finalRoundJson = JSON.stringify({
    candidates: [{ content: { parts: [{ text: "完成" }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
  });

  test("两轮均请求 generateContent;functionCall 归一与回放同流式", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const payloads = [toolRoundJson, finalRoundJson];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(payloads.shift() ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const executed: Array<{ name: string; args: string }> = [];
    const hooks = {
      conversation: { id: "c1", title: "t" },
      node: { id: "n1" },
      message: { id: "m1", role: "ASSISTANT", parts: [] as unknown[], annotations: [], createdAt: 0, finishedAt: null },
      sink: () => {},
      executeTool: async (call: { function: { name: string; arguments: string } }) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return { output: [{ type: "text", text: "工具输出" }] };
      },
    } as never;

    const out = await streamGoogleChatWithTools(
      "https://gen.test/v1beta/",
      { "x-goog-api-key": "api-key" },
      "gemini-test",
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      providerItem,
      nsAssistant,
      undefined,
      hooks,
    );

    expect(out).toBe("先说一句\n完成");
    expect(executed).toEqual([{ name: "do_it", args: JSON.stringify({ a: 1 }) }]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toContain(":generateContent");
      expect(request.url).not.toContain("key=api-key");
      expect(request.url).not.toContain("streamGenerateContent");
    }
    const secondContents = requests[1]!.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(secondContents[1]!.parts).toEqual([
      { text: "先说一句" },
      { functionCall: { name: "do_it", args: { a: 1 } }, thoughtSignature: "tsig" },
    ]);
  });
});
