import { Archive, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import type { CompactionAnchorInfo } from "~/lib/compaction";

/** 时间线上的压缩结果卡(替代只有一行字的分割线)。
 *  默认折叠切点之前的原文,把"模型现在实际拿到的摘要"直接摊在时间线上——
 *  用户不用点开弹窗才能看到压缩成果。展开原文不丢数据:原文仍在本会话与搜索索引里。 */
export function CompactionSummaryCard({
  info,
  collapsed,
  hiddenCount,
  candidateCount = 0,
  onToggle,
  onOpen,
  onOpenCandidates,
}: {
  info: CompactionAnchorInfo;
  collapsed: boolean;
  hiddenCount: number;
  /** 实验开启时由调用方查询:本次压缩落进「待确认」的记忆候选数。0 不占位。 */
  candidateCount?: number;
  onToggle: () => void;
  onOpen: () => void;
  onOpenCandidates?: () => void;
}) {
  const { t } = useTranslation("page");
  return (
    <div className="my-1 rounded-xl border border-border/60 bg-[var(--ds-surface-100)] px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/85">
          <Archive aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t("conversations.compaction_card.title", { count: hiddenCount })}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground tabular-nums">
          {t("conversations.compaction_card.size", {
            before: compactTokens(info.record.tokensBefore),
            after: compactTokens(info.summaryTokens),
          })}
        </span>
        {candidateCount > 0 && onOpenCandidates ? (
          <button
            type="button"
            className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-micro text-primary transition-colors hover:bg-primary/15"
            onClick={onOpenCandidates}
          >
            {t("conversations.compaction_card.candidates", { count: candidateCount })}
          </button>
        ) : null}
        <span className="flex-1" />
        <Button
          aria-expanded={!collapsed}
          className="h-7 gap-1 px-2 text-xs"
          onClick={onToggle}
          size="sm"
          type="button"
          variant="ghost"
        >
          {collapsed ? (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-3.5" />
          )}
          {t(
            collapsed
              ? "conversations.compaction_card.expand"
              : "conversations.compaction_card.collapse",
          )}
        </Button>
      </div>

      <p className="mt-2 line-clamp-4 text-sm leading-6 whitespace-pre-wrap break-words text-foreground/85">
        {info.record.summary}
      </p>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-micro text-muted-foreground">
          {t("conversations.compaction_card.note")}
        </span>
        <Button
          className="h-auto p-0 text-xs"
          onClick={onOpen}
          size="sm"
          type="button"
          variant="link"
        >
          {t("conversations.compaction_card.detail")}
        </Button>
      </div>
    </div>
  );
}

/** token 简写,与聊天消息悬停卡、压缩详情卡同一口径。 */
function compactTokens(value: number): string {
  const trim = (text: string) => text.replace(/\.0$/, "");
  if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${trim((value / 1000).toFixed(1))}k`;
  return String(value);
}
