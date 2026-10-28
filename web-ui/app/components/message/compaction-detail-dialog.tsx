import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { CopyButton } from "~/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { CompactionAnchorInfo, CompactionPreviewMessage } from "~/lib/compaction";

/** 压缩详情卡:把"上下文已压缩"从一条不可解释的线变成可查状态——
 *  哪段原文被摘要、模型从哪条消息继续逐字读、摘要多长、这次压缩净省多少。
 *  数据全部来自 conversation.engineCompactions(PC 自有记录),不额外请求后端。 */
export function CompactionDetailDialog({
  info,
  onOpenChange,
}: {
  info: CompactionAnchorInfo | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("page");
  const { t: tMessage } = useTranslation("message");
  const record = info?.record ?? null;
  const time = record?.createdAt ? formatCompactionTime(record.createdAt) : null;
  const summaryDelta = info ? info.summaryTokens - info.previousSummaryTokens : 0;
  // 本次压缩对有效上下文的净影响:被摘要吸收的原文 − 摘要自身的增量。
  // 二次浓缩导致摘要变短时 delta 为负,净减少会大于原文量(上一版摘要也缩了),口径仍成立。
  const netSaved = info ? info.record.tokensBefore - summaryDelta : 0;

  return (
    <Dialog open={info !== null} onOpenChange={onOpenChange}>
      {/* 头部/底部固定、正文单独滚动:摘要再长也只会撑出内部滚动条,不会盖住
          "保留说明"和关闭按钮(原生 ScrollArea 在固定高度里不裁内容,已弃用)。 */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        {info ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("conversations.compaction_detail.title")}</DialogTitle>
              <DialogDescription>
                {time
                  ? t("conversations.compaction_detail.compressed_at", { time })
                  : t("conversations.compaction_detail.description")}
              </DialogDescription>
            </DialogHeader>

            <div className="-mr-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2">
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label={t("conversations.compaction_detail.tokens_before")}
                  value={`~${formatTokenCount(info.record.tokensBefore)}`}
                />
                <Stat
                  label={t("conversations.compaction_detail.summary_tokens")}
                  value={`~${formatTokenCount(info.summaryTokens)}`}
                />
                <Stat
                  label={t("conversations.compaction_detail.summary_delta")}
                  value={formatDelta(summaryDelta)}
                />
              </div>
              {netSaved > 0 && info.record.tokensBefore > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("conversations.compaction_detail.net_saved", {
                    tokens: formatTokenCount(netSaved),
                  })}
                </p>
              ) : netSaved < 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("conversations.compaction_detail.net_grew", {
                    tokens: formatTokenCount(-netSaved),
                  })}
                </p>
              ) : null}

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">
                  {t("conversations.compaction_detail.cut_anchor")}
                </h3>
                <div className="rounded-md border border-border/60 px-3 py-2">
                  <div className="text-xs text-muted-foreground">
                    {roleLabel(info.cutMessage.role, tMessage)}
                  </div>
                  <p className="mt-1 line-clamp-4 text-sm whitespace-pre-wrap break-words">
                    {messageText(info.cutMessage) ||
                      t("conversations.compaction_detail.cut_empty")}
                  </p>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {t("conversations.compaction_detail.summary_title")}
                  </h3>
                  <CopyButton
                    text={info.record.summary}
                    label={t("conversations.compaction_detail.copy_summary")}
                    copiedLabel={t("conversations.compaction_detail.copied_summary")}
                  />
                </div>
                <div className="rounded-md border border-border/60 bg-[var(--ds-surface-100)]">
                  <pre className="p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {info.record.summary}
                  </pre>
                </div>
              </section>

              <p className="text-xs text-muted-foreground">
                {t("conversations.compaction_detail.retained_note")}
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("conversations.compaction_detail.close")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[var(--ds-surface-100)] px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium text-sm tabular-nums">{value}</div>
    </div>
  );
}

function formatDelta(delta: number): string {
  if (delta === 0) return "0";
  return delta > 0 ? `+${formatTokenCount(delta)}` : `−${formatTokenCount(-delta)}`;
}

/** token 数简写:36k / 1M(与聊天消息悬停卡同一口径)。 */
function formatTokenCount(value: number): string {
  const trim = (text: string) => text.replace(/\.0$/, "");
  if (value >= 1_000_000) return `${trim((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${trim((value / 1000).toFixed(1))}k`;
  return String(value);
}

function formatCompactionTime(createdAt: string): string | null {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function messageText(message: CompactionPreviewMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function roleLabel(role: string, t: (key: string) => string): string {
  switch (role.toUpperCase()) {
    case "USER":
      return t("chat_message.md_role_user");
    case "ASSISTANT":
      return t("chat_message.md_role_assistant");
    case "SYSTEM":
      return t("chat_message.md_role_system");
    default:
      return t("chat_message.md_tool_label");
  }
}
