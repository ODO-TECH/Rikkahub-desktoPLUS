// 注入系统单元测试（5.5 测试补强）。
// 消息模板 / 正则变换 / <think> 标签抽取是与安卓对齐的用户可配置管线，
// 行为契约：无效正则静默容错（对齐 Android）、visualOnly 不参与发送侧变换、
// think 标签在输出侧拆分为 reasoning part。
import { describe, expect, test } from "bun:test";

import {
  applyInputRegexTransformParts,
  applyMessageTemplateToParts,
  applyOutputTransforms,
  applyRegexesToText,
  renderAssistantMessageTemplate,
} from "./index";
import { message } from "../foundation/utils";
import type { Assistant } from "../foundation/types";

function assistantWith(regexes: unknown[]): Assistant {
  return { regexes } as unknown as Assistant;
}

describe("renderAssistantMessageTemplate", () => {
  test("替换 message 与 role（role 转小写），空模板回退 {{ message }}", () => {
    expect(renderAssistantMessageTemplate("[{{ role }}] {{ message }}", "hi", "USER")).toBe("[user] hi");
    expect(renderAssistantMessageTemplate("", "hi", "USER")).toBe("hi");
  });
});

describe("applyMessageTemplateToParts", () => {
  test("只包装 text part，其他 part 原样保留", () => {
    const out = applyMessageTemplateToParts(
      [{ type: "text", text: "hello" }, { type: "image", url: "u" }],
      "user",
      "<{{ message }}>",
    );
    expect(out[0]).toEqual({ type: "text", text: "<hello>" });
    expect(out[1]).toEqual({ type: "image", url: "u" });
  });
});

describe("applyRegexesToText", () => {
  test("全局替换，多条正则依次应用", () => {
    const regexes = [
      { findRegex: "a", replaceString: "b" },
      { findRegex: "bb", replaceString: "c" },
    ];
    expect(applyRegexesToText("aa", regexes)).toBe("c");
  });

  test("无效正则静默跳过（对齐 Android 容错）", () => {
    const regexes = [
      { findRegex: "([", replaceString: "x" },
      { findRegex: "b", replaceString: "B" },
    ];
    expect(applyRegexesToText("ab", regexes)).toBe("aB");
  });
});

describe("applyInputRegexTransformParts（USER 侧）", () => {
  const parts = [{ type: "text" as const, text: "foo bar" }];

  test("enabled=false / visualOnly=true / scope 不含 USER 的正则不参与", () => {
    const noop = assistantWith([
      { findRegex: "foo", replaceString: "X", enabled: false, affectingScope: ["USER"] },
      { findRegex: "foo", replaceString: "X", visualOnly: true, affectingScope: ["USER"] },
      { findRegex: "foo", replaceString: "X", affectingScope: ["ASSISTANT"] },
    ]);
    expect(applyInputRegexTransformParts(parts, noop)).toEqual(parts);
  });

  test("命中 USER scope 的正则生效", () => {
    const active = assistantWith([{ findRegex: "foo", replaceString: "baz", affectingScope: ["USER"] }]);
    expect(applyInputRegexTransformParts(parts, active)).toEqual([{ type: "text", text: "baz bar" }]);
  });
});

describe("applyOutputTransforms（ASSISTANT 输出侧）", () => {
  test("<think> 标签抽取为 reasoning part，正文保留", () => {
    const msg = message("ASSISTANT", [{ type: "text", text: "<think>plan</think>answer" }]);
    applyOutputTransforms(msg, assistantWith([]));
    expect(msg.parts).toHaveLength(2);
    expect(msg.parts[0]).toMatchObject({ type: "reasoning", reasoning: "plan" });
    expect(msg.parts[1]).toMatchObject({ type: "text", text: "answer" });
  });

  test("未闭合 <think> 也被抽取（流式截断容错）", () => {
    const msg = message("ASSISTANT", [{ type: "text", text: "<think>half" }]);
    applyOutputTransforms(msg, assistantWith([]));
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toMatchObject({ type: "reasoning", reasoning: "half" });
  });

  test("ASSISTANT scope 正则作用于 text 与 reasoning", () => {
    const msg = message("ASSISTANT", [
      { type: "reasoning", reasoning: "secret plan" },
      { type: "text", text: "secret answer" },
    ]);
    applyOutputTransforms(msg, assistantWith([
      { findRegex: "secret", replaceString: "[redacted]", affectingScope: ["ASSISTANT"] },
    ]));
    expect(msg.parts[0]).toMatchObject({ reasoning: "[redacted] plan" });
    expect(msg.parts[1]).toMatchObject({ text: "[redacted] answer" });
  });

  test("非 ASSISTANT 消息不做 think 抽取", () => {
    const msg = message("USER", [{ type: "text", text: "<think>x</think>y" }]);
    applyOutputTransforms(msg, assistantWith([]));
    expect(msg.parts).toEqual([{ type: "text", text: "<think>x</think>y" }]);
  });
});
