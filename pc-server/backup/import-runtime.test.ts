// backup/import-runtime.test.ts — 导入统一作废运行态(D2 回归)
//
// 备份导入(含 settings-only)是"运行态整体替换":旧流、旧队列、旧审批、旧 steering、
// 旧压缩与待发广播全部属于被替换掉的那一世代。本文件锁定四条硬语义:
//   1) finalize 清空运行态注册表(生成/压缩/审批/队列+等待方/steering/待发广播),
//      但 settings-only 导入不触碰活库会话;
//   2) 生成中途导入:旧流收尾不再广播陈旧帧;
//   3) 后生成任务(标题)跨导入不写回新库(即便恢复了同一会话 id);
//   4) 聊天压缩跨导入拒绝落库(旧实例不得覆盖导入后的会话行)。
// pi 压缩的同类防线见 conversations/pi-route.test.ts「pi 压缩期间导入」用例。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-import-rt-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { defaultAssistant } = await import("../assistants");
const { model, provider } = await import("../model-providers");
const { openConversationsDb, persistConversation, loadConversationNodesFromDb, getConversation } = await import("../conversations");
const { configureWorkingSet, registerConversation } = await import("../conversations/working-set");
const { getConversationMeta } = await import("../conversations/read-queries");
const { awaitingApproval, compressing, generating } = await import("../conversations/generation-state");
const { enqueueMessage, hasQueuedMessages, waitForQueuedReply } = await import("../conversations/message-queue");
const { drainSteeringMessages, pushSteeringMessage } = await import("../conversations/steering-channel");
const { runtimeEpoch } = await import("../conversations/runtime-epoch");
const { scheduleNodeBroadcast, conversationClients } = await import("../api/sse");
const { applyBackupPayload } = await import("./import");
const { generateAnswer } = await import("../conversations/orchestrator");
const { compressConversation } = await import("../conversations/auxiliary");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");

import type { Conversation, State } from "../foundation/types";
import type { FakeOpenAiSseServer } from "../test-utils/fake-openai-sse";

const priorState = jsonStore.state;
const db = openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

const servers: FakeOpenAiSseServer[] = [];
afterAll(async () => {
  jsonStore.setState(priorState);
  await Promise.all(servers.map((server) => server.close()));
  // 活库连接由本文件持有(与 windows-test-flakes 同型):删目录是尽力而为,不该让测试
  // 收尾在 Windows 上因子目录句柄报 EBUSY 而失败。
  try { rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true }); } catch { /* DB 句柄仍开 */ }
});

let seq = 0;
function makeConversation(title = "导入运行态测试"): Conversation {
  seq += 1;
  const now = Date.now();
  const conv = {
    id: `import-rt-conv-${seq}`,
    assistantId: "a1",
    systemPrompt: null,
    title,
    messages: [{
      id: `import-rt-n-${seq}`,
      selectIndex: 0,
      messages: [{
        id: `import-rt-m-${seq}`,
        role: "USER",
        parts: [{ type: "text", text: "原始用户消息" }],
        annotations: [],
        createdAt: new Date(now).toISOString(),
        finishedAt: null,
        translation: null,
      }],
    }],
    chatSuggestions: [],
    isPinned: false,
    createAt: now,
    updateAt: now,
  } as unknown as Conversation;
  persistConversation(conv);
  registerConversation(conv);
  return conv;
}

/** settings-only 导入:备份里没有 conversations → finalize 不重灌活库(既有会话保留),
 *  但运行态照常整体作废。 */
function importSettingsOnly(): void {
  applyBackupPayload({ settings: JSON.parse(JSON.stringify(jsonStore.state.settings)) });
}

async function installUpstream(turns: Parameters<typeof startFakeOpenAiSse>[0], opts?: { fastModel?: boolean }): Promise<FakeOpenAiSseServer> {
  const server = await startFakeOpenAiSse(turns);
  servers.push(server);
  const ourModel = model("fake-model", "Import Runtime Model");
  const ourProvider = provider({
    id: crypto.randomUUID(),
    name: "Import Runtime Provider",
    baseUrl: server.baseUrl,
    apiKey: "sk-test",
    enabled: true,
    models: [ourModel],
  });
  const next = defaultState();
  next.settings.assistantId = "a1";
  next.settings.assistants = [{ ...defaultAssistant(), id: "a1" }];
  next.settings.providers = [ourProvider];
  next.settings.chatModelId = ourModel.id;
  next.settings.fastModelId = opts?.fastModel ? ourModel.id : "";
  next.settings.enableSuggestion = false;
  jsonStore.setState(next as State);
  return server;
}

type Ctl = ReadableStreamDefaultController<Uint8Array>;

function makeController(): { ctl: Ctl; received: Uint8Array[] } {
  let ctl!: Ctl;
  const received: Uint8Array[] = [];
  new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  const rawEnqueue = ctl.enqueue.bind(ctl);
  ctl.enqueue = ((chunk: Uint8Array) => { rawEnqueue(chunk); received.push(chunk); }) as Ctl["enqueue"];
  return { ctl, received };
}

async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("导入统一作废运行态(D2)", () => {
  test("settings-only 导入:注册表/队列等待方/steering/待发广播全清,会话保留", async () => {
    await installUpstream([{ content: "未使用" }]);
    const conv = makeConversation("导入前标题");
    const epochBefore = runtimeEpoch();

    // 运行态五种注册各放一条:生成/压缩/审批/队列(with waiter)/steering。
    const controller = new AbortController();
    generating.set(conv.id, controller);
    compressing.set(conv.id, Date.now());
    awaitingApproval.set(conv.id, { startedAt: Date.now(), toolName: "bash" });
    const queued = enqueueMessage(conv.id, [{ type: "text", text: "排队消息" }], { waitingReply: true });
    enqueueMessage(conv.id, [{ type: "text", text: "普通排队" }]);
    const waiter = waitForQueuedReply(conv.id, queued.id);
    pushSteeringMessage(conv.id, queued.id, [{ type: "text", text: "steering 补发" }]);

    // 待发广播:第一次立即广播,第二次落在 33ms 合帧定时器里;期间改内容保证 flush
    // 确实有增量帧可发(否则"无帧"无法区分是清空还是无内容)。
    const { ctl, received } = makeController();
    conversationClients.set(conv.id, new Set([ctl]));
    const node = conv.messages[0]!;
    scheduleNodeBroadcast(conv, node);
    node.messages[0]!.parts = [{ type: "text", text: "原始用户消息(已改)" }];
    scheduleNodeBroadcast(conv, node);
    expect(received.length).toBeGreaterThan(0);

    try {
      importSettingsOnly();
      const framesAtImport = received.length;
      // 等待超过合帧窗口:定时器若未被清掉,陈旧增量帧会在这里冒出来。
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(received.length).toBe(framesAtImport);

      expect(runtimeEpoch()).toBeGreaterThan(epochBefore);
      expect(generating.has(conv.id)).toBe(false);
      expect(compressing.has(conv.id)).toBe(false);
      expect(awaitingApproval.has(conv.id)).toBe(false);
      expect(hasQueuedMessages(conv.id)).toBe(false);
      await expect(waiter).resolves.toBeNull();
      expect(drainSteeringMessages(conv.id, () => true)).toEqual([]);
      // settings-only 不重灌活库:会话行与消息原样保留。
      const meta = getConversationMeta(db, conv.id);
      expect(meta?.title).toBe("导入前标题");
      expect(JSON.stringify(loadConversationNodesFromDb(db, conv.id))).toContain("原始用户消息");
      expect(controller.signal.aborted).toBe(true);
    } finally {
      conversationClients.delete(conv.id);
    }
  }, 20_000);

  test("生成中途导入:旧流收尾不再向会话 SSE 广播陈旧帧", async () => {
    let framesAtImport = 0;
    let received: Uint8Array[] = [];
    const server = await installUpstream([{
      content: "前半回答",
      // 响应正文已写出、终帧之前导入:模拟"流式写到一半,用户恢复备份"。
      beforeFinish: () => {
        importSettingsOnly();
        framesAtImport = received.length;
      },
    }]);
    const conv = makeConversation("生成中途导入");
    const { ctl, received: chunks } = makeController();
    received = chunks;
    conversationClients.set(conv.id, new Set([ctl]));
    try {
      await generateAnswer(conv);
      await new Promise((resolve) => setTimeout(resolve, 90));
      // 导入后旧流的 finalizeOutcome/finally 均不得再广播(不管 node_update 还是 delta)。
      expect(received.length).toBe(framesAtImport);
      expect(generating.has(conv.id)).toBe(false);
      // 旧实例的流式内容没有借脏标记落进导入后的活库。
      expect(JSON.stringify(loadConversationNodesFromDb(db, conv.id))).not.toContain("前半回答");
      expect(server.requests.length).toBe(1);
    } finally {
      conversationClients.delete(conv.id);
    }
  }, 20_000);

  test("后生成标题任务跨导入不写回:同一会话 id 恢复后标题保持原值", async () => {
    let importDone = false;
    const server = await installUpstream([
      { content: "回答正文" },
      {
        content: "伪造标题",
        // 标题请求发出后、响应前导入:旧快照的产物不得写进导入后的库。
        beforeRespond: () => { importSettingsOnly(); importDone = true; },
      },
    ], { fastModel: true });
    // 标题为空 → 触发自动标题(submit 后由后生成任务发起第二次模型请求)。
    const conv = makeConversation("");
    await generateAnswer(conv);
    await waitUntil(() => server.requests.length >= 2);
    await waitUntil(() => importDone);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // 导入后重新从活库读取:标题仍是原值(空),不是旧任务产物。
    expect(getConversationMeta(db, conv.id)?.title ?? "").toBe("");
  }, 20_000);

  test("聊天压缩跨导入拒绝落库:旧实例不覆盖导入后的引擎压缩记录", async () => {
    await installUpstream([{
      content: "不该落库的摘要。",
      beforeRespond: () => importSettingsOnly(),
    }]);
    const conv = makeConversation("压缩跨导入");
    for (let round = 0; round < 4; round++) {
      conv.messages.push({
        id: `import-rt-c-${conv.id}-${round}`,
        selectIndex: 0,
        messages: [
          { id: `import-rt-cu-${round}`, role: "USER", parts: [{ type: "text", text: `用户第${round}轮。`.repeat(50) }], annotations: [], createdAt: new Date().toISOString(), finishedAt: null, translation: null },
          { id: `import-rt-ca-${round}`, role: "ASSISTANT", parts: [{ type: "text", text: `助手第${round}轮。`.repeat(50) }], annotations: [], createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), translation: null },
        ],
      } as never);
    }
    persistConversation(conv);

    await expect(compressConversation(conv, "", 2000, 1)).rejects.toThrow("运行态已在压缩期间被导入替换");
    // 活库里的会话行没有被旧实例的压缩结果覆盖。
    expect(getConversationMeta(db, conv.id)?.engineCompactions ?? null).toBeNull();
    // 导入后按 id 取回的是新实例,与旧实例身份不同。
    const reloaded = getConversation(conv.id);
    expect(reloaded).not.toBe(conv);
    expect(reloaded?.engineCompactions ?? null).toBeNull();
  }, 20_000);
});
