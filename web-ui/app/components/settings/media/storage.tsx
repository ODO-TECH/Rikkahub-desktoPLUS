// components/settings/media/storage.tsx — 媒体 › 上传与存储。
// 两个独立区块:参考素材上传桶(与备份 S3 分离)与默认媒体模型。
// 上传桶只在视频等需要公网素材地址的接口使用;不配置不影响纯文本生图。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import {
  PasswordInput,
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { patchSettingsLocal } from "~/lib/settings-patch";
import api from "~/services/api";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaKind,
  MediaModelRef,
  S3Config,
  Settings,
} from "~/types";

const EMPTY_S3: S3Config = {
  endpoint: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  region: "auto",
  pathStyle: true,
  items: [],
};

const NONE = "__none__";

function s3Complete(config: S3Config | null | undefined): boolean {
  if (!config) return false;
  return Boolean(
    config.bucket.trim() && config.accessKeyId.trim() && config.secretAccessKey.trim(),
  );
}

function refKey(ref: MediaModelRef | null | undefined): string {
  return ref ? `${ref.providerId}::${ref.modelId}` : NONE;
}

function parseRefKey(key: string): MediaModelRef | null {
  if (key === NONE) return null;
  const [providerId, modelId] = key.split("::");
  return providerId && modelId ? { providerId, modelId } : null;
}

interface ModelOption {
  ref: MediaModelRef;
  label: string;
}

function modelOptions(providers: MediaGenerationProviderConfig[], kind: MediaKind): ModelOption[] {
  return providers.flatMap((provider) => {
    if (!provider.apiKey.trim() || !provider.baseUrl.trim()) return [];
    return provider.models
      .filter((model: MediaGenerationModel) => model.kind === kind)
      .map((model) => ({
        ref: { providerId: provider.id, modelId: model.modelId },
        label: `${provider.name} / ${model.modelId}`,
      }));
  });
}

export function MediaStorageSection({
  settings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const stored = settings.uploadS3Config ?? EMPTY_S3;
  const [s3Draft, setS3Draft] = React.useState<S3Config>(stored);
  const [testing, setTesting] = React.useState(false);
  const [defaults, setDefaults] = React.useState<{
    image: MediaModelRef | null;
    video: MediaModelRef | null;
  }>({
    image: settings.defaultMediaImageModel ?? null,
    video: settings.defaultMediaVideoModel ?? null,
  });
  const [savingDefaults, setSavingDefaults] = React.useState(false);

  const autosave = useAutosaveDraft(
    async () => {
      const result = await api.post<{ status: string; config: S3Config }>(
        "settings/media-upload/config",
        {
          config: s3Draft,
        },
      );
      patchSettingsLocal({ uploadS3Config: result.config });
    },
    {
      onSaveError: (error) =>
        toast.error(
          error instanceof Error ? error.message : t("settings:media.storage_save_failed"),
        ),
    },
  );

  React.useEffect(() => {
    if (autosave.isDirty()) return;
    setS3Draft(settings.uploadS3Config ?? EMPTY_S3);
  }, [
    settings.uploadS3Config?.endpoint,
    settings.uploadS3Config?.region,
    settings.uploadS3Config?.bucket,
    settings.uploadS3Config?.accessKeyId,
    settings.uploadS3Config?.secretAccessKey,
    settings.uploadS3Config?.pathStyle,
  ]);

  React.useEffect(() => {
    setDefaults({
      image: settings.defaultMediaImageModel ?? null,
      video: settings.defaultMediaVideoModel ?? null,
    });
  }, [settings.defaultMediaImageModel, settings.defaultMediaVideoModel]);

  const patchS3 = (patch: Partial<S3Config>) => {
    autosave.markDirty();
    setS3Draft((current) => ({ ...current, ...patch }));
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      await autosave.saveNow({ force: true });
      await api.post("settings/media-upload/test", { config: s3Draft });
      toast.success(t("settings:media.storage_test_ok"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:media.storage_test_failed"));
    } finally {
      setTesting(false);
    }
  };

  const providers = settings.mediaGenerationProviders ?? [];
  const imageOptions = modelOptions(providers, "image");
  const videoOptions = modelOptions(providers, "video");
  const videoSelected = defaults.video !== null;
  const storageMissing = videoSelected && !s3Complete(settings.uploadS3Config);

  const saveDefaults = async (next: {
    image: MediaModelRef | null;
    video: MediaModelRef | null;
  }) => {
    const previous = defaults;
    setDefaults(next);
    setSavingDefaults(true);
    try {
      const result = await api.post<{
        status: string;
        image: MediaModelRef | null;
        video: MediaModelRef | null;
      }>("settings/media-provider/defaults", { image: next.image, video: next.video });
      patchSettingsLocal({
        defaultMediaImageModel: result.image,
        defaultMediaVideoModel: result.video,
      });
      toast.success(t("settings:media.defaults_saved"));
    } catch (error) {
      setDefaults(previous);
      toast.error(
        error instanceof Error ? error.message : t("settings:media.defaults_save_failed"),
      );
    } finally {
      setSavingDefaults(false);
    }
  };

  return (
    <div className="@container">
      <SettingsStack>
        <SettingsGroup
          title={t("settings:media.storage_title")}
          description={t("settings:media.storage_desc")}
          action={
            <AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />
          }
        >
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <SettingsField
              label={t("settings:media.endpoint_label")}
              htmlFor={`${fieldId}-endpoint`}
            >
              <Input
                id={`${fieldId}-endpoint`}
                value={s3Draft.endpoint}
                onChange={(event) => patchS3({ endpoint: event.target.value })}
                placeholder="https://s3.example.com"
              />
            </SettingsField>
            <SettingsField label={t("settings:media.region")} htmlFor={`${fieldId}-region`}>
              <Input
                id={`${fieldId}-region`}
                value={s3Draft.region}
                onChange={(event) => patchS3({ region: event.target.value })}
                placeholder="auto"
              />
            </SettingsField>
            <SettingsField label={t("settings:media.bucket")} htmlFor={`${fieldId}-bucket`}>
              <Input
                id={`${fieldId}-bucket`}
                value={s3Draft.bucket}
                onChange={(event) => patchS3({ bucket: event.target.value })}
                placeholder="rikkahub-media"
              />
            </SettingsField>
            <SettingsField label={t("settings:media.access_key_id")} htmlFor={`${fieldId}-akid`}>
              <Input
                id={`${fieldId}-akid`}
                value={s3Draft.accessKeyId}
                onChange={(event) => patchS3({ accessKeyId: event.target.value })}
              />
            </SettingsField>
            <SettingsField
              label={t("settings:media.secret_access_key")}
              htmlFor={`${fieldId}-secret`}
            >
              <PasswordInput
                id={`${fieldId}-secret`}
                value={s3Draft.secretAccessKey}
                onChange={(secretAccessKey) => patchS3({ secretAccessKey })}
              />
            </SettingsField>
          </div>
          <SettingsRows className="mt-2">
            <SettingsSwitchRow
              label={t("settings:media.path_style")}
              description={t("settings:media.path_style_desc")}
              checked={s3Draft.pathStyle}
              onCheckedChange={(pathStyle) => patchS3({ pathStyle })}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 py-3">
              <p className="text-xs text-[var(--ds-text-secondary)]">
                {t("settings:media.storage_test_desc")}
              </p>
              <Button
                type="button"
                variant="tertiary"
                size="compact"
                disabled={testing || !s3Draft.endpoint.trim() || !s3Draft.bucket.trim()}
                onClick={() => void testConnection()}
              >
                {testing ? <Loader2 className="animate-spin" /> : null}
                {t("settings:media.storage_test")}
              </Button>
            </div>
          </SettingsRows>
        </SettingsGroup>

        <SettingsGroup
          title={t("settings:media.defaults_title")}
          description={t("settings:media.defaults_desc")}
        >
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <SettingsField label={t("settings:media.default_image")}>
              <Select
                value={refKey(defaults.image)}
                disabled={savingDefaults}
                onValueChange={(value) =>
                  void saveDefaults({ ...defaults, image: parseRefKey(value) })
                }
              >
                <SelectTrigger aria-label={t("settings:media.default_image")}>
                  <SelectValue placeholder={t("settings:media.default_none")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("settings:media.default_none")}</SelectItem>
                  {imageOptions.map((option) => (
                    <SelectItem key={refKey(option.ref)} value={refKey(option.ref)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {imageOptions.length === 0 ? (
                <p className="text-xs text-[var(--ds-text-tertiary)]">
                  {t("settings:media.no_image_models")}
                </p>
              ) : null}
            </SettingsField>
            <SettingsField label={t("settings:media.default_video")}>
              <Select
                value={refKey(defaults.video)}
                disabled={savingDefaults}
                onValueChange={(value) =>
                  void saveDefaults({ ...defaults, video: parseRefKey(value) })
                }
              >
                <SelectTrigger aria-label={t("settings:media.default_video")}>
                  <SelectValue placeholder={t("settings:media.default_none")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("settings:media.default_none")}</SelectItem>
                  {videoOptions.map((option) => (
                    <SelectItem key={refKey(option.ref)} value={refKey(option.ref)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {videoOptions.length === 0 ? (
                <p className="text-xs text-[var(--ds-text-tertiary)]">
                  {t("settings:media.no_video_models")}
                </p>
              ) : null}
            </SettingsField>
          </div>
          {storageMissing ? (
            <p className="mt-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-warning-bg)] px-3 py-2 text-xs text-[var(--ds-warning)]">
              {t("settings:media.video_s3_warning")}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-[var(--ds-text-tertiary)]">
            {t("settings:media.defaults_note")}
          </p>
        </SettingsGroup>
      </SettingsStack>
    </div>
  );
}
