// memory/experiment/assertions.test.ts — 结构化断言校验器的行为锁。
// 关键约束：不能因为分类词不标准就丢掉整条记忆；content 必须非空；rawContent 保留排版。
import { describe, expect, test } from "bun:test";

import {
  ASSERTION_CONTENT_MAX,
  ASSERTION_RAW_CONTENT_MAX,
  assertionFromToolArgs,
  normalizeMemoryAssertion,
} from "./assertions";

describe("结构化断言校验", () => {
  test("最小输入：只有 content", () => {
    const assertion = normalizeMemoryAssertion({ content: "  用户喜欢帕秋莉  " });
    expect(assertion.content).toBe("用户喜欢帕秋莉");
    expect(assertion.kind).toBe("unclassified");
    expect(assertion.facets).toBeNull();
    expect(assertion.explicitRemember).toBe(false);
    expect(assertion.origin).toBe("manual");
    expect(assertion.requestedScope).toBeNull();
    expect(assertion.warnings).toEqual([]);
  });

  test("content 缺失 / 空串 / 超长抛错", () => {
    expect(() => normalizeMemoryAssertion({})).toThrow("content is required");
    expect(() => normalizeMemoryAssertion({ content: "   " })).toThrow("content is required");
    expect(() => normalizeMemoryAssertion({ content: "x".repeat(ASSERTION_CONTENT_MAX + 1) })).toThrow("exceeds");
  });

  test("未知 kind 降级为 unclassified 并记 warning，而不是拒绝整条记忆", () => {
    const assertion = normalizeMemoryAssertion({ content: "偏好深色主题", kind: "preference" });
    expect(assertion.kind).toBe("unclassified");
    expect(assertion.warnings[0]).toContain("unknown kind");
  });

  test("facets 归一化；explicitRemember 接受 tool 的 snake_case", () => {
    const assertion = normalizeMemoryAssertion({
      content: "上周去上海吃火锅",
      kind: "event",
      explicit_remember: true,
      facets: { time: "上周", place: " 上海 ", event: "吃火锅", tags: ["旅行", "旅行"] },
    });
    expect(assertion.kind).toBe("event");
    expect(assertion.explicitRemember).toBe(true);
    expect(assertion.facets).toEqual({ time: "上周", place: "上海", event: "吃火锅", tags: ["旅行"] });
  });

  test("rawContent 保留换行，超长截断并记 warning", () => {
    const raw = "第一段\n第二段\n\n代码块";
    expect(normalizeMemoryAssertion({ content: "摘要", rawContent: raw }).rawContent).toBe(raw);
    const long = normalizeMemoryAssertion({ content: "摘要", rawContent: "y".repeat(ASSERTION_RAW_CONTENT_MAX + 5) });
    expect(long.rawContent?.length).toBe(ASSERTION_RAW_CONTENT_MAX);
    expect(long.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  test("scope / 幂等键 / 来源字段归一化", () => {
    const assertion = normalizeMemoryAssertion({
      content: "压缩摘要",
      origin: "compaction",
      requestedScope: "assistant",
      conversationId: " c1 ",
      sourceCutMessageId: " m42 ",
      idempotencyKey: " k1 ",
    });
    expect(assertion.origin).toBe("compaction");
    expect(assertion.requestedScope).toBe("assistant");
    expect(assertion.conversationId).toBe("c1");
    expect(assertion.sourceCutMessageId).toBe("m42");
    expect(assertion.idempotencyKey).toBe("k1");
  });

  test("工具参数适配器固定 origin=tool 并带上下文 id", () => {
    const assertion = assertionFromToolArgs(
      { content: "常用 Python", kind: "habit", explicit_remember: false },
      { conversationId: "c9", messageNodeId: "n1" },
    );
    expect(assertion.origin).toBe("tool");
    expect(assertion.conversationId).toBe("c9");
    expect(assertion.messageNodeId).toBe("n1");
    expect(assertion.kind).toBe("habit");
  });
});
