import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

// 压缩边界分割线:把模型的记忆边界外显——线下(往时间线更晚的方向)才是模型逐字可见
// 的原文,线上已被压缩成摘要。位置判定见 lib/compaction.ts。
// variant("cut" 现行非破坏式 / "boundary" 旧破坏式)只影响文案:前者上方原文仍可回看,
// 后者上方原文已删除。
// onOpen 仅 cut 形态提供:点开详情卡查看摘要、切点与 token 规模。旧破坏式的摘要没有
// 对应记录(原文已删),保持纯文本不可点,避免给出"还能查"的错误暗示。
export function CompactionDivider({
  variant = "boundary",
  onOpen,
}: {
  variant?: "cut" | "boundary";
  onOpen?: () => void;
}) {
  const { t } = useTranslation("page");
  const label = t(
    variant === "cut" ? "conversations.compaction_cut_divider" : "conversations.compaction_divider",
  );
  const interactive = variant === "cut" && onOpen != null;
  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3 text-muted-foreground text-xs"
      role={interactive ? "group" : "separator"}
      aria-label={label}
    >
      <span className="h-px flex-1 bg-border" />
      {interactive ? (
        <button
          type="button"
          onClick={onOpen}
          title={t("conversations.compaction_detail.open_hint")}
          aria-label={t("conversations.compaction_detail.open_hint")}
          aria-haspopup="dialog"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="select-none">{label}</span>
          <Info aria-hidden="true" className="size-3" />
        </button>
      ) : (
        <span className="shrink-0 select-none">{label}</span>
      )}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
