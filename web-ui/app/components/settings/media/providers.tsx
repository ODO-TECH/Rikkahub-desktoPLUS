// components/settings/media/providers.tsx — 媒体 › 生成服务:左列表,右配置。
// 供应商类型创建后不可改(服务端同样拒绝):类型决定能力矩阵与预设地址,
// 换类型等价于换一家供应商,应新建而不是原地改。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Loader2, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import {
  clone,
  deleteRowAction,
  PasswordInput,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsListAddButton,
  SettingsListRow,
  SettingsRow,
  SettingsSplit,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { SearchInput } from "~/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { StatusBadge } from "~/components/ui/status-badge";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaGenerationProviderType,
  MediaKind,
  Settings,
} from "~/types";

const TYPE_LABEL_KEYS: Record<MediaGenerationProviderType, string> = {
  openai: "settings:media.provider_type.openai",
  aliyun: "settings:media.provider_type.aliyun",
  volcengine: "settings:media.provider_type.volcengine",
  minimax: "settings:media.provider_type.minimax",
  openrouter: "settings:media.provider_type.openrouter",
};

const PROVIDER_TYPES = Object.keys(TYPE_LABEL_KEYS) as MediaGenerationProviderType[];

interface MediaPreset {
  name: string;
  baseUrl: string;
  models: MediaGenerationModel[];
  kinds: MediaKind[];
}

/** 可用 = 有密钥 + 地址;阿里云还要求 WorkspaceId 已在地址占位处补齐。 */
function providerUsable(provider: MediaGenerationProviderConfig): boolean {
  if (!provider.apiKey.trim() || !provider.baseUrl.trim()) return false;
  if (
    provider.type === "aliyun" &&
    provider.baseUrl.includes("{WorkspaceId}") &&
    !provider.workspaceId?.trim()
  ) {
    return false;
  }
  return true;
}

export function MediaProvidersSection({
  settings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const providers = settings.mediaGenerationProviders ?? [];
  const [selectedId, setSelectedId] = React.useState(providers[0]?.id ?? "");
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [draft, setDraft] = React.useState<MediaGenerationProviderConfig | null>(
    selected ? clone(selected) : null,
  );
  const [presets, setPresets] = React.useState<
    Partial<Record<MediaGenerationProviderType, MediaPreset>>
  >({});
  const [saveError, setSaveError] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  // 「获取模型」拉到的上游清单:只在本次会话内存,切换供应商即清空(与聊天供应商同策略)。
  const [fetchedModels, setFetchedModels] = React.useState<MediaGenerationModel[]>([]);
  const [fetching, setFetching] = React.useState(false);
  const [fetchedFilter, setFetchedFilter] = React.useState("");

  const autosave = useAutosaveDraft(
    async () => {
      if (!draft) return;
      const result = await api.post<{ status: string; provider: MediaGenerationProviderConfig }>(
        "settings/media-provider/detail",
        draft,
      );
      setSaveError("");
      patchSettingsLocal((current) => ({
        mediaGenerationProviders: upsertById(current.mediaGenerationProviders, result.provider),
      }));
    },
    {
      onSaveError: (error) => setSaveError(error instanceof Error ? error.message : String(error)),
    },
  );

  // 预设地址/模型由服务端唯一维护(恢复默认按它回填),前端不复制一份。
  React.useEffect(() => {
    api
      .get<{ presets: Partial<Record<MediaGenerationProviderType, MediaPreset>> }>(
        "settings/media-provider/models",
      )
      .then((result) => setPresets(result.presets ?? {}))
      .catch(() => setPresets({}));
  }, []);

  const lastSelectedRef = React.useRef(selectedId);
  const providersRef = React.useRef(providers);
  providersRef.current = providers;
  React.useEffect(() => {
    const next =
      providersRef.current.find((provider) => provider.id === selectedId) ??
      providersRef.current[0];
    lastSelectedRef.current = selectedId;
    setDraft(next ? clone(next) : null);
    setSaveError("");
    setFetchedModels([]);
    setFetchedFilter("");
    autosave.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const patchDraft = (patch: Partial<MediaGenerationProviderConfig>) => {
    setSaveError("");
    autosave.markDirty();
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  // 该类型支持的媒体种类(预设由服务端下发,未加载完时按图片+视频兜底)。
  const kinds: MediaKind[] = (draft ? presets[draft.type]?.kinds : undefined) ?? ["image", "video"];

  const addProvider = async (type: MediaGenerationProviderType) => {
    if (adding) return;
    setAdding(true);
    try {
      const result = await api.post<{ status: string; provider: MediaGenerationProviderConfig }>(
        "settings/media-provider/detail",
        { type },
      );
      patchSettingsLocal((current) => ({
        mediaGenerationProviders: upsertById(current.mediaGenerationProviders, result.provider),
      }));
      setSelectedId(result.provider.id);
      toast.success(t("settings:media.added", { name: result.provider.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:media.add_failed"));
    } finally {
      setAdding(false);
    }
  };

  const deleteProviderById = async (targetId: string) => {
    const target = providers.find((provider) => provider.id === targetId);
    if (!target) return;
    if (
      !(await confirmDialog({
        title: t("settings:media.delete_confirm", { name: target.name }),
        danger: true,
      }))
    ) {
      return;
    }
    const removingActive = draft?.id === targetId;
    if (removingActive) await autosave.discard();
    try {
      await api.delete(`settings/media-provider/${encodeURIComponent(targetId)}`);
      let nextId = "";
      patchSettingsLocal((current) => {
        const next = current.mediaGenerationProviders.filter(
          (provider) => provider.id !== targetId,
        );
        nextId = next[0]?.id ?? "";
        return { mediaGenerationProviders: next };
      });
      if (removingActive) setSelectedId(nextId);
      toast.success(t("settings:media.deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:media.delete_failed"));
    }
  };

  const restoreDefaults = async () => {
    if (!draft) return;
    const preset = presets[draft.type];
    if (!preset) {
      toast.error(t("settings:media.presets_unavailable"));
      return;
    }
    if (restoring) return;
    setRestoring(true);
    try {
      if (
        !(await confirmDialog({
          title: t("settings:media.restore_confirm", { name: draft.name }),
          danger: true,
        }))
      ) {
        return;
      }
      patchDraft({ baseUrl: preset.baseUrl, models: clone(preset.models) });
    } finally {
      setRestoring(false);
    }
  };

  const addModel = () => {
    if (!draft) return;
    patchDraft({ models: [...draft.models, { modelId: "", kind: kinds[0] ?? "image" }] });
  };

  const patchModel = (index: number, patch: Partial<MediaGenerationModel>) => {
    if (!draft) return;
    patchDraft({
      models: draft.models.map((model, i) => (i === index ? { ...model, ...patch } : model)),
    });
  };

  const removeModel = (index: number) => {
    if (!draft || draft.models.length <= 1) return;
    patchDraft({ models: draft.models.filter((_, i) => i !== index) });
  };

  /** 先落草稿再拉取:服务端按 providerId 从 settings 里读配置,未保存的 Base URL / Key 它看不到。 */
  const fetchModels = async () => {
    if (!draft || fetching) return;
    if (!providerUsable(draft)) {
      toast.error(t("settings:media.fetch_needs_credentials"));
      return;
    }
    setFetching(true);
    try {
      await autosave.saveNow({ force: true });
      const result = await api.post<{ endpoint: string; models: MediaGenerationModel[] }>(
        "settings/media-provider/fetch-models",
        { providerId: draft.id },
      );
      setFetchedModels(result.models ?? []);
      setFetchedFilter("");
      toast.success(t("settings:providers.fetched_models", { count: result.models?.length ?? 0 }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:providers.fetch_failed"));
    } finally {
      setFetching(false);
    }
  };

  // 勾选清单直接读写 draft.models(与手动行同一份数据):勾上即加入,取消即移除。
  const enableFetched = (models: MediaGenerationModel[]) => {
    if (!draft || models.length === 0) return;
    const existing = new Set(draft.models.map((model) => model.modelId));
    const additions = models.filter((model) => !existing.has(model.modelId));
    if (additions.length === 0) return;
    // 手动行里那张空表(刚点「添加模型」还没填 ID)不占位:服务端保存时会丢弃,
    // 留着只会让勾选结果和行数对不上。
    const filled = draft.models.filter((model) => model.modelId.trim() !== "");
    patchDraft({ models: [...filled, ...additions] });
  };

  const disableFetched = (modelIds: Set<string>) => {
    if (!draft) return;
    const remaining = draft.models.filter((model) => !modelIds.has(model.modelId));
    if (remaining.length === draft.models.length) return;
    patchDraft({
      models: remaining.length > 0 ? remaining : [{ modelId: "", kind: kinds[0] ?? "image" }],
    });
  };

  const toggleFetchedModel = (model: MediaGenerationModel, checked: boolean) => {
    if (checked) enableFetched([model]);
    else disableFetched(new Set([model.modelId]));
  };

  const addButton = (
    <SettingsListAddButton
      label={t("settings:media.add")}
      disabled={adding}
      items={PROVIDER_TYPES.map((type) => ({
        key: type,
        label: t(TYPE_LABEL_KEYS[type]),
        onSelect: () => void addProvider(type),
      }))}
    />
  );

  if (!draft) {
    return (
      <SettingsSplit scroll list={<div className="space-y-1">{addButton}</div>}>
        <SettingsEmpty size="md" icon={<ImagePlus />}>
          {t("settings:media.empty")}
        </SettingsEmpty>
      </SettingsSplit>
    );
  }

  const typeLabel = t(TYPE_LABEL_KEYS[draft.type]);
  const usable = providerUsable(draft);
  const workspaceMissing =
    draft.type === "aliyun" &&
    draft.baseUrl.includes("{WorkspaceId}") &&
    !textValue(draft.workspaceId).trim();

  // 拉取清单的勾选态与过滤:与 模型列表 同一份 draft.models,过滤只影响可见行。
  const checkedModelIds = new Set(draft.models.map((model) => model.modelId));
  const fetchedQuery = fetchedFilter.trim().toLowerCase();
  const visibleFetched = fetchedQuery
    ? fetchedModels.filter((model) => model.modelId.toLowerCase().includes(fetchedQuery))
    : fetchedModels;
  const allFetchedChecked =
    visibleFetched.length > 0 &&
    visibleFetched.every((model) => checkedModelIds.has(model.modelId));

  return (
    <SettingsSplit
      scroll
      list={
        <div className="space-y-1">
          {addButton}
          {providers.map((provider) => (
            <SettingsListRow
              key={provider.id}
              id={provider.id}
              active={provider.id === draft.id}
              onSelect={() => setSelectedId(provider.id)}
              actions={[deleteRowAction(() => deleteProviderById(provider.id))]}
            >
              <span className="grid min-w-0 grid-cols-[10px_minmax(0,1fr)] items-center gap-2 text-left">
                <span
                  className={`size-2 rounded-full ${providerUsable(provider) ? "bg-success" : "bg-muted-foreground/40"}`}
                />
                <span className="min-w-0">
                  <span className="block truncate">{provider.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t(TYPE_LABEL_KEYS[provider.type])} ·{" "}
                    {t("settings:media.model_count", { count: provider.models.length })}
                  </span>
                </span>
              </span>
            </SettingsListRow>
          ))}
        </div>
      }
    >
      <div className="@container">
        <SettingsStack>
          <SettingsDetailHeader
            title={draft.name}
            titlePlaceholder={typeLabel}
            titleLabel={t("settings:media.name")}
            onTitleCommit={(name) => patchDraft({ name })}
            description={t("settings:media.detail_desc", { type: typeLabel })}
            action={
              <StatusBadge tone={usable ? "success" : "neutral"}>
                {usable ? t("settings:media.ready") : t("settings:media.not_ready")}
              </StatusBadge>
            }
          />

          <SettingsGroup title={t("settings:media.connection_title")} fields>
            <SettingsRow
              label={t("settings:media.type")}
              description={t("settings:media.type_immutable")}
              control={<span className="text-sm text-[var(--ds-text-secondary)]">{typeLabel}</span>}
            />
            <SettingsField
              label="Base URL"
              hint={
                workspaceMissing ? (
                  <span className="text-destructive">{t("settings:media.workspace_required")}</span>
                ) : draft.type === "aliyun" ? (
                  t("settings:media.workspace_hint")
                ) : undefined
              }
            >
              <Input
                value={textValue(draft.baseUrl)}
                onChange={(event) => patchDraft({ baseUrl: event.target.value })}
                placeholder={presets[draft.type]?.baseUrl}
              />
            </SettingsField>
            <SettingsField label="API Key">
              <PasswordInput
                value={textValue(draft.apiKey)}
                onChange={(apiKey) => patchDraft({ apiKey })}
              />
            </SettingsField>
            {draft.type === "aliyun" ? (
              <SettingsField
                label={t("settings:media.workspace_id")}
                hint={t("settings:media.workspace_id_hint")}
              >
                <Input
                  value={textValue(draft.workspaceId)}
                  onChange={(event) => patchDraft({ workspaceId: event.target.value })}
                  placeholder="ws-xxxxxxxx"
                />
              </SettingsField>
            ) : null}
          </SettingsGroup>

          <SettingsGroup
            title={t("settings:media.models_title")}
            description={t("settings:media.models_desc")}
            action={
              <>
                <Button
                  type="button"
                  variant="tertiary"
                  size="compact"
                  disabled={fetching}
                  onClick={() => void fetchModels()}
                >
                  {fetching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t("settings:providers.fetch_models")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  size="compact"
                  disabled={restoring || !presets[draft.type]}
                  onClick={() => void restoreDefaults()}
                >
                  <RotateCcw />
                  {t("settings:media.restore_defaults")}
                </Button>
              </>
            }
            fields
          >
            <SettingsField
              label={t("settings:media.model_list")}
              trailing={
                <Button type="button" size="compact" variant="tertiary" onClick={addModel}>
                  <Plus className="size-4" />
                  {t("settings:media.add_model")}
                </Button>
              }
            >
              <div className="space-y-2">
                {draft.models.map((model, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-2"
                  >
                    <Input
                      value={model.modelId}
                      onChange={(event) => patchModel(index, { modelId: event.target.value })}
                      placeholder={t("settings:media.model_id_placeholder")}
                      aria-label={t("settings:media.model_id")}
                    />
                    <Select
                      value={model.kind}
                      disabled={kinds.length <= 1}
                      onValueChange={(value) => patchModel(index, { kind: value as MediaKind })}
                    >
                      <SelectTrigger aria-label={t("settings:media.model_kind")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {kinds.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {t(`settings:media.kind.${kind}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("settings:media.remove_model")}
                      title={t("settings:media.remove_model")}
                      disabled={draft.models.length <= 1}
                      onClick={() => removeModel(index)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </SettingsField>

            {fetchedModels.length > 0 ? (
              <SettingsField
                label={t("settings:media.fetched_title")}
                hint={t("settings:media.fetched_hint")}
                trailing={
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost"
                    disabled={visibleFetched.length === 0}
                    onClick={() => {
                      if (allFetchedChecked)
                        disableFetched(new Set(visibleFetched.map((model) => model.modelId)));
                      else enableFetched(visibleFetched);
                    }}
                  >
                    {allFetchedChecked
                      ? t("settings:providers.models_deselect_all")
                      : t("settings:providers.models_select_all")}
                  </Button>
                }
              >
                <SearchInput
                  value={fetchedFilter}
                  onValueChange={setFetchedFilter}
                  placeholder={t("settings:providers.models_search_placeholder")}
                  aria-label={t("settings:providers.models_search_placeholder")}
                  clearLabel={t("settings:providers.clear_search")}
                />
                <div className="max-h-72 space-y-1 overflow-auto">
                  {visibleFetched.map((model) => {
                    const checked = checkedModelIds.has(model.modelId);
                    return (
                      <div
                        key={model.modelId}
                        role="button"
                        tabIndex={0}
                        aria-pressed={checked}
                        className="flex cursor-pointer items-center gap-3 rounded-[var(--ds-radius-md)] px-3 py-2 transition-colors duration-(--ds-duration-fast) ease-(--ds-ease-swift) hover:bg-[var(--ds-on-surface-active)]"
                        onClick={() => toggleFetchedModel(model, !checked)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleFetchedModel(model, !checked);
                          }
                        }}
                      >
                        <span onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => toggleFetchedModel(model, value === true)}
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{model.modelId}</span>
                        <StatusBadge tone="neutral">
                          {t(`settings:media.kind.${model.kind}`)}
                        </StatusBadge>
                      </div>
                    );
                  })}
                  {visibleFetched.length === 0 ? (
                    <SettingsEmpty>{t("settings:providers.models_no_match")}</SettingsEmpty>
                  ) : null}
                </div>
              </SettingsField>
            ) : null}
          </SettingsGroup>

          <SettingsDetailFooter
            status={
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <AutosaveStatusRow
                  status={autosave.status}
                  onRetry={() => void autosave.saveNow()}
                />
                {saveError ? <span className="text-xs text-destructive">{saveError}</span> : null}
              </div>
            }
          />
        </SettingsStack>
      </div>
    </SettingsSplit>
  );
}
