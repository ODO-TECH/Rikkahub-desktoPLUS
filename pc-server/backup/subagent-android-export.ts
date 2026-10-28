// backup/subagent-android-export.ts — subagent_dispatch 工具行的 PC→APP 导出降级(D7)。
// 安卓没有 subagent_dispatch(无执行链、无专用 UI)。Tool.ToolCall 对未知 toolName 有通用
// 兜底卡,不会炸解码;但把整份任务清单(含长 prompt)原样搬到移动端既吵又无操作价值。
// 导出边界降级为一行摘要 text part:模式 + 任务标题 + 内核摘要首行;PC 内部数据不动。

import { isRecord } from "../foundation/utils";

export const SUBAGENT_DISPATCH_TOOL_NAME = "subagent_dispatch";

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "string") return {};
  try {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 非 subagent 工具 part 原样返回;dispatch 行降级为纯 text(安卓已知判别符)。 */
export function adaptSubagentToolPartForAndroid(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "tool" || part.toolName !== SUBAGENT_DISPATCH_TOOL_NAME) return part;
  const input = parseInput(part.input);
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const titles = tasks
    .map((task) => (isRecord(task) && typeof task.title === "string" ? task.title.trim() : ""))
    .filter(Boolean);
  const mode = input.mode === "single" ? "单个任务" : "并行";
  const head = `[子智能体派遣 · ${mode}] ${tasks.length} 个任务${titles.length ? `：${titles.join("；")}` : ""}`;
  const output = Array.isArray(part.output) ? part.output : [];
  const summary = output.find(
    (entry): entry is { type: "text"; text: string } =>
      isRecord(entry) && entry.type === "text" && typeof entry.text === "string",
  );
  // 内核摘要首行("Subagent dispatch: X/Y completed…")已含完成数/失败数/token 用量,
  // 去掉固定前缀后直接跟在头行下;逐任务摘要正文不进移动端(主回答文本已覆盖)。
  const status = summary ? String(summary.text.split(/\r?\n/, 1)[0] ?? "").replace(/^Subagent dispatch:\s*/, "").trim() : "";
  return { type: "text", text: status ? `${head}\n${status}` : head };
}
