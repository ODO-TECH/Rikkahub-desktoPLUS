// foundation/utils 纯函数单元测试（5.5 测试补强）。
// 这些工具函数被全后端复用（parts 文本提取、模板占位符、按 id 增删排序），
// 行为契约与安卓端对齐，回归会静默破坏消息编码与设置管理。
import { describe, expect, test } from "bun:test";

import {
  applyPlaceholders,
  cloneJson,
  deleteById,
  estimateTokens,
  message,
  reasoningFromParts,
  renderTemplate,
  reorderByIds,
  safeJsonParse,
  textFromParts,
  uniqueStrings,
  upsertById,
  validateKnownJsonIds,
} from "./utils";
import type { JsonValue, MessagePart } from "./types";

describe("textFromParts", () => {
  test("拼接 text part，忽略其他类型", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "hello" },
      { type: "reasoning", reasoning: "thinking" },
      { type: "text", text: "world" },
    ];
    expect(textFromParts(parts)).toBe("hello\n\nworld");
  });

  test("容忍工具 output 的 error/pending 历史载荷", () => {
    expect(textFromParts([{ error: "boom" }, { type: "text", text: "ok" }])).toBe("ok");
    expect(textFromParts([{ pending: true, questions: [] }])).toBe("");
  });

  test("空数组返回空串", () => {
    expect(textFromParts([])).toBe("");
  });
});

describe("reasoningFromParts", () => {
  test("只取 reasoning part 并以换行拼接", () => {
    const parts: MessagePart[] = [
      { type: "reasoning", reasoning: "a" },
      { type: "text", text: "skip" },
      { type: "reasoning", reasoning: "b" },
    ];
    expect(reasoningFromParts(parts)).toBe("a\nb");
  });
});

describe("message 工厂", () => {
  test("ASSISTANT 消息带 finishedAt，USER 消息为 null", () => {
    const assistant = message("ASSISTANT", [{ type: "text", text: "hi" }]);
    expect(assistant.finishedAt).not.toBeNull();
    const user = message("USER", []);
    expect(user.finishedAt).toBeNull();
    expect(user.id).toBeTruthy();
    expect(user.annotations).toEqual([]);
  });
});

describe("applyPlaceholders / renderTemplate", () => {
  test("双花括号与单花括号都替换，未知键保留原样", () => {
    const vars = { name: "Rikka", role: "user" };
    expect(applyPlaceholders("{{ name }} / { role } / {{ missing }}", vars)).toBe("Rikka / user / {{ missing }}");
  });

  test("renderTemplate 只处理双花括号", () => {
    expect(renderTemplate("{{ name }} { name }", { name: "x" })).toBe("x { name }");
  });
});

describe("estimateTokens", () => {
  test("CJK 按 0.9/字，其他按 1/4，向上取整且至少为 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("你好")).toBe(2); // 2 * 0.9 = 1.8 → 2
  });
});

describe("按 id 的集合操作", () => {
  const items: JsonValue[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];

  test("upsertById 更新已存在的项", () => {
    const { items: next, item } = upsertById(items, { id: "a", name: "A2" });
    expect(item).toEqual({ id: "a", name: "A2" } as typeof item);
    expect(next).toEqual([{ id: "a", name: "A2" }, { id: "b", name: "B" }]);
  });

  test("upsertById 追加新项，缺 id 时自动生成", () => {
    const { items: next } = upsertById(items, { id: "c", name: "C" });
    expect(next).toHaveLength(3);
    const { item } = upsertById(items, { name: "noid" });
    expect(String(item.id)).toBeTruthy();
  });

  test("deleteById 只删匹配项", () => {
    expect(deleteById(items, "a")).toEqual([{ id: "b", name: "B" }]);
    expect(deleteById(items, "zzz")).toEqual(items);
  });

  test("reorderByIds 按给定顺序重排，未列出的排在后面", () => {
    const three: JsonValue[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderByIds(three, ["c", "a"])).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
  });

  test("validateKnownJsonIds 遇未知 id 抛错，全部已知则原样返回", () => {
    expect(validateKnownJsonIds(items, ["a", "b"], "test")).toEqual(["a", "b"]);
    expect(() => validateKnownJsonIds(items, ["a", "nope"], "test")).toThrow(/unknown id: nope/);
  });
});

describe("杂项工具", () => {
  test("uniqueStrings 去重、去空白、trim", () => {
    expect(uniqueStrings([" a ", "a", "", null, undefined, "b"])).toEqual(["a", "b"]);
  });

  test("safeJsonParse 非法 JSON 返回空对象", () => {
    expect(safeJsonParse("{\"x\":1}")).toEqual({ x: 1 });
    expect(safeJsonParse("not json")).toEqual({});
  });

  test("cloneJson 深拷贝，修改副本不影响原值", () => {
    const original = { nested: { list: [1, 2] } };
    const copy = cloneJson(original);
    copy.nested.list.push(3);
    expect(original.nested.list).toEqual([1, 2]);
  });
});
