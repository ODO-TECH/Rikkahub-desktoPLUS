// A1 回归(专题9复查):开启"会话级注入绑定"的助手,新会话必须从助手级播种生效集。
// 病灶:PC 会话在首条消息才创建(不提前建,防死会话),home 页的勾选只能落在助手级;
// 而 override 语义是"会话集(含空集)完全取代助手级"(对齐安卓 collectInjections),
// 不播种则新会话诞生即空集 → 用户在新聊天页的勾选静默失效。
import { describe, expect, test } from "bun:test";

import type { Assistant, Conversation, JsonValue } from "../foundation/types";
import { activePromptInjections } from "../assistants";
import { getStringArray } from "../foundation/utils";
import { seedConversationInjectionBinding } from "./helpers";

function assistant(overrides: Record<string, unknown>): Assistant {
  return { id: "a1", name: "助手", ...overrides } as unknown as Assistant;
}

function freshConversation(): Conversation {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "",
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 1,
  } as unknown as Conversation;
}

// 与 conversation-encoding.ts 的 activePromptInjections 一致的 override 构造。
function overrideOf(conversation: Conversation) {
  return {
    modeInjectionIds: getStringArray(conversation.modeInjectionIds),
    lorebookIds: getStringArray(conversation.lorebookIds),
  };
}

const MODE_INJECTIONS: JsonValue[] = [
  { id: "m1", enabled: true, content: "注入内容", position: "after_system_prompt" },
];

describe("seedConversationInjectionBinding", () => {
  test("开关开启:从助手级复制两个 id 集(含空集也显式落字段)", () => {
    const conv = freshConversation();
    seedConversationInjectionBinding(
      conv,
      assistant({ allowConversationPromptInjection: true, modeInjectionIds: ["m1"], lorebookIds: [] }),
    );
    expect(conv.modeInjectionIds).toEqual(["m1"]);
    expect(conv.lorebookIds).toEqual([]);
  });

  test("开关关闭:不落会话字段(会话级绑定不参与生成)", () => {
    const conv = freshConversation();
    seedConversationInjectionBinding(conv, assistant({ allowConversationPromptInjection: false, modeInjectionIds: ["m1"] }));
    expect(conv.modeInjectionIds).toBeUndefined();
    expect(conv.lorebookIds).toBeUndefined();
  });
});

describe("播种后的生效语义(端到端)", () => {
  const flagged = assistant({ allowConversationPromptInjection: true, modeInjectionIds: ["m1"], lorebookIds: [] });

  test("未播种的新会话:override 为空集,助手级勾选被完全取代 → 零注入(病灶形态)", () => {
    const conv = freshConversation();
    const active = activePromptInjections(flagged, [], [], MODE_INJECTIONS, overrideOf(conv));
    expect(active).toHaveLength(0);
  });

  test("播种后的新会话:home 页写在助手级的勾选经播种进入会话,注入生效", () => {
    const conv = freshConversation();
    seedConversationInjectionBinding(conv, flagged);
    const active = activePromptInjections(flagged, [], [], MODE_INJECTIONS, overrideOf(conv));
    expect(active.map((item) => item.id)).toEqual(["m1"]);
  });
});
