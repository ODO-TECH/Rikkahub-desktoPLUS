// components/media-studio/rewrite-model-picker.tsx — 独立媒体页的「优化提示词」模型选择栏。
// 样式复刻输入框模型胶囊;只放行带视觉输入的 CHAT 模型——纯文本模型点了弹提示、不落值,
// 因为媒体提示词改写需要模型理解参考图/多模态指令。

import * as React from "react";

import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { getModelDisplayName } from "~/lib/display";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { ProviderModel } from "~/types";
import { AIIcon } from "~/components/ui/ai-icon";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

function CheckSlot({ active }: { active: boolean }) {
  return (
    <span className="flex w-[18px] shrink-0 items-center justify-center">
      {active ? <Check className="size-4 !text-current" /> : null}
    </span>
  );
}

function isVisionModel(model: ProviderModel): boolean {
  return model.inputModalities?.includes("IMAGE") ?? false;
}

export function RewriteModelPicker() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);

  const sections = React.useMemo(() => {
    if (!settings) return [];
    return settings.providers
      .filter(
        (provider) => provider.enabled && provider.oauthStatus?.chatCapable !== false,
      )
      .map((provider) => ({
        providerId: provider.id,
        providerName: provider.name,
        models: provider.models.filter((model) => model.type === "CHAT"),
      }))
      .filter((section) => section.models.length > 0);
  }, [settings]);

  const selectedId = settings?.mediaPromptRewriteModelId ?? "";
  const selectedModel = React.useMemo(
    () => sections.flatMap((section) => section.models).find((model) => model.id === selectedId) ?? null,
    [sections, selectedId],
  );

  const handleSelect = React.useCallback(
    async (model: ProviderModel) => {
      if (!isVisionModel(model)) {
        toast.error(
          t("media_studio.rewrite_model_text_only", {
            name: getModelDisplayName(model.displayName, model.modelId),
          }),
        );
        return;
      }
      if (model.id === selectedId) return;
      try {
        await api.post("settings/default-models", { mediaPromptRewriteModelId: model.id });
        patchSettingsLocal({ mediaPromptRewriteModelId: model.id });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("media_studio.rewrite_model_save_failed"),
        );
      }
    },
    [selectedId, t],
  );

  const label = selectedModel
    ? getModelDisplayName(selectedModel.displayName, selectedModel.modelId)
    : t("media_studio.rewrite_model_select");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("media_studio.rewrite_model")}
          className="ds-icon-inherit h-8 max-w-64 shrink justify-start gap-1.5 rounded-full px-2.5 text-compact font-medium text-[var(--ds-icon)] hover:text-foreground"
        >
          <AIIcon
            name={selectedModel?.modelId ?? "auto"}
            size={16}
            className="bg-transparent"
            imageClassName="h-full w-full"
          />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {sections.length === 0 ? (
          <div className="px-[10px] py-2 text-compact text-[var(--ds-text-tertiary)]">
            {t("media_studio.rewrite_model_empty")}
          </div>
        ) : (
          sections.map((section) => (
            <DropdownMenuSub key={section.providerId}>
              <DropdownMenuSubTrigger
                data-active={section.models.some((model) => model.id === selectedId) || undefined}
              >
                <CheckSlot active={section.models.some((model) => model.id === selectedId)} />
                <span className="min-w-0 flex-1 truncate">{section.providerName}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[240px] max-w-[420px]">
                {section.models.map((model) => (
                  <DropdownMenuItem
                    key={model.id}
                    data-active={model.id === selectedId || undefined}
                    onSelect={() => void handleSelect(model)}
                  >
                    <CheckSlot active={model.id === selectedId} />
                    <AIIcon name={model.modelId} size={16} className="bg-transparent" imageClassName="h-full w-full" />
                    <span className="min-w-0 flex-1 truncate">
                      {getModelDisplayName(model.displayName, model.modelId)}
                    </span>
                    {!isVisionModel(model) ? (
                      <span className={cn("ml-auto shrink-0 text-mini text-[var(--ds-text-tertiary)]")}>
                        {t("media_studio.rewrite_model_text_tag")}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
