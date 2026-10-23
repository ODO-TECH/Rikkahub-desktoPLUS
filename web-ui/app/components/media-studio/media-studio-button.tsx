// components/media-studio/media-studio-button.tsx — 输入框的媒体生成入口。
// 与翻译一致:生成是用户主动发起的独立功能,不做会话开关、不向模型声明工具。
// 点击后把当前输入框文本交给右侧媒体工作台,并让对话模型先改写提示词。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "~/components/ui/button";
import { useOptionalWorkbench } from "~/components/workbench/workbench-context";
import { cn } from "~/lib/utils";

export interface MediaStudioButtonProps {
  /** 输入框当前文本:作为初始提示词导入侧栏。 */
  prompt: string;
  conversationId?: string | null;
  /** 新会话页的草稿 key;侧栏产出可先插入草稿,发送时随消息带给模型。 */
  draftKey?: string | null;
  disabled?: boolean;
  className?: string;
}

export const MediaStudioButton = React.memo(function MediaStudioButton({
  prompt,
  conversationId = null,
  draftKey = null,
  disabled = false,
  className,
}: MediaStudioButtonProps) {
  const { t } = useTranslation();
  const workbench = useOptionalWorkbench();
  const navigate = useNavigate();
  const text = prompt.trim();

  const open = () => {
    // 侧栏不可用(导出/分享等无工作台上下文)时落到独立页,行为保持一致。
    if (!workbench) {
      navigate("/images", { state: { prompt: text, autoOptimize: Boolean(text) } });
      return;
    }
    workbench.openPanel({
      type: "media-studio",
      title: t("media_studio.title"),
      payload: {
        prompt: text,
        autoOptimize: Boolean(text),
        kind: "image",
        conversationId,
        draftKey,
        // 每次点击都换 token:同类型面板重开时整体重挂载,导入最新输入。
        token: `${Date.now()}`,
      },
    });
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled}
      className={cn(
        "size-8 rounded-full text-[var(--ds-icon)] hover:text-foreground",
        className,
      )}
      aria-label={t("media_studio.button_title")}
      onClick={open}
    >
      <ImagePlus className="size-4" />
    </Button>
  );
});
