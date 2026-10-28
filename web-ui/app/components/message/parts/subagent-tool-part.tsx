// components/message/parts/subagent-tool-part.tsx — subagent_dispatch 工具卡
//
// 一张卡交代一次派遣:模式 + 任务清单(计划)+ 逐任务结果(终局摘要,内核 tools/subagent.ts
// formatSummary 的固定格式,这里只做展示解析,不回写任何状态)。
// 交互纪律(与工作区动作步骤一致):运行中自动展开、终局自动收起,用户点过后以用户选择为准
// ——"变换结果就地展示、默认折叠"。子智能体的过程文本/思维链不进父消息(child sink 已过滤),
// 所以运行中这里只有一行状态 + 任务清单,不会被中间输出刷屏;子工具卡与审批卡仍按
// tool_call_created 实时出现在时间线里(带"子任务 · 标题"徽标)。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";

import Markdown from "~/components/markdown/markdown";
import { useToolElapsedSeconds } from "~/hooks/use-elapsed-since";
import { cn } from "~/lib/utils";
import type { TextPart as UITextPart, ToolPart as UIToolPart } from "~/types";

import { ControlledChainOfThoughtStep } from "../chain-of-thought";
import { SubagentOwnerBadge } from "./subagent-badge";
import { ElapsedBadge } from "./workspace-tool-part";

const OK_ICON_CLASS = "text-[oklch(0.55_0.14_150)] dark:text-[oklch(0.72_0.13_150)]";
const WARN_ICON_CLASS = "text-[oklch(0.55_0.16_60)] dark:text-[oklch(0.78_0.14_70)]";

interface DispatchTaskView {
  title: string;
  prompt: string;
  modelId?: string;
}

interface DispatchPlanView {
  mode: "single" | "parallel";
  tasks: DispatchTaskView[];
}

function parsePlan(input: string): DispatchPlanView | null {
  try {
    const parsed = JSON.parse(input || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
    const tasks: DispatchTaskView[] = rawTasks
      .filter((task): task is Record<string, unknown> => Boolean(task) && typeof task === "object" && !Array.isArray(task))
      .map((task, index) => ({
        title: typeof task.title === "string" && task.title.trim() ? task.title.trim() : `task ${index + 1}`,
        prompt: typeof task.prompt === "string" ? task.prompt : "",
        ...(typeof task.model_id === "string" && task.model_id.trim() ? { modelId: task.model_id.trim() } : {}),
      }));
    if (tasks.length === 0) return null;
    return { mode: record.mode === "parallel" ? "parallel" : "single", tasks };
  } catch {
    return null;
  }
}

interface SummaryTaskView {
  ok: boolean;
  title: string;
  body: string;
}

interface DispatchSummaryView {
  completed?: number;
  total?: number;
  failed?: number;
  spent?: number;
  budget?: number;
  tasks: SummaryTaskView[];
}

/** 解析 tools/subagent.ts formatSummary 的输出(自产格式;不匹配返回 null,原文兜底展示)。 */
function parseSummary(text: string): DispatchSummaryView | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("Subagent dispatch:")) return null;
  const lines = trimmed.split("\n");
  const head = lines[0] ?? "";
  const completed = /(\d+)\/(\d+) completed/.exec(head);
  const failed = /(\d+) failed/.exec(head);
  const budget = /(\d+) tokens used of (\d+) budget/.exec(head);
  const tasks: SummaryTaskView[] = [];
  let current: SummaryTaskView | null = null;
  for (const line of lines.slice(1)) {
    const marker = /^\d+\. \[(OK|FAILED)\] (.+)$/.exec(line);
    if (marker) {
      current = { ok: marker[1] === "OK", title: marker[2] ?? "", body: "" };
      tasks.push(current);
      continue;
    }
    if (current) current.body = current.body ? `${current.body}\n${line}` : line;
  }
  return {
    ...(completed ? { completed: Number(completed[1]), total: Number(completed[2]) } : {}),
    ...(failed ? { failed: Number(failed[1]) } : {}),
    ...(budget ? { spent: Number(budget[1]), budget: Number(budget[2]) } : {}),
    tasks,
  };
}

function errorTextOf(tool: UIToolPart): string {
  for (const part of tool.output) {
    const text = (part as { error?: unknown }).error;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

interface SubagentDispatchPartProps {
  tool: UIToolPart;
  loading?: boolean;
  messageCreatedAt?: string;
  messageFinishedAt?: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}

export function SubagentDispatchPart({
  tool,
  loading,
  messageCreatedAt,
  messageFinishedAt,
  isFirst,
  isLast,
}: SubagentDispatchPartProps) {
  const { t } = useTranslation("message");

  const plan = React.useMemo(() => parsePlan(tool.input), [tool.input]);
  const outputText = React.useMemo(
    () =>
      tool.output
        .filter((part): part is UITextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    [tool.output],
  );
  const summary = React.useMemo(() => (outputText ? parseSummary(outputText) : null), [outputText]);
  const errorText = React.useMemo(() => errorTextOf(tool), [tool.output]);

  const finished = tool.output.length > 0;
  const running = Boolean(loading) && !finished;
  const [userExpanded, setUserExpanded] = React.useState<boolean | null>(null);
  const expanded = userExpanded ?? running;
  const elapsedSeconds = useToolElapsedSeconds(tool, messageCreatedAt, messageFinishedAt, running);

  const taskCount = plan?.tasks.length ?? summary?.total ?? 0;
  const failedCount = summary?.failed ?? (errorText ? 1 : 0);
  const label = running
    ? t("tool_part.subagent_running", { count: taskCount })
    : summary && typeof summary.completed === "number"
      ? t("tool_part.subagent_done", { completed: summary.completed, total: summary.total ?? taskCount })
      : t("tool_part.subagent_title");

  const statusIcon = running ? (
    <Loader2 className="h-4 w-4 animate-spin text-primary" />
  ) : failedCount > 0 ? (
    <CircleAlert className={cn("h-4 w-4", WARN_ICON_CLASS)} />
  ) : (
    <CircleCheck className={cn("h-4 w-4", OK_ICON_CLASS)} />
  );

  return (
    <ControlledChainOfThoughtStep
      expanded={expanded}
      onExpandedChange={setUserExpanded}
      isFirst={isFirst}
      isLast={isLast}
      active={running}
      icon={statusIcon}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <SubagentOwnerBadge tool={tool} />
          <span className="text-foreground line-clamp-2 text-xs font-medium">{label}</span>
        </span>
      }
      extra={elapsedSeconds !== null ? <ElapsedBadge seconds={elapsedSeconds} running={running} /> : undefined}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-mini text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5">
            {t(plan?.mode === "parallel" ? "tool_part.subagent_mode_parallel" : "tool_part.subagent_mode_single")}
          </span>
          {taskCount > 0 ? <span>{t("tool_part.subagent_tasks_count", { count: taskCount })}</span> : null}
          {summary?.spent !== undefined && summary.budget !== undefined ? (
            <span className="tabular-nums">
              {t("tool_part.subagent_tokens", { spent: summary.spent, budget: summary.budget })}
            </span>
          ) : null}
        </div>

        {plan ? (
          <ol className="space-y-1.5">
            {plan.tasks.map((task, index) => (
              <li
                key={`${task.title}-${index}`}
                className="rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-micro tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
                  {task.modelId ? (
                    <span className="max-w-40 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
                      {task.modelId}
                    </span>
                  ) : null}
                </div>
                {task.prompt ? (
                  <p className="mt-1 line-clamp-2 pl-6 text-mini text-muted-foreground">{task.prompt}</p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {running ? (
          <p className="text-mini text-muted-foreground">{t("tool_part.subagent_running_hint")}</p>
        ) : null}

        {errorText ? (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
            {errorText}
          </pre>
        ) : null}

        {summary && summary.tasks.length > 0 ? (
          <div className="space-y-2 border-t border-border/50 pt-2">
            {summary.tasks.map((task, index) => (
              <div key={`${task.title}-${index}`} className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs">
                  {task.ok ? (
                    <CircleCheck className={cn("size-3.5 shrink-0", OK_ICON_CLASS)} />
                  ) : (
                    <CircleAlert className={cn("size-3.5 shrink-0", WARN_ICON_CLASS)} />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
                </div>
                {task.body.trim() ? (
                  <div className="rounded-md border bg-muted/20 p-2">
                    <Markdown content={task.body.trim()} className="text-xs" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : finished && outputText ? (
          <div className="rounded-md border bg-muted/20 p-2">
            <Markdown content={outputText} className="text-xs" />
          </div>
        ) : null}
      </div>
    </ControlledChainOfThoughtStep>
  );
}
