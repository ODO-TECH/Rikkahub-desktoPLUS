// backup/subagent-export.test.ts — subagent 跨端导出契约
// ① 设置:to-android 剥离(安卓无此字段),to-pc 保留(PC→PC 换机恢复)。
// ② 工具行:dispatch part 在安卓侧无同名工具,导出时降级为摘要 text。
import { describe, expect, test } from "bun:test";
import { rewriteAvatarsInSettings } from "./export";
import { adaptSubagentToolPartForAndroid } from "./subagent-android-export";
import { defaultSubagentConfig } from "../foundation/types/settings/subagent-config";

const settings = () => ({
  subagent: { ...defaultSubagentConfig(), enabled: true, maxConcurrency: 6 },
  enableWebSearch: true,
});

describe("subagent 设置导出", () => {
  test("to-android 剥离 subagent 字段", () => {
    const out = rewriteAvatarsInSettings(settings(), {}, "to-android");
    expect("subagent" in out).toBe(false);
    expect(out.enableWebSearch).toBe(true);
  });

  test("to-pc 保留 subagent 原样", () => {
    const input = settings();
    const out = rewriteAvatarsInSettings(input, {}, "to-pc");
    expect(out.subagent).toEqual(input.subagent);
  });
});

describe("subagent 工具行导出", () => {
  const dispatchPart = () => ({
    type: "tool",
    toolName: "subagent_dispatch",
    input: JSON.stringify({
      mode: "parallel",
      tasks: [
        { title: "调研 A", prompt: "很长的子任务提示词 A" },
        { title: "调研 B", prompt: "很长的子任务提示词 B" },
      ],
    }),
    output: [
      {
        type: "text",
        text: "Subagent dispatch: 1/2 completed, 1 failed, 1234 tokens used of 200000 budget\n\n1. [OK] 调研 A\n结论 A\n2. [FAILED] 调研 B\nfailed: boom",
      },
    ],
    metadata: { subagent: { index: 0, title: "调研 A" } },
  });

  test("dispatch 行降级为 text:保留模式/任务标题/摘要首行,不残留未知工具名", () => {
    const out = adaptSubagentToolPartForAndroid(dispatchPart());
    expect(out.type).toBe("text");
    const text = String(out.text);
    expect(text).toContain("并行");
    expect(text).toContain("调研 A");
    expect(text).toContain("调研 B");
    expect(text).toContain("1/2 completed");
    expect(text).not.toContain("很长的子任务提示词");
    expect(text).not.toContain("Subagent dispatch:");
    expect(JSON.stringify(out)).not.toContain("subagent_dispatch");
  });

  test("未执行(只有任务清单)也能降级,不抛错", () => {
    const part = { ...dispatchPart(), output: [] };
    const out = adaptSubagentToolPartForAndroid(part);
    expect(out.type).toBe("text");
    expect(String(out.text)).toContain("调研 A");
  });

  test("非 dispatch 工具行原样返回(对象引用不变)", () => {
    const part = { type: "tool", toolName: "read", input: "{}", output: [] };
    expect(adaptSubagentToolPartForAndroid(part)).toBe(part);
  });
});
