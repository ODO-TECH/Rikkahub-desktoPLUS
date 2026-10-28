// memory/dynamic-recall.test.ts — 实验 S9：按最新意图的易变召回块
//
// 锁定四件事：
// 1. 查询跟着最新用户消息走（长会话中途换题能召回到新话题，旧话题不残留）；
// 2. 当前问题只走 active 池，历史提问才放开过去状态并标注「可能已更新」；
// 3. 本会话产生的记忆（sourceConversationId 相同）不重复注入；
// 4. 同一消息的检索结果按代际缓存；实验关闭时编码产物逐字节不变。
// 另锁编码接入：块只贴在最新 USER 消息（chat / Responses / Google 同一处），
// 自动压缩估算包含该块。所有用例零网络（向量功能关闭）。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiMessage, Assistant, Conversation, Message } from "../foundation/types";
import type { MemoryExperimentSettings } from "../foundation/types/settings/memory-experiment-config";
import { message, textFromParts } from "../foundation/utils";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-dynamic-recall-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

// state 是活绑定：必须保留命名空间读取，解构会拿到 import 时的 undefined 快照。
const store = await import("../persistence/json-store");
const { memoryStore } = await import("./index");
const { clearDynamicRecall, clearDynamicRecallCache, prepareDynamicRecall, readDynamicRecallBlock } =
  await import("./dynamic-recall");
const { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } = await import("./experiment/config");
const { invalidateContextSnapshots } = await import("../inference-engine/context-snapshots");
const {
  conversationMessagesForApi,
  conversationResponseApiInput,
  conversationTransformedMessages,
} = await import("../inference-engine/conversation-encoding");
const { googleContentsFromApiMessages } = await import("../inference-engine/message-builder");
const { estimateAutoCompactContext } = await import("../conversations/auto-compaction");

function baseSettings(): Record<string, unknown> {
  return {
    assistants: [],
    providers: [],
    chatModelId: "m1",
    displaySetting: { userNickname: "测试用户" },
    lorebooks: [],
    modeInjections: [],
    memorySettings: { globalEnabled: true, writeStrategy: "ask" },
    memoryVectorSettings: {
      enabled: false,
      autoIndex: false,
      topK: 20,
      minMemories: 24,
      expandNeighbors: false,
      rerankEnabled: false,
      rerankTopN: 40,
    },
    memoryExperimentSettings: DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
  };
}

/** 打开实验总开关；默认同时开 statusRecall + dynamicRecall。 */
function enableExperiment(patch: Partial<MemoryExperimentSettings> = {}): void {
  (store.state.settings as unknown as { memoryExperimentSettings: MemoryExperimentSettings })
    .memoryExperimentSettings = {
      ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
      enabled: true,
      dryRun: true,
      statusRecall: true,
      dynamicRecall: true,
      ...patch,
    };
}

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "a1",
    chatModelId: null,
    name: "Test Assistant",
    systemPrompt: "You are helpful.",
    temperature: null,
    topP: null,
    contextMessageLimit: 0,
    streamOutput: true,
    enableMemory: true,
    useGlobalMemory: false,
    enableRecentChatsReference: false,
    messageTemplate: "{{ message }}",
    presetMessages: [],
    quickMessageIds: [],
    regexes: [],
    reasoningLevel: "AUTO",
    maxTokens: null,
    customHeaders: [],
    customBodies: [],
    mcpServers: [],
    mcpToolOverrides: {},
    localTools: [],
    background: null,
    backgroundOpacity: 1,
    modeInjectionIds: [],
    lorebookIds: [],
    enabledSkills: [],
    enableTimeReminder: false,
    allowConversationSystemPrompt: false,
    allowConversationPromptInjection: false,
    ...overrides,
  } as Assistant;
}

function msg(id: string, role: "USER" | "ASSISTANT", text: string): Message {
  const item = message(role, [{ type: "text", text }]);
  item.id = id;
  return item;
}

function conversationOf(id: string, turns: Array<[string, string, "USER" | "ASSISTANT"]>): Conversation {
  return {
    id,
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: turns.map(([messageId, text, role]) => ({
      id: `node-${messageId}`,
      selectIndex: 0,
      messages: [msg(messageId, role, text)],
    })),
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 2,
    modeInjectionIds: [],
    lorebookIds: [],
    workspaceId: null,
    workspaceCwd: null,
    engineCompactions: null,
  } as unknown as Conversation;
}

function lastUser(conversation: Conversation): string {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const node = conversation.messages[index]!;
    const selected = node.messages[node.selectIndex] ?? node.messages[0];
    if (selected?.role === "USER") return selected.id;
  }
  return "";
}

/** 把 ApiMessage.content（string | parts 数组）拉平成纯文本，便于断言。 */
function apiText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = part as Record<string, unknown>;
      return String(record.text ?? record.content ?? "");
    })
    .join("");
}

beforeEach(() => {
  store.setState({ settings: baseSettings() } as unknown as typeof store.state);
  memoryStore.clearAll();
  clearDynamicRecallCache();
  invalidateContextSnapshots();
});

afterAll(() => {
  memoryStore.clearAll();
  clearDynamicRecallCache();
  invalidateContextSnapshots();
});

describe("按最新意图检索", () => {
  test("长会话中途换题：只召回新话题相关的记忆，旧召回声不残留", async () => {
    enableExperiment();
    memoryStore.addMemory({ scope: "global", content: "用户喜欢喝乌龙茶，尤其是铁观音", source: "manual" }, false);
    memoryStore.addMemory({ scope: "global", content: "用户的 TypeScript 项目使用 Bun 作为运行时", source: "manual" }, false);

    const changed = conversationOf("conv-topic", [
      ["u1", "推荐几款适合下午喝的乌龙茶", "USER"],
      ["a1", "铁观音、凤凰单丛都不错。", "ASSISTANT"],
      ["u2", "TypeScript 项目怎么组织模块比较清晰", "USER"],
    ]);
    await prepareDynamicRecall(changed, assistant());
    const changedBlock = readDynamicRecallBlock(changed.id, assistant(), lastUser(changed));
    expect(changedBlock).toContain("<related_memories>");
    expect(changedBlock).toContain("TypeScript");
    expect(changedBlock).not.toContain("乌龙茶");
    // 块只对「当前用户消息」有效：拿上一条消息 id 读不到。
    expect(readDynamicRecallBlock(changed.id, assistant(), "u1")).toBe("");

    // 新会话问茶：恢复正常召回（不是同会话抑制，也不是查询漂移）。
    const fresh = conversationOf("conv-topic-fresh", [["u3", "推荐几款适合下午喝的乌龙茶", "USER"]]);
    await prepareDynamicRecall(fresh, assistant());
    const freshBlock = readDynamicRecallBlock(fresh.id, assistant(), "u3");
    expect(freshBlock).toContain("乌龙茶");
    expect(freshBlock).not.toContain("TypeScript");
  });

  test("当前问题不注入过去状态；历史提问才放开并标注「过去，可能已更新」", async () => {
    enableExperiment();
    const active = memoryStore.addMemory({ scope: "global", content: "现在喜欢帕秋莉", source: "manual" }, false);
    const superseded = memoryStore.addMemory({ scope: "global", content: "以前喜欢蕾米莉亚", source: "manual" }, false);
    memoryStore.setMemoryStatuses([{ id: superseded.id, status: "superseded" }], false);

    const current = conversationOf("conv-now", [["u-now", "我现在喜欢谁", "USER"]]);
    await prepareDynamicRecall(current, assistant());
    const currentBlock = readDynamicRecallBlock(current.id, assistant(), "u-now");
    expect(currentBlock).toContain("现在喜欢帕秋莉");
    expect(currentBlock).not.toContain("蕾米莉亚");

    const past = conversationOf("conv-past", [["u-past", "我以前喜欢谁", "USER"]]);
    await prepareDynamicRecall(past, assistant());
    const pastBlock = readDynamicRecallBlock(past.id, assistant(), "u-past");
    expect(pastBlock).toContain("以前喜欢蕾米莉亚");
    expect(pastBlock).toContain("[过去，可能已更新]");
    // active 条目本身不是这个问题的答案（只共享「喜欢」这个虚词），不应抢位。
    expect(pastBlock).not.toContain("现在喜欢帕秋莉");
    expect(active.status).toBe("active");
  });

  test("本会话来源不重复注入；换到新会话恢复正常召回", async () => {
    enableExperiment();
    memoryStore.addMemory({
      scope: "global",
      content: "上周去吃了肯德基",
      source: "ai",
      sourceConversationId: "conv-own",
      sourceCutMessageId: "cut-1",
    }, false);
    memoryStore.addMemory({
      scope: "global",
      content: "上周去吃了麦当劳",
      source: "ai",
      sourceConversationId: "conv-other",
    }, false);

    const own = conversationOf("conv-own", [["u-own", "上周去吃了什么", "USER"]]);
    await prepareDynamicRecall(own, assistant());
    const ownBlock = readDynamicRecallBlock(own.id, assistant(), "u-own");
    expect(ownBlock).toContain("麦当劳");
    expect(ownBlock).not.toContain("肯德基");

    const fresh = conversationOf("conv-fresh", [["u-fresh", "上周去吃了什么", "USER"]]);
    await prepareDynamicRecall(fresh, assistant());
    expect(readDynamicRecallBlock(fresh.id, assistant(), "u-fresh")).toContain("肯德基");
  });

  test("同一消息命中缓存；显式失效后才按新记忆重建", async () => {
    enableExperiment();
    const green = memoryStore.addMemory({ scope: "global", content: "用户喜欢喝绿茶", source: "manual" }, false);
    const conv = conversationOf("conv-cache", [["u-cache", "推荐点绿茶", "USER"]]);
    await prepareDynamicRecall(conv, assistant());
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-cache")).toContain("绿茶");

    // 记忆变了，但同一轮同一消息必须复用缓存（工具循环/重编码不重复计费）。
    memoryStore.updateMemory(green.id, "用户喜欢喝绿茶，也常喝红茶");
    await prepareDynamicRecall(conv, assistant());
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-cache")).toContain("绿茶");
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-cache")).not.toContain("红茶");

    clearDynamicRecall(conv.id);
    await prepareDynamicRecall(conv, assistant());
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-cache")).toContain("红茶");
  });
});

describe("编码接入与回退", () => {
  test("实验关闭：带不带 dynamicRecall 选项都逐字节一致", async () => {
    memoryStore.addMemory({ scope: "global", content: "用户喜欢喝乌龙茶", source: "manual" }, false);
    const conv = conversationOf("conv-off", [
      ["u-off", "推荐点茶", "USER"],
      ["a-off", "好的。", "ASSISTANT"],
    ]);
    const plain = conversationTransformedMessages(conv, assistant());
    const flagged = conversationTransformedMessages(conv, assistant(), { dynamicRecall: true });
    // 逐条比角色 + 文本（合成消息的 id/时间戳每次装配都新生成，与回退语义无关）。
    const shape = (messages: Message[]) =>
      messages.map((item) => ({ role: item.role, text: textFromParts(item.parts) }));
    expect(shape(flagged.messages)).toEqual(shape(plain.messages));
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-off")).toBe("");

    const apiPlain = conversationMessagesForApi(conv, assistant(), true, false);
    const apiFlagged = conversationMessagesForApi(conv, assistant(), true, true);
    expect(apiFlagged).toEqual(apiPlain);
  });

  test("块只贴最新 USER：chat-completions / Responses / Google 都从同一处带上", async () => {
    enableExperiment();
    memoryStore.addMemory({ scope: "global", content: "用户喜欢喝乌龙茶", source: "manual" }, false);
    const conv = conversationOf("conv-encode", [
      ["u-old", "早上好", "USER"],
      ["a-old", "早上好。", "ASSISTANT"],
      ["u-encode", "推荐几款适合下午喝的乌龙茶", "USER"],
    ]);
    await prepareDynamicRecall(conv, assistant());

    const transformed = conversationTransformedMessages(conv, assistant(), { dynamicRecall: true });
    const userMessages = transformed.messages.filter((item) => item.role === "USER");
    const lastUserMessage = userMessages[userMessages.length - 1]!;
    expect(lastUserMessage.id).toBe("u-encode");
    expect(JSON.stringify(lastUserMessage.parts)).toContain("<related_memories>");
    // 旧用户消息和 system 面都不该出现召回块。
    expect(JSON.stringify(userMessages[0]!.parts)).not.toContain("<related_memories>");
    expect(JSON.stringify(transformed.messages.find((item) => item.role === "SYSTEM") ?? {})).not.toContain("<related_memories>");

    const chatApi = conversationMessagesForApi(conv, assistant(), true, true);
    const lastChat = chatApi[chatApi.length - 1]!;
    expect(lastChat.role).toBe("user");
    expect(apiText(lastChat.content)).toContain("<related_memories>");
    expect(apiText(lastChat.content)).toContain("乌龙茶");

    const responses = conversationResponseApiInput(conv, assistant(), true);
    const lastInput = responses[responses.length - 1]!;
    expect(lastInput.role).toBe("user");
    expect(apiText(lastInput.content)).toContain("<related_memories>");

    const google = googleContentsFromApiMessages(chatApi as ApiMessage[]);
    const lastGoogle = google[google.length - 1]!;
    expect(apiText(lastGoogle.parts)).toContain("<related_memories>");
  });

  test("自动压缩估算把易变块算进上下文", async () => {
    memoryStore.addMemory({ scope: "global", content: "用户喜欢喝乌龙茶，尤其是铁观音", source: "manual" }, false);
    const conv = conversationOf("conv-estimate", [["u-est", "推荐几款适合下午喝的乌龙茶", "USER"]]);

    const offEstimate = await estimateAutoCompactContext(conv, assistant());
    enableExperiment();
    const onEstimate = await estimateAutoCompactContext(conv, assistant());
    expect(readDynamicRecallBlock(conv.id, assistant(), "u-est")).toContain("乌龙茶");
    expect(onEstimate).toBeGreaterThan(offEstimate);
  });
});
