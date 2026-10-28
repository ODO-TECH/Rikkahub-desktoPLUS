// components/message/parts/subagent-badge.tsx — 子智能体归属徽标
//
// 子智能体内部的工具卡经 child sink 转发进父消息(pi-engine/subagent-tools.ts),形状与父
// 自己的工具卡一致;归属信息只挂在 metadata.subagent(index/title,generation-apply 合并)。
// 审批卡与链内步骤共用这一枚徽标——用户能分清"这是子任务在请求/在干活"。
// 独立成文件避免 tool-part ↔ workspace-tool-part ↔ subagent-tool-part 的循环依赖。

import { Bot } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";
import type { ToolPart as UIToolPart } from "~/types";

export interface SubagentOwner {
  index: number;
  title: string;
}

/** 读 metadata.subagent;非子任务工具卡或载荷损坏返回 null(历史消息无标记照常渲染)。 */
export function subagentOwner(tool: UIToolPart): SubagentOwner | null {
  const raw = tool.metadata?.subagent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  return { index: typeof record.index === "number" ? record.index : 0, title };
}

export function SubagentOwnerBadge({ tool, className }: { tool: UIToolPart; className?: string }) {
  const { t } = useTranslation("message");
  const owner = subagentOwner(tool);
  if (!owner) return null;
  return (
    <span
      className={cn(
        "inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-mini text-primary",
        className,
      )}
    >
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{t("tool_part.subagent_badge", { title: owner.title })}</span>
    </span>
  );
}
