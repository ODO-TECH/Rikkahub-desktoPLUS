// im/runtime.test.ts — 配对闸门、指令路由与工作区绑定:不碰模型的那半条链路。
//
// 这里只测"到不了模型"的路径(未配对、/help、/status、/new、/stop、去重、空文本)——
// 一旦真的走进 askAssistant 就会发起计费请求,所以配对后的普通消息刻意不在此覆盖,
// 那部分靠桌面端会话链路的既有测试。
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
// /new 会建会话并写入活库,不能落到真实 pc-data 里。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-im-runtime-test-"));

import type { State } from "../foundation/types";
import type { ImAccessConfig } from "../foundation/types/settings/im-access";
import type { ImInbound, ImPort, ImRuntime as ImRuntimeInstance } from "./runtime";

const { defaultImAccess } = await import("../foundation/types/settings/im-access");
const { setState, state: priorState } = await import("../persistence/json-store");
const conversations = await import("../conversations");
const { getConversationMeta } = await import("../conversations/read-queries");
const { configureWorkingSet } = await import("../conversations/working-set");
const { generateAnswer } = await import("../conversations/orchestrator");
const { generating } = await import("../conversations/generation-state");
const { clearMessageQueue, isQueueHeldByInterrupt, queueLength } = await import("../conversations/message-queue");
const { createWorkspace, deleteWorkspace } = await import("../workspace");
const { defaultState } = await import("../app-config/defaults");
const { defaultAssistant } = await import("../assistants");
const { model, provider } = await import("../model-providers");
const { startFakeOpenAiSse } = await import("../test-utils/fake-openai-sse");
const { __resetPairingRateLimitForTest, issuePairingCode } = await import("./pairing");
const { formatReplyForIm, ImRuntime } = await import("./runtime");

const USER = { userId: "u1", displayName: "小明" };

function makePort(sent: string[]): ImPort {
  return {
    platform: "qq",
    logPrefix: "[test]",
    textLimit: 1000,
    sendText: async (_chatId, text) => {
      sent.push(text);
    },
  };
}

function inbound(overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    chatId: "c1",
    userId: USER.userId,
    displayName: USER.displayName,
    dedupKey: `m-${crypto.randomUUID()}`,
    text: "你好",
    ...overrides,
  };
}

/** 已配对用户的配置:白名单直接写死,省去每个用例先兑换一次码。 */
function pairedConfig(): ImAccessConfig {
  const base = defaultImAccess();
  return {
    ...base,
    qq: { ...base.qq, pairedUsers: [{ userId: USER.userId, displayName: USER.displayName, pairedAt: 1 }] },
  };
}

function makeRuntime(config: ImAccessConfig, sent: string[]) {
  let current = config;
  const runtime = new ImRuntime(makePort(sent), {
    getConfig: () => current,
    updateConfig: (next) => {
      current = next;
    },
  });
  return { runtime, config: () => current };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function installFakeProvider(turns: Parameters<typeof startFakeOpenAiSse>[0]) {
  const server = await startFakeOpenAiSse(turns);
  const ourModel = model("fake-model", "IM Test");
  const ourProvider = provider({
    id: crypto.randomUUID(),
    name: "IM Test Provider",
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
  next.settings.fastModelId = "";
  setState(next as State);
  return server;
}

async function openConversation(runtime: ImRuntimeInstance, config: () => ImAccessConfig, chatId = "c1"): Promise<string> {
  await runtime.handleInbound(inbound({ text: "/new", chatId }));
  const conversationId = config().chats.find((chat) => chat.chatId === chatId)?.conversationId;
  if (!conversationId) throw new Error("IM conversation was not created");
  return conversationId;
}

// 工作区绑定用例要真的建会话:活库 + working set 都指到本文件的临时 dataDir。
const db = conversations.openConversationsDb();
configureWorkingSet({
  loadConversation: (convId) => {
    const meta = getConversationMeta(db, convId);
    if (!meta) return undefined;
    meta.messages = conversations.loadConversationNodesFromDb(db, convId);
    return meta;
  },
  isGenerating: (id) => generating.has(id),
  hasSseClients: () => false,
  hasDirty: () => false,
});

beforeAll(() => {
  setState({
    settings: {
      assistants: [{ id: "a1", name: "测试助手", chatModelId: null }],
      providers: [],
      chatModelId: null,
    },
  } as unknown as State);
});

beforeEach(() => {
  __resetPairingRateLimitForTest();
});

let active: ImRuntimeInstance | null = null;
afterEach(() => {
  active?.destroy();
  active = null;
});

describe("配对闸门", () => {
  test("未配对的人发普通文本:只回提示,不建会话、不碰模型", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(defaultImAccess(), sent);
    active = runtime;

    await runtime.handleInbound(inbound());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("设置 › 网络 › 外部接入");
    expect(config().chats).toHaveLength(0);
  });

  test("未配置配对码时:提示去桌面端生成", async () => {
    const sent: string[] = [];
    const { runtime } = makeRuntime(defaultImAccess(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "ABC123" }));

    expect(sent[0]).toContain("未授权");
  });

  test("配对码错误:回「不正确」,白名单不变", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(issuePairingCode(defaultImAccess(), Date.now()).config, sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "ZZZZZZ" }));

    expect(sent[0]).toContain("配对码不正确");
    expect(config().qq.pairedUsers).toHaveLength(0);
  });

  test("配对码过期:回「已过期」", async () => {
    const sent: string[] = [];
    const base = defaultImAccess();
    const { runtime } = makeRuntime(
      { ...base, pairing: { enabled: true, code: "ABC234", expiresAt: Date.now() - 1 } },
      sent,
    );
    active = runtime;

    await runtime.handleInbound(inbound({ text: "ABC234" }));

    expect(sent[0]).toContain("已过期");
  });

  test("总开关关闭:陌生人发什么都只回「未开放配对」,不进白名单", async () => {
    const sent: string[] = [];
    const base = defaultImAccess();
    const { runtime, config } = makeRuntime(
      { ...base, pairing: { enabled: false, code: "ABC234", expiresAt: Date.now() + 60_000 } },
      sent,
    );
    active = runtime;

    await runtime.handleInbound(inbound({ text: "ABC234" }));

    expect(sent[0]).toContain("未开放配对");
    expect(config().qq.pairedUsers).toHaveLength(0);
  });

  test("正确码(大小写/空白不敏感):进白名单、码作废、提示 /help", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(issuePairingCode(defaultImAccess(), Date.now()).config, sent);
    active = runtime;
    const code = config().pairing.code!;

    await runtime.handleInbound(inbound({ text: `  ${code.toLowerCase()}  ` }));

    expect(sent[0]).toContain("配对成功");
    expect(config().qq.pairedUsers.map((u) => u.userId)).toEqual([USER.userId]);
    expect(config().pairing.code).toBeNull();
    expect(config().chats).toHaveLength(0);
  });
});

describe("指令路由", () => {
  test("/help 列出全部命令,且不建会话", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/HELP" }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/status");
    expect(sent[0]).toContain("/new");
    expect(sent[0]).toContain("/stop");
    expect(config().chats).toHaveLength(0);
  });

  test("/status 报告平台、助手与模型,且不建会话", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/status" }));

    expect(sent[0]).toContain("平台:QQ");
    expect(sent[0]).toContain("助手:测试助手");
    expect(sent[0]).toContain("模型:");
    expect(config().chats).toHaveLength(0);
  });

  test("/stop 在没有会话时直接告知,不建会话", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/stop" }));

    expect(sent[0]).toContain("无需停止");
    expect(config().chats).toHaveLength(0);
  });

  test("中文别名同样命中指令", async () => {
    const sent: string[] = [];
    const { runtime } = makeRuntime(pairedConfig(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "帮助" }));

    expect(sent[0]).toContain("/status");
  });
});

describe("工作区绑定", () => {
  function withWorkspace(config: ImAccessConfig, workspaceId: string): ImAccessConfig {
    return { ...config, qq: { ...config.qq, workspaceId } };
  }

  test("/new 把新会话建在设置的工作区里(agent 模式)", async () => {
    const workspace = createWorkspace({ type: "managed", name: "IM 工作区" });
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(withWorkspace(pairedConfig(), workspace.id), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/new" }));

    const binding = config().chats[0];
    expect(binding).toBeTruthy();
    expect(conversations.getConversation(binding.conversationId)?.workspaceId).toBe(workspace.id);
  });

  test("/status 报告已绑定的工作区", async () => {
    const workspace = createWorkspace({ type: "managed", name: "状态工作区" });
    const sent: string[] = [];
    const { runtime } = makeRuntime(withWorkspace(pairedConfig(), workspace.id), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/status" }));

    expect(sent[0]).toContain(`工作区:已绑定「${workspace.name}」`);
  });

  test("未绑定工作区:新会话是纯聊天", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/new" }));
    await runtime.handleInbound(inbound({ text: "/status" }));

    const binding = config().chats[0];
    expect(conversations.getConversation(binding.conversationId)?.workspaceId).toBeNull();
    expect(sent[1]).toContain("工作区:纯聊天(未绑定工作区)");
  });

  test("设置里的工作区已被删除:退回纯聊天,状态里说明原因", async () => {
    const workspace = createWorkspace({ type: "managed", name: "待删工作区" });
    deleteWorkspace(workspace.id);
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(withWorkspace(pairedConfig(), workspace.id), sent);
    active = runtime;

    await runtime.handleInbound(inbound({ text: "/new" }));
    await runtime.handleInbound(inbound({ text: "/status" }));

    const binding = config().chats[0];
    expect(conversations.getConversation(binding.conversationId)?.workspaceId).toBeNull();
    expect(sent[1]).toContain("工作区:设置里的工作区已不存在");
  });
});

describe("输出模式(纯文本去 Markdown)", () => {
  const raw = "## 标题\n**加粗**和(*/ω＼*) 🎉";

  test("平台开了纯文本输出:发出去的回复去掉 Markdown,颜文字/emoji 保留", () => {
    const config = defaultImAccess();
    expect(config.qq.plainText).toBe(true);

    expect(formatReplyForIm(config, "qq", raw)).toBe("标题\n加粗和(*/ω＼*) 🎉");
  });

  test("关掉后原样发送;两个平台互不影响", () => {
    const base = defaultImAccess();
    const config = { ...base, qq: { ...base.qq, plainText: false } };

    expect(formatReplyForIm(config, "qq", raw)).toBe(raw);
    // 微信仍是默认的纯文本。
    expect(formatReplyForIm(config, "wechat", raw)).toBe("标题\n加粗和(*/ω＼*) 🎉");
  });
});

describe("生成中停止与等待终态", () => {
  test("/stop 在普通问答生成期间立即执行,不等待回答结束", async () => {
    const hold = gate();
    const chatId = "c-stop-fast";
    const server = await installFakeProvider([{ content: "慢回答", beforeRespond: () => hold.promise }]);
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;
    let conversationId = "";
    let first = Promise.resolve();
    let stop = Promise.resolve();
    try {
      conversationId = await openConversation(runtime, config, chatId);
      first = runtime.handleInbound(inbound({ chatId, text: "开始生成" }));
      await waitUntil(() => server.requests.length >= 1);
      stop = runtime.handleInbound(inbound({ chatId, text: "/stop" }));

      await within(stop, 500, "IM /stop");
      await waitUntil(() => generating.get(conversationId)?.signal.aborted === true, 500);
      expect(sent.some((text) => text.includes("已停止本轮生成"))).toBe(true);
    } finally {
      if (conversationId) clearMessageQueue(conversationId);
      hold.release();
      await Promise.allSettled([first, stop]);
      await server.close();
      setState(priorState);
    }
  });

  test("停止后未派发的 IM 等待方结算,不会被冻结队列悬挂", async () => {
    const hold = gate();
    const chatId = "c-stop-waiter";
    const server = await installFakeProvider([{ content: "慢回答", beforeRespond: () => hold.promise }]);
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;
    let conversationId = "";
    let desktop = Promise.resolve();
    let queued = Promise.resolve();
    try {
      conversationId = await openConversation(runtime, config, chatId);
      const conversation = conversations.getConversation(conversationId);
      expect(conversation).toBeTruthy();
      desktop = generateAnswer(conversation!);
      await waitUntil(() => server.requests.length >= 1);
      queued = runtime.handleInbound(inbound({ chatId, text: "排队的话" }));
      await waitUntil(() => queueLength(conversationId) === 1);

      await within(runtime.handleInbound(inbound({ chatId, text: "/stop" })), 500, "IM /stop");
      hold.release();
      await desktop;
      await within(queued, 1_000, "IM queued waiter");

      expect(queueLength(conversationId)).toBe(0);
      expect(isQueueHeldByInterrupt(conversationId)).toBe(true);
      expect(server.requests).toHaveLength(1);
    } finally {
      if (conversationId) clearMessageQueue(conversationId);
      hold.release();
      await Promise.allSettled([desktop, queued]);
      await server.close();
      setState(priorState);
    }
  });

  test("生成失败后未派发的 IM 等待方同样结算", async () => {
    const hold = gate();
    const chatId = "c-fail-waiter";
    const server = await installFakeProvider([{
      beforeRespond: () => hold.promise,
      fail: { status: 500, message: "boom" },
    }]);
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;
    let conversationId = "";
    let desktop = Promise.resolve();
    let queued = Promise.resolve();
    try {
      conversationId = await openConversation(runtime, config, chatId);
      const conversation = conversations.getConversation(conversationId);
      expect(conversation).toBeTruthy();
      desktop = generateAnswer(conversation!);
      await waitUntil(() => server.requests.length >= 1);
      queued = runtime.handleInbound(inbound({ chatId, text: "失败时排队的话" }));
      await waitUntil(() => queueLength(conversationId) === 1);

      hold.release();
      await desktop;
      await within(queued, 1_000, "IM waiter after failure");

      expect(queueLength(conversationId)).toBe(0);
      expect(server.requests).toHaveLength(1);
    } finally {
      if (conversationId) clearMessageQueue(conversationId);
      hold.release();
      await Promise.allSettled([desktop, queued]);
      await server.close();
      setState(priorState);
    }
  });

  test("正常连续消息保持 FIFO", async () => {
    const chatId = "c-fifo";
    const server = await installFakeProvider([{ content: "第一答" }, { content: "第二答" }]);
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(pairedConfig(), sent);
    active = runtime;
    let conversationId = "";
    try {
      conversationId = await openConversation(runtime, config, chatId);
      const first = runtime.handleInbound(inbound({ chatId, text: "第一问" }));
      const second = runtime.handleInbound(inbound({ chatId, text: "第二问" }));
      await Promise.all([first, second]);

      expect(server.requests).toHaveLength(2);
      expect(sent.slice(-2)).toEqual(["第一答", "第二答"]);
    } finally {
      if (conversationId) clearMessageQueue(conversationId);
      await server.close();
      setState(priorState);
    }
  });
});

describe("去重与空文本", () => {
  test("同一 dedupKey 只处理一次", async () => {
    const sent: string[] = [];
    const { runtime } = makeRuntime(defaultImAccess(), sent);
    active = runtime;

    const dup = inbound({ dedupKey: "same-id" });
    await runtime.handleInbound(dup);
    await runtime.handleInbound(dup);

    expect(sent).toHaveLength(1);
  });

  test("纯空白文本不回复,也不消耗配对码", async () => {
    const sent: string[] = [];
    const { runtime, config } = makeRuntime(issuePairingCode(defaultImAccess(), Date.now()).config, sent);
    active = runtime;
    const before = config().pairing.code;

    await runtime.handleInbound(inbound({ text: "   " }));

    expect(sent).toHaveLength(0);
    expect(config().pairing.code).toBe(before);
  });
});
