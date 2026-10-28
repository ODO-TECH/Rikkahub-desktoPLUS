// subagent 工具卡形态锁:计划(派工时可见) + 终局摘要(内核 formatSummary 格式) + 错误兜底。
// 子过程文本不进父消息是内核纪律,这里只锁本卡对两种输入的展示口径。
import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentDispatchPart } from "~/components/message/parts/subagent-tool-part";
import type { ToolPart } from "~/types";
import i18n from "~/i18n";

const PLAN = {
  mode: "parallel",
  tasks: [
    { title: "调研 A", prompt: "看看 A 的现状" },
    { title: "调研 B", prompt: "看看 B 的现状", model_id: "cheap/model-x" },
  ],
};

const SUMMARY = [
  "Subagent dispatch: 2/2 completed, 1234 tokens used of 200000 budget",
  "",
  "1. [OK] 调研 A (600 tokens)",
  "A 的结论第一行",
  "",
  "2. [OK] 调研 B (634 tokens)",
  "B 的结论",
].join("\n");

function tool(input: unknown, output: ToolPart["output"] = []): ToolPart {
  return {
    type: "tool",
    toolCallId: "tc-dispatch",
    toolName: "subagent_dispatch",
    input: JSON.stringify(input),
    output,
    approvalState: { type: "auto" },
  };
}

function render(part: ToolPart, loading = false): string {
  return renderToStaticMarkup(
    React.createElement(SubagentDispatchPart, {
      tool: part,
      loading,
      messageCreatedAt: new Date(0).toISOString(),
      messageFinishedAt: null,
      isFirst: true,
      isLast: true,
    }),
  );
}

describe("subagent 派遣卡", () => {
  test("运行中:显示模式、任务清单与运行提示,不渲染终局摘要", () => {
    const html = render(tool(PLAN), true);
    expect(html).toContain(i18n.t("message:tool_part.subagent_running", { count: 2 }));
    expect(html).toContain(i18n.t("message:tool_part.subagent_mode_parallel"));
    expect(html).toContain("调研 A");
    expect(html).toContain("看看 A 的现状");
    expect(html).toContain("cheap/model-x");
    expect(html).toContain(i18n.t("message:tool_part.subagent_running_hint"));
    expect(html).not.toContain(i18n.t("message:tool_part.subagent_tokens", { spent: 1234, budget: 200000 }));
  });

  test("完成:头部计数、token 用量、逐任务摘要正文", () => {
    const html = render(tool(PLAN, [{ type: "text", text: SUMMARY }]));
    expect(html).toContain(i18n.t("message:tool_part.subagent_done", { completed: 2, total: 2 }));
    expect(html).toContain(i18n.t("message:tool_part.subagent_tokens", { spent: 1234, budget: 200000 }));
    expect(html).toContain("调研 A");
    expect(html).toContain("A 的结论第一行");
    expect(html).toContain("B 的结论");
    // 原始摘要头不进卡片正文(只解析成结构化行)。
    expect(html).not.toContain("Subagent dispatch:");
    expect(html).not.toContain(i18n.t("message:tool_part.subagent_running_hint"));
  });

  test("失败:错误载荷原文展示,图标走警示色", () => {
    const html = render(tool(PLAN, [{ error: "预算耗尽,剩余任务已跳过" }]));
    expect(html).toContain("预算耗尽,剩余任务已跳过");
    expect(html).toContain("lucide-circle-alert");
  });

  test("非结构化输出按原文兜底,计划损坏时仍出卡", () => {
    const html = render(tool("not-json", [{ type: "text", text: "纯文本结果" }]));
    expect(html).toContain("纯文本结果");
    expect(html).toContain(i18n.t("message:tool_part.subagent_title"));
  });
});
