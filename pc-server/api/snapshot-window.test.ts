// snapshot-window 单测(专题2 I-2):窗口化切片、清单对齐、内容戳灵敏度/稳定性。
import { describe, expect, test } from "bun:test";

import type { Conversation, Message, MessageNode } from "../foundation/types";
import { nodeStamp, toSnapshotConversationDto } from "./snapshot-window";

function msg(id: string, text: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: "ASSISTANT",
    parts: [{ type: "text", text }],
    annotations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    modelId: null,
    usage: null,
    translation: null,
    ...overrides,
  };
}

function node(id: string, text: string): MessageNode {
  return { id, messages: [msg(`${id}-m0`, text)], selectIndex: 0 };
}

function conv(nodeCount: number): Conversation {
  return {
    id: "c1",
    assistantId: "a1",
    systemPrompt: null,
    title: "t",
    messages: Array.from({ length: nodeCount }, (_, i) => node(`n${i}`, `内容 ${i}`)),
    chatSuggestions: [],
    isPinned: false,
    createAt: 1,
    updateAt: 2,
  };
}

describe("nodeStamp", () => {
  test("同内容稳定,任何用户可见变化都换戳", () => {
    const base = node("n1", "hello");
    expect(nodeStamp(base)).toBe(nodeStamp(node("n1", "hello")));
    expect(nodeStamp(base)).not.toBe(nodeStamp(node("n1", "hello!")));
    const branch = node("n1", "hello");
    branch.messages.push(msg("n1-m1", "另一分支"));
    expect(nodeStamp(branch)).not.toBe(nodeStamp(base));
    const switched = { ...branch, selectIndex: 1 };
    expect(nodeStamp(switched)).not.toBe(nodeStamp(branch));
    const translated = node("n1", "hello");
    translated.messages[0]!.translation = "你好";
    expect(nodeStamp(translated)).not.toBe(nodeStamp(base));
  });
});

describe("toSnapshotConversationDto", () => {
  test("节点数不超窗口:messages 完整、nodesOffset=0、清单与节点一一对应", () => {
    const c = conv(5);
    const dto = toSnapshotConversationDto(c, false, 60);
    expect(dto.messages.map((n) => n.id)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    expect(dto.nodesOffset).toBe(0);
    expect(dto.nodeStamps).toHaveLength(5);
    expect(dto.nodeStamps![3]).toBe(nodeStamp(c.messages[3]!));
    expect(dto.isGenerating).toBe(false);
  });

  test("超窗:只带最近窗口个节点,清单仍覆盖全部节点", () => {
    const c = conv(10);
    const dto = toSnapshotConversationDto(c, true, 4);
    expect(dto.messages.map((n) => n.id)).toEqual(["n6", "n7", "n8", "n9"]);
    expect(dto.nodesOffset).toBe(6);
    expect(dto.nodeStamps).toHaveLength(10);
    // 清单按绝对下标对齐:窗口内第 0 个 = 绝对第 6 个
    expect(dto.nodeStamps![6]).toBe(nodeStamp(c.messages[6]!));
    expect(dto.isGenerating).toBe(true);
  });

  test("windowNodes=Infinity 退化为全量 + 清单(REST 详情路径)", () => {
    const c = conv(10);
    const dto = toSnapshotConversationDto(c, false, Infinity);
    expect(dto.messages).toHaveLength(10);
    expect(dto.nodesOffset).toBe(0);
    expect(dto.nodeStamps).toHaveLength(10);
  });

  test("其余会话字段原样透传", () => {
    const dto = toSnapshotConversationDto(conv(1), false, 60);
    expect(dto.id).toBe("c1");
    expect(dto.title).toBe("t");
    expect(dto.updateAt).toBe(2);
  });
});
