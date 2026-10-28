// pi-engine/subagent-tools.test.ts — subagent_dispatch 全链路集成(P1)
//
// 真 pi 会话循环 + 假 OpenAI SSE 上游:父会话第一轮派发 → 子生成独立上下文 → 摘要
// 回灌父会话 → 父会话终局。覆盖:摘要回灌、子工具卡归属标记、子审批独立 scope
// (父会话 confirm_each 下放行子写盘)、model_id 严格解析(未知即任务失败,不回落 auto)、
// 总开关关闭时不声明。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-subagent-tools-"));

const conversations = await import("../conversations");
const { configureWorkingSet } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const ws = await import("../workspace");
const { workspaceRuntimeForConversation } = await import("../workspace/runtime");
const { resolveToolApproval, pendingToolApprovalCount } = await import("../inference-engine/approval-gate");
const { runPiGeneration } = await import("./runner");
const { createPiSubagentTools } = await import("./subagent-tools");
const { createPiWorkspaceTools } = await import("./workspace-tools");
const { model, provider } = await import("../model-providers");
const { defaultSubagentConfig } = await import("../foundation/types/settings/subagent-config");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const { loadState } = await import("../persistence/state-load");
const jsonStore = await import("../persistence/json-store");
const { setState } = jsonStore;
setState(await loadState());

import type { GenerationEvent } from "../inference-engine/events";
import type { FakeOpenAiSseServer, FakeSseTurn } from "../test-utils/fake-openai-sse";

const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: () => false,
  hasSseClients: () => false,
  hasDirty: () => false,
});

const fakeAssistant = {
  id: "a1",
  name: "A",
  systemPrompt: "",
  mcpServers: [],
  enabledSkills: [],
  localTools: [],
  enableMemory: false,
  memoryWriteScope: "readonly",
  allowConversationSystemPrompt: false,
} as never;

let seq = 0;
function bindWorkspaceConversation(preset?: "confirm_each" | "balanced" | "full_access") {
  seq += 1;
  const workspace = ws.createWorkspace({ type: "managed", name: `subagent-tools-${seq}` });
  if (preset) ws.updateWorkspace(workspace.id, { permissionPreset: preset });
  const conversation = {
    id: `subagent-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title: `t-${seq}`,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    workspaceId: workspace.id,
    workspaceCwd: null,
  };
  conversations.persistConversation(conversation);
  return { workspace, conversation };
}

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

function settings(patch: Record<string, unknown> = {}) {
  return { ...defaultSubagentConfig(), enabled: true, ...patch };
}

async function scriptedRun(
  turns: FakeSseTurn[],
  conversation: { id: string },
  cwd: string,
  subagent: ReturnType<typeof settings>,
  ctxExtra: { extraSystemPrompt?: string } = {},
) {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const events: GenerationEvent[] = [];
  const sink = (event: GenerationEvent) => void events.push(event);
  const providerItem = provider({ id: crypto.randomUUID(), name: "Subagent Provider", baseUrl: server.baseUrl, apiKey: "sk-test" });
  const modelItem = model("fake-model", "Fake Model");
  const run = runPiGeneration({
    provider: providerItem,
    model: modelItem,
    conversationId: conversation.id,
    cwd,
    history: [],
    promptText: "干活",
    tools: [
      ...createPiWorkspaceTools({ conversation: conversation as never, assistant: fakeAssistant, sink }),
      ...createPiSubagentTools(
        {
          conversation: conversation as never,
          assistant: fakeAssistant,
          sink,
          provider: providerItem,
          model: modelItem,
          resolveModelLimits: () => ({ contextWindow: 128_000, maxTokens: 8_192 }),
          cwd,
          root: cwd,
          ...ctxExtra,
        },
        subagent,
      ),
    ],
    sink,
  });
  return { server, events, run };
}

function approvalStates(events: GenerationEvent[]): Array<{ type: string; reason?: string }> {
  return events
    .filter((event) => event.kind === "tool_approval_updated")
    .map((event) => (event as { approvalState: { type: string; reason?: string } }).approvalState);
}

function dispatchResultText(events: GenerationEvent[]): string {
  const result = events.find((event) => event.kind === "tool_result" && (event as { toolCallId?: string }).toolCallId === "tc-dispatch-1") as
    | { output: unknown }
    | undefined;
  return JSON.stringify(result?.output ?? []);
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("subagent_dispatch pi 桥", () => {
  test("子上下文独立、摘要回灌父会话,子过程文本不进父流", async () => {
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, events, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({ mode: "single", tasks: [{ title: "调研", prompt: "写一句暗号" }] }),
          }],
        },
        { content: "child-result-marker" },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
    );
    const result = await run;
    expect(result.text).toBe("父终局");
    // 三次上游请求:父派发 → 子生成 → 父收摘要。
    expect(server.requests.length).toBe(3);
    // 子生成上下文独立:请求里只有任务 prompt,没有父对话内容。
    expect(JSON.stringify(server.requests[1])).toContain("写一句暗号");
    expect(JSON.stringify(server.requests[1])).not.toContain("干活");
    // 摘要回灌:父第三次请求携带子智能体产出。
    expect(JSON.stringify(server.requests[2])).toContain("child-result-marker");
    expect(dispatchResultText(events)).toContain("child-result-marker");
    // 子文本不进父流(父气泡只应有自己的终局文本)。
    const parentText = events
      .filter((event) => event.kind === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(parentText).toContain("父终局");
    expect(parentText).not.toContain("child-result-marker");
  }, 30_000);

  test("子智能体写文件:confirm_each 下弹子审批卡,放行后落盘(独立 scope)", async () => {
    const { workspace, conversation } = bindWorkspaceConversation("confirm_each");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { events, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({ mode: "single", tasks: [{ title: "写文件", prompt: "把文件写了" }] }),
          }],
        },
        {
          toolCalls: [{
            id: "tc-child-write-1",
            name: "write",
            arguments: JSON.stringify({ path: "child-out.txt", content: "written-by-subagent" }),
          }],
        },
        { content: "写好了" },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
    );
    await waitUntil(() => approvalStates(events).some((state) => state.type === "pending"));
    // 子工具卡在父事件流里带归属标记。
    const childCard = events.find(
      (event) => event.kind === "tool_call_created" && (event as { toolCallId?: string }).toolCallId === "tc-child-write-1",
    ) as { metadata?: { subagent?: { title?: string } } } | undefined;
    expect(childCard?.metadata?.subagent?.title).toBe("写文件");
    // 决议只带 conversationId + toolCallId(与真实 API 同形),跨 scope 命中。
    expect(pendingToolApprovalCount()).toBe(1);
    expect(resolveToolApproval(conversation.id, "tc-child-write-1", { approved: true })).toBe(true);
    const result = await run;
    expect(result.text).toBe("父终局");
    expect(readFileSync(join(workspace.root, "child-out.txt"), "utf-8")).toBe("written-by-subagent");
    expect(approvalStates(events).map((state) => state.type)).toEqual(["pending", "approved"]);
    expect(pendingToolApprovalCount()).toBe(0);
  }, 30_000);

  for (const preset of ["balanced", "full_access"] as const) {
    test(`子智能体写文件:${preset} 档免审批直接落盘(与父会话同一判定矩阵)`, async () => {
      const { workspace, conversation } = bindWorkspaceConversation(preset);
      const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
      const { events, run } = await scriptedRun(
        [
          {
            toolCalls: [{
              id: "tc-dispatch-1",
              name: "subagent_dispatch",
              arguments: JSON.stringify({ mode: "single", tasks: [{ title: "写文件", prompt: "把文件写了" }] }),
            }],
          },
          {
            toolCalls: [{
              id: "tc-child-write-2",
              name: "write",
              arguments: JSON.stringify({ path: `auto-${preset}.txt`, content: preset }),
            }],
          },
          { content: "写好了" },
          { content: "父终局" },
        ],
        conversation,
        cwd,
        settings(),
      );
      const result = await run;
      expect(result.text).toBe("父终局");
      expect(readFileSync(join(workspace.root, `auto-${preset}.txt`), "utf-8")).toBe(preset);
      expect(approvalStates(events)).toEqual([]);
    }, 30_000);
  }

  test("子智能体越界写:balanced 档须过审批,拒绝后不落盘(边界不放宽)", async () => {
    const { workspace, conversation } = bindWorkspaceConversation("balanced");
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const filename = `subagent-outside-${seq}.txt`;
    const outsidePath = join(workspace.root, "..", filename);
    const { events, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({ mode: "single", tasks: [{ title: "越界写", prompt: "写到工作区外" }] }),
          }],
        },
        {
          toolCalls: [{
            id: "tc-child-out-1",
            name: "write",
            arguments: JSON.stringify({ path: `../${filename}`, content: "must-not-land" }),
          }],
        },
        { content: "没写成" },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
    );
    await waitUntil(() => approvalStates(events).some((state) => state.type === "pending"));
    const pendingReason = events
      .filter((event) => event.kind === "tool_approval_updated")
      .map((event) => String((event as { approvalState: { reason?: string } }).approvalState.reason ?? ""))
      .join("\n");
    // 子面与父会话同一判定矩阵:区外写在 balanced 档必须挂审批,缘由写明越界/系统边界。
    expect(pendingReason).toMatch(/outside the workspace|sandbox boundary/i);
    expect(resolveToolApproval(conversation.id, "tc-child-out-1", { approved: false })).toBe(true);
    const result = await run;
    expect(result.text).toBe("父终局");
    expect(existsSync(outsidePath)).toBe(false);
    expect(pendingToolApprovalCount()).toBe(0);
  }, 30_000);

  test("model_id 严格解析:未知模型只让该任务失败,不回落 auto", async () => {
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, events, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({
              mode: "single",
              tasks: [{ title: "换模型", prompt: "p", model_id: "no-such-model" }],
            }),
          }],
        },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
    );
    const result = await run;
    expect(result.text).toBe("父终局");
    // 子生成在发起上游请求前就失败,只消耗父会话两轮。
    expect(server.requests.length).toBe(2);
    const summary = dispatchResultText(events);
    expect(summary).toContain("Unknown model_id");
    expect(summary).toContain("0/1 completed");
  }, 30_000);

  test("model_id 生效:子生成的上游请求使用指定模型", async () => {
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const childServer = await startFakeOpenAiSse([{ content: "子结果" }]);
    servers.push(childServer);
    const cheapProvider = provider({
      id: "cheap-provider",
      name: "Cheap",
      baseUrl: childServer.baseUrl,
      apiKey: "sk-test",
      models: [model("cheap-model", "Cheap Model")],
    });
    jsonStore.state.settings.providers.push(cheapProvider);
    try {
      const { server, events, run } = await scriptedRun(
        [
          {
            toolCalls: [{
              id: "tc-dispatch-1",
              name: "subagent_dispatch",
              arguments: JSON.stringify({
                mode: "single",
                tasks: [{ title: "换模型", prompt: "p", model_id: "cheap-model" }],
              }),
            }],
          },
          { content: "父终局" },
        ],
        conversation,
        cwd,
        settings(),
      );
      const result = await run;
      expect(result.text).toBe("父终局");
      // 子任务的上游请求落在指定供应商上,模型名即 model_id。
      expect(childServer.requests.length).toBe(1);
      expect(childServer.requests[0]).toMatchObject({ model: "cheap-model" });
      expect(server.requests.every((request) => request.model === "fake-model")).toBe(true);
      expect(dispatchResultText(events)).toContain("1/1 completed");
    } finally {
      jsonStore.state.settings.providers = jsonStore.state.settings.providers.filter((item) => item.id !== "cheap-provider");
    }
  }, 30_000);

  const REMOTE_WORKSPACE_BLOCK = [
    "<workspace>",
    "You have access to a persistent remote workspace named `srv` on a real machine, reached over SSH as `deploy`.",
    "- The workspace directory is `/srv/app`. Use it as your working directory.",
    "- This is not a sandbox: a command can affect other data and services on this machine.",
    "</workspace>",
  ].join("\n");

  test("远程说明随父层下发:并行子代理都拿到同一份 <workspace> 块", async () => {
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({
              mode: "parallel",
              tasks: [
                { title: "甲", prompt: "任务甲" },
                { title: "乙", prompt: "任务乙" },
              ],
            }),
          }],
        },
        { content: "甲完成" },
        { content: "乙完成" },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
      { extraSystemPrompt: REMOTE_WORKSPACE_BLOCK },
    );
    const result = await run;
    expect(result.text).toBe("父终局");
    // 子请求 = 1/2(并行顺序不定,内容断言不看顺序);父请求不归本装配点管。
    for (const index of [1, 2]) {
      const text = JSON.stringify(server.requests[index] ?? {});
      expect(text).toContain("<workspace>");
      expect(text).toContain("/srv/app");
      expect(text).toContain("not a sandbox");
      // 环境说明在前、子智能体行为约定在后(与装配顺序一致)。
      expect(text.indexOf("<workspace>")).toBeLessThan(
        text.indexOf("You are a subagent working on a single delegated task"),
      );
    }
  }, 30_000);

  test("本地工作区不注入远程说明:子代理系统面保持原样", async () => {
    const { conversation } = bindWorkspaceConversation();
    const cwd = workspaceRuntimeForConversation(conversation as never)!.cwd;
    const { server, run } = await scriptedRun(
      [
        {
          toolCalls: [{
            id: "tc-dispatch-1",
            name: "subagent_dispatch",
            arguments: JSON.stringify({ mode: "single", tasks: [{ title: "本地", prompt: "干活" }] }),
          }],
        },
        { content: "子完成" },
        { content: "父终局" },
      ],
      conversation,
      cwd,
      settings(),
    );
    const result = await run;
    expect(result.text).toBe("父终局");
    expect(JSON.stringify(server.requests[1] ?? {})).not.toContain("<workspace>");
  }, 30_000);

  test("总开关关闭:工具面不声明", () => {
    const { conversation } = bindWorkspaceConversation();
    const tools = createPiSubagentTools(
      {
        conversation: conversation as never,
        assistant: fakeAssistant,
        sink: () => undefined,
        provider: provider({ id: "p", name: "P", baseUrl: "http://127.0.0.1:1", apiKey: "k" }),
        model: model("m", "M"),
        resolveModelLimits: () => ({ contextWindow: 128_000, maxTokens: 8_192 }),
        cwd: process.cwd(),
        root: process.cwd(),
      },
      settings({ enabled: false }),
    );
    expect(tools).toEqual([]);
  });
});
