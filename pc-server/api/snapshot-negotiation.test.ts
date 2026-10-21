// 专题2 I-1 单测:快照协商令牌的判别力与稳定性。
// 契约:内容不变 → 令牌逐字节稳定(协商能命中);任何用户可感知的变更(updateAt、
// 标题、置顶、节点/消息/part 结构、文本长度、翻译、finishedAt)→ 令牌必变。
import { describe, expect, test } from "bun:test";

import { conversationNegotiationToken } from "./snapshot-negotiation";
import { message } from "../foundation/utils";
import type { Conversation, MessagePart } from "../foundation/types";

function conv(overrides?: Partial<Conversation>): Conversation {
  const msg = message("ASSISTANT", [{ type: "text", text: "回答内容" }]);
  msg.id = "m1";
  msg.createdAt = "t0";
  msg.finishedAt = "t1";
  return {
    id: "c1",
    assistantId: "a1",
    title: "标题",
    systemPrompt: null,
    messages: [{ id: "n1", messages: [msg], selectIndex: 0 }],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
    ...overrides,
  };
}

function mutate(fn: (c: Conversation) => void): Conversation {
  const c = conv();
  fn(c);
  return c;
}

describe("conversationNegotiationToken", () => {
  test("同一内容令牌稳定(深拷贝后逐字节一致)", () => {
    const a = conv();
    const b = JSON.parse(JSON.stringify(a)) as Conversation;
    expect(conversationNegotiationToken(a)).toBe(conversationNegotiationToken(b));
  });

  test("updateAt 变化 → 令牌变", () => {
    expect(conversationNegotiationToken(mutate((c) => { c.updateAt = 3000; })))
      .not.toBe(conversationNegotiationToken(conv()));
  });

  test("同 updateAt 下的内容变化仍可区分(同毫秒碰撞封堵)", () => {
    const base = conversationNegotiationToken(conv());
    // 文本长度变化
    expect(conversationNegotiationToken(mutate((c) => {
      (c.messages[0]!.messages[0]!.parts[0] as { text: string }).text = "回答内容更长了";
    }))).not.toBe(base);
    // 标题/置顶/系统提示词
    expect(conversationNegotiationToken(mutate((c) => { c.title = "改名"; }))).not.toBe(base);
    expect(conversationNegotiationToken(mutate((c) => { c.isPinned = true; }))).not.toBe(base);
    expect(conversationNegotiationToken(mutate((c) => { c.systemPrompt = "p"; }))).not.toBe(base);
    // 结构:新 part / 新消息版本 / selectIndex / 新节点
    expect(conversationNegotiationToken(mutate((c) => {
      c.messages[0]!.messages[0]!.parts.push({ type: "text", text: "" } as MessagePart);
    }))).not.toBe(base);
    expect(conversationNegotiationToken(mutate((c) => {
      const alt = message("ASSISTANT", [{ type: "text", text: "另一版本" }]);
      alt.id = "m2";
      c.messages[0]!.messages.push(alt);
    }))).not.toBe(base);
    expect(conversationNegotiationToken(mutate((c) => {
      c.messages.push({ id: "n2", messages: [], selectIndex: 0 });
    }))).not.toBe(base);
    // 消息级字段:翻译、finishedAt
    expect(conversationNegotiationToken(mutate((c) => {
      c.messages[0]!.messages[0]!.translation = "translated";
    }))).not.toBe(base);
    expect(conversationNegotiationToken(mutate((c) => {
      c.messages[0]!.messages[0]!.finishedAt = null;
    }))).not.toBe(base);
  });

  test("令牌以 updateAt 开头(可读性/调试)", () => {
    expect(conversationNegotiationToken(conv()).startsWith("2000:")).toBe(true);
  });
});
