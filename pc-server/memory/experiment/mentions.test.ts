// memory/experiment/mentions.test.ts — 第二轮提及计分与事件晋升
//
// 锁定：只对用户消息计分（检索 / 注入 / 助手复述不计）、同会话只计一次、
// 跨会话累加、摘要重写继承分数、热记忆保护口径、事件跨会话晋升需人工确认、
// 模型确认失败时宁可不计、实验关闭零副作用。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Assistant, Conversation, Message } from "../../foundation/types";
import type { MemoryExperimentSettings } from "../../foundation/types/settings/memory-experiment-config";
import { message } from "../../foundation/utils";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-mention-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const store = await import("../../persistence/json-store");
const { openConversationsDb } = await import("../../conversations");
openConversationsDb();
const { memoryStore, memoriesForAssistant } = await import("../index");
const { prepareDynamicRecall, readDynamicRecallBlock } = await import("../dynamic-recall");
const { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } = await import("./config");
const {
  applyEventPromotion,
  isSecondRoundMergeEligible,
  listEventPromotions,
  parseMentionConfirmation,
  planEventPromotions,
  rejectEventPromotion,
  runMentionScoringNow,
} = await import("./mentions");
const { isHotMemory } = await import("./entry");
const { getAudit, listMemoryEdges, openExperimentDb } = await import("./store");

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

function enableMention(patch: Partial<MemoryExperimentSettings> = {}): void {
  (store.state.settings as unknown as { memoryExperimentSettings: MemoryExperimentSettings })
    .memoryExperimentSettings = {
      ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
      enabled: true,
      dryRun: true,
      mentionScoring: true,
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

function conversationOf(
  id: string,
  turns: Array<[string, string, "USER" | "ASSISTANT"]>,
): Conversation {
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

function seedMemory(content: string, patch: Record<string, unknown> = {}) {
  return memoryStore.addMemory({
    scope: "global",
    content,
    source: "manual",
    kind: "habit",
    ...patch,
  } as Parameters<typeof memoryStore.addMemory>[0], false);
}

beforeEach(() => {
  store.setState({ settings: baseSettings() } as unknown as typeof store.state);
  memoryStore.clearAll();
});

afterAll(() => {
  memoryStore.clearAll();
});

describe("提及计分", () => {
  test("同一会话同一记忆只计一次；跨会话重复才继续累加", async () => {
    enableMention();
    const memory = seedMemory("用户喜欢喝绿茶", { sourceConversationId: "seed" });

    const conversation = conversationOf("conv-mention-once", [
      ["u1", "我喜欢喝绿茶", "USER"],
      ["a1", "记住了", "ASSISTANT"],
      ["u2", "还是喜欢喝绿茶", "USER"],
      ["a2", "好的", "ASSISTANT"],
      ["u3", "嗯，喜欢喝绿茶", "USER"],
    ]);
    // 同一会话连续跑三次（模拟多轮生成后的重复调度），计数保持不变。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runMentionScoringNow(conversation, assistant(), { now: 1_000 + attempt });
    }
    expect(memory.mentionCount).toBe(1);
    expect(memory.lastMentionedAt).toBe(1_000);
    expect(memory.mentionScore).toBeCloseTo(0.2, 3);

    const other = conversationOf("conv-mention-next", [["u4", "今天还是喜欢喝绿茶", "USER"]]);
    const second = await runMentionScoringNow(other, assistant(), { now: 2_000 });
    expect(second.scored).toBe(1);
    expect(memory.mentionCount).toBe(2);
    expect(memory.mentionScore).toBeGreaterThan(0.2);
  });

  test("助手复述、疑问与否定不计分；检索命中也不自我强化", async () => {
    enableMention({ dynamicRecall: true });
    const memory = seedMemory("用户喜欢喝绿茶", { sourceConversationId: "seed-2" });

    const assistantOnly = conversationOf("conv-assistant-only", [
      ["a1", "你之前说过喜欢喝绿茶", "ASSISTANT"],
    ]);
    expect((await runMentionScoringNow(assistantOnly, assistant())).status).toBe("skipped");
    expect(memory.mentionCount).toBe(0);

    const question = conversationOf("conv-question", [["u2", "我是不是说过喜欢喝绿茶？", "USER"]]);
    await runMentionScoringNow(question, assistant());
    expect(memory.mentionCount).toBe(0);

    const negation = conversationOf("conv-negation", [["u3", "我现在不喜欢喝绿茶了", "USER"]]);
    await runMentionScoringNow(negation, assistant());
    expect(memory.mentionCount).toBe(0);

    // 易变召回会命中这条记忆，但检索本身不写计分。
    const retrieval = conversationOf("conv-retrieval", [["u4", "想喝点绿茶", "USER"]]);
    await prepareDynamicRecall(retrieval, assistant());
    expect(readDynamicRecallBlock(retrieval.id, assistant(), "u4")).toContain("绿茶");
    expect(memory.mentionCount).toBe(0);
  });

  test("摘要重写继承提及分数，不因内容更新清零", () => {
    enableMention();
    const memory = seedMemory("用户喜欢喝绿茶");
    memoryStore.recordMemoryMention(memory.id, {
      mentionCount: 3,
      lastMentionedAt: 500,
      mentionScore: 0.6,
    }, false);

    memoryStore.updateMemory(memory.id, "用户喜欢喝绿茶，也常喝红茶", "ai");
    expect(memory.mentionCount).toBe(3);
    expect(memory.lastMentionedAt).toBe(500);
    expect(memory.mentionScore).toBe(0.6);
    expect(memoryStore.exportFlatWithExperiment().find((item) => item.id === memory.id)?.mentionScore).toBe(0.6);
  });

  test("模型确认失败时本轮全部不计分（不退回猜测）", async () => {
    enableMention({ llmAssist: true });
    const memory = seedMemory("用户喜欢喝绿茶");
    const conversation = conversationOf("conv-model-fail", [["u1", "我喜欢喝绿茶", "USER"]]);
    const result = await runMentionScoringNow(conversation, assistant());
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("model_confirmation_failed");
    expect(result.confirmedBy).toBe("failed");
    expect(memory.mentionCount).toBe(0);
  });

  test("模型确认结果只接受候选内 id", () => {
    expect(parseMentionConfirmation('{"confirmed":[1,999,"x",1]}', [1, 2])).toEqual([1]);
    expect(parseMentionConfirmation("not json", [1])).toEqual([]);
    expect(parseMentionConfirmation('{"confirmed":"1"}', [1])).toEqual([]);
  });

  test("实验关闭时零副作用", async () => {
    const memory = seedMemory("用户喜欢喝绿茶");
    const conversation = conversationOf("conv-disabled", [["u1", "我喜欢喝绿茶", "USER"]]);
    const result = await runMentionScoringNow(conversation, assistant());
    expect(result.status).toBe("disabled");
    expect(memory.mentionCount).toBe(0);
    expect(planEventPromotions().created).toBe(0);
  });
});

describe("事件 → 习惯晋升", () => {
  test("跨会话同类事件生成待确认提案；试运行禁止执行，批准后只改目标分类", () => {
    enableMention();
    const older = seedMemory("上周和朋友去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-promo-a",
      updatedAt: 1_000,
    });
    const newer = seedMemory("今天下午又去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-promo-b",
      updatedAt: 2_000,
    });

    const plan = planEventPromotions();
    expect(plan.created).toBe(1);
    const [proposal] = listEventPromotions("proposed");
    expect(proposal).toBeDefined();
    expect(proposal!.targetId).toBe(newer.id);
    expect([...proposal!.memberIds].sort()).toEqual([older.id, newer.id].sort());
    expect(proposal!.sourceConversationIds.sort()).toEqual(["conv-promo-a", "conv-promo-b"]);

    expect(() => applyEventPromotion(proposal!.auditId)).toThrow(/试运行/);
    expect(newer.kind).toBe("event");

    enableMention({ dryRun: false });
    const applied = applyEventPromotion(proposal!.auditId);
    expect(applied.toKind).toBe("habit");
    expect(newer.kind).toBe("habit");
    expect(older.kind).toBe("event");

    const db = openExperimentDb();
    expect(getAudit(db!, proposal!.auditId)?.status).toBe("applied");
    const edges = listMemoryEdges(db!, { targetId: newer.id, kind: "related" });
    expect(edges.some((edge) => edge.sourceId === older.id)).toBe(true);

    // 已应用的提案不能重复执行；拒绝同样只动审计。
    expect(() => applyEventPromotion(proposal!.auditId)).toThrow(/applied/);
  });

  test("同会话重复事件不晋升；拒绝后同签名提案不再冒出来", () => {
    enableMention();
    seedMemory("上午喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-same",
      updatedAt: 1_000,
    });
    seedMemory("下午又喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-same",
      updatedAt: 2_000,
    });
    expect(planEventPromotions().created).toBe(0);

    seedMemory("昨天喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-other",
      updatedAt: 3_000,
    });
    expect(planEventPromotions().created).toBe(1);
    const [proposal] = listEventPromotions("proposed");
    rejectEventPromotion(proposal!.auditId);
    expect(planEventPromotions().created).toBe(0);
  });

  test("受保护目标在批准时被拒绝，绝不降级保护记忆", () => {
    enableMention({ dryRun: false });
    const older = seedMemory("上周喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-protect-a",
      updatedAt: 2_000,
    });
    const newer = seedMemory("今天也喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      sourceConversationId: "conv-protect-b",
      updatedAt: 3_000,
    });
    expect(planEventPromotions().created).toBe(1);
    const [proposal] = listEventPromotions("proposed");
    expect(proposal).toBeDefined();
    expect(proposal!.targetId).toBe(newer.id);

    // 提案生成后用户把目标改为「明确记住」：批准必须拒绝，而不是把保护降级。
    memoryStore.updateMemory(newer.id, newer.content, "manual", { explicitRemember: true });
    expect(() => applyEventPromotion(proposal!.auditId)).toThrow(/受保护/);
    expect(newer.kind).toBe("event");
    expect(newer.explicitRemember).toBe(true);
    expect(older.kind).toBe("event");
  });

  test("热事件不进入第二轮跨事件合并；热记忆阈值按计数", () => {
    enableMention();
    const event = seedMemory("上周喝了咖啡", { kind: "event" });
    event.mentionCount = 2;
    expect(isHotMemory(event, 2)).toBe(true);
    expect(isHotMemory(event, 5)).toBe(false);
    expect(isSecondRoundMergeEligible(event, 2)).toBe(false);

    event.mentionCount = 1;
    expect(isSecondRoundMergeEligible(event, 2)).toBe(true);

    const protectedEvent = seedMemory("用户明确要记住的咖啡事件", {
      kind: "event",
      explicitRemember: true,
    });
    protectedEvent.mentionCount = 9;
    expect(isSecondRoundMergeEligible(protectedEvent, 2)).toBe(false);
    expect(memoriesForAssistant(assistant()).length).toBeGreaterThan(0);
  });
});
