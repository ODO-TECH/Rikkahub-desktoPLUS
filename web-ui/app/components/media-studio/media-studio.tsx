// components/media-studio/media-studio.tsx — 独立媒体生成工作台。
// 对齐移动端:生成是用户主动发起的功能,不挂模型工具;图片/视频共用一套供应商配置。
// 同一个组件同时服务右侧栏与独立 /images 页,差异只在 compact 布局与插入目标。

import * as React from "react";
import { useTranslation } from "react-i18next";

import { Clapperboard, Download, ImagePlus, Loader2, Plus, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { SettingsLink } from "~/components/settings/settings-link";
import { RewriteModelPicker } from "~/components/media-studio/rewrite-model-picker";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useElapsedSeconds } from "~/hooks/use-elapsed-since";
import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { extractErrorMessage } from "~/lib/error";
import { normalizeImageForModelUpload } from "~/lib/image-normalize";
import { cn } from "~/lib/utils";
import api, { appendWebAuthQuery } from "~/services/api";
import { useChatInputStore } from "~/stores";
import { useSettingsStore } from "~/stores/app-store";
import type {
  GeneratedMediaRecord,
  MediaGenerationProviderConfig,
  MediaKind,
  MediaModelRef,
  UIMessagePart,
} from "~/types";

interface MediaCapabilityDto {
  params: string[];
  required: string[];
  imageRoles: string[];
}

type CapabilityMap = Record<string, Partial<Record<MediaKind, MediaCapabilityDto>>>;

interface UploadedMediaFile {
  id: number;
  url: string;
  fileName: string;
  mime: string;
  size: number;
}

interface ModelOption {
  ref: MediaModelRef;
  label: string;
}

interface MediaStudioProps {
  conversationId?: string | null;
  /** 新会话页没有 conversationId 时,产出插入到这份草稿。 */
  draftKey?: string | null;
  initialPrompt?: string;
  initialKind?: MediaKind;
  autoOptimize?: boolean;
  compact?: boolean;
  /** 独立 /images 页没有会话上下文,优化提示词改用工作台自选的改写模型(右侧栏版仍用对话模型)。 */
  rewritePicker?: boolean;
  className?: string;
}

const EMPTY_PROVIDERS: MediaGenerationProviderConfig[] = [];
const EMPTY_CAPABILITIES: CapabilityMap = {};

function refKey(ref: MediaModelRef | null | undefined): string {
  return ref ? `${ref.providerId}::${ref.modelId}` : "";
}

function parseRefKey(key: string): MediaModelRef | null {
  const [providerId, modelId] = key.split("::");
  return providerId && modelId ? { providerId, modelId } : null;
}

function providerReady(provider: MediaGenerationProviderConfig): boolean {
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

function modelOptions(providers: MediaGenerationProviderConfig[], kind: MediaKind): ModelOption[] {
  return providers.flatMap((provider) => {
    if (!providerReady(provider)) return [];
    return provider.models
      .filter((model) => model.kind === kind)
      .map((model) => ({
        ref: { providerId: provider.id, modelId: model.modelId },
        label: `${provider.name} / ${model.modelId}`,
      }));
  });
}

function optionExists(options: ModelOption[], ref: MediaModelRef | null | undefined): boolean {
  if (!ref) return false;
  return options.some(
    (option) => option.ref.providerId === ref.providerId && option.ref.modelId === ref.modelId,
  );
}

function s3Complete(
  config: { bucket: string; accessKeyId: string; secretAccessKey: string } | null | undefined,
): boolean {
  if (!config) return false;
  return Boolean(
    config.bucket.trim() && config.accessKeyId.trim() && config.secretAccessKey.trim(),
  );
}

function recordOutputs(record: GeneratedMediaRecord): Array<{ fileId: number; url: string }> {
  const outputs = record.outputs ?? [];
  if (outputs.length > 0) return outputs.map((item) => ({ fileId: item.fileId, url: item.url }));
  return record.fileId != null && record.url ? [{ fileId: record.fileId, url: record.url }] : [];
}

function isActiveRecord(record: GeneratedMediaRecord): boolean {
  return record.status === "queued" || record.status === "running";
}

function mergeRecords(
  current: GeneratedMediaRecord[],
  incoming: GeneratedMediaRecord[],
): GeneratedMediaRecord[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = byId.get(record.id);
    // 轮询拿到的状态总是比启动时的历史快照新；以 updatedAt 为准，旧快照
    // 不能把任务打回排队态。
    if (!existing || record.updatedAt >= existing.updatedAt) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function MediaRecordCard({
  record,
  canInsert,
  inserting,
  onCancel,
  onInsert,
}: {
  record: GeneratedMediaRecord;
  canInsert: boolean;
  inserting: boolean;
  onCancel: (record: GeneratedMediaRecord) => void;
  onInsert: (record: GeneratedMediaRecord) => void;
}) {
  const { t } = useTranslation();
  const active = isActiveRecord(record);
  const finishedAt = active ? null : new Date(record.updatedAt || record.createdAt).toISOString();
  const elapsed = useElapsedSeconds(new Date(record.createdAt).toISOString(), finishedAt, active);
  const outputs = recordOutputs(record);
  const kindLabel = t(
    record.kind === "video" ? "media_studio.kind_video" : "media_studio.kind_image",
  );

  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{record.modelId}</div>
          <div className="mt-0.5 line-clamp-2 text-mini text-muted-foreground">{record.prompt}</div>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-mini text-muted-foreground">
          {kindLabel}
        </span>
      </div>

      {active ? (
        <div className="flex flex-col items-center justify-center gap-2 bg-muted/30 px-4 py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <div className="text-xs text-muted-foreground">
            {record.status === "queued"
              ? t("media_studio.status_queued")
              : t("media_studio.status_running")}
            {elapsed !== null ? ` · ${t("media_studio.elapsed", { seconds: elapsed })}` : ""}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => onCancel(record)}>
            <X className="size-3.5" />
            {t("media_studio.cancel")}
          </Button>
        </div>
      ) : null}

      {record.status === "failed" ||
      record.status === "expired" ||
      record.status === "cancelled" ? (
        <div className="space-y-1 px-3 py-3 text-xs">
          <div className="font-medium text-destructive">
            {record.status === "cancelled"
              ? t("media_studio.status_cancelled")
              : t("media_studio.status_failed")}
          </div>
          {record.error ? (
            <div className="break-words text-muted-foreground">{record.error}</div>
          ) : null}
        </div>
      ) : null}

      {record.status === "succeeded" && outputs.length > 0 ? (
        <>
          <div className={cn("grid gap-1 p-1", outputs.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {outputs.map((output) =>
              record.kind === "video" ? (
                <video
                  key={output.fileId}
                  src={output.url}
                  controls
                  playsInline
                  className="w-full rounded-lg bg-black"
                />
              ) : (
                <a
                  key={output.fileId}
                  href={output.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg bg-muted"
                >
                  <img
                    src={output.url}
                    alt={record.prompt}
                    className="aspect-square w-full object-contain transition-transform duration-300 hover:scale-[1.02]"
                  />
                </a>
              ),
            )}
          </div>
          <div className="flex items-center justify-end gap-1 border-t px-2 py-2">
            <Button asChild type="button" variant="ghost" size="sm">
              <a href={appendWebAuthQuery(outputs[0].url)} download rel="noreferrer">
                <Download className="size-3.5" />
                {t("media_studio.download")}
              </a>
            </Button>
            {canInsert ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={inserting}
                onClick={() => onInsert(record)}
              >
                {inserting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Send className="size-3.5" />
                )}
                {t("media_studio.insert")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </article>
  );
}

export function MediaStudio({
  conversationId = null,
  draftKey = null,
  initialPrompt = "",
  initialKind = "image",
  autoOptimize = false,
  compact = false,
  rewritePicker = false,
  className,
}: MediaStudioProps) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const { currentAssistant } = useCurrentAssistant();
  // 输入框模型胶囊显示的是「当前助手」的模型；新会话页没有会话可回退，必须点名。
  const chatModelId = currentAssistant?.chatModelId || settings?.chatModelId || "";
  const providers = settings?.mediaGenerationProviders ?? EMPTY_PROVIDERS;
  const [kind, setKind] = React.useState<MediaKind>(initialKind);
  const options = React.useMemo(() => modelOptions(providers, kind), [providers, kind]);

  const defaultRefFor = React.useCallback(
    (nextKind: MediaKind): MediaModelRef | null => {
      const configured =
        nextKind === "image" ? settings?.defaultMediaImageModel : settings?.defaultMediaVideoModel;
      const nextOptions = modelOptions(providers, nextKind);
      if (optionExists(nextOptions, configured)) return configured ?? null;
      return nextOptions[0]?.ref ?? null;
    },
    [providers, settings?.defaultMediaImageModel, settings?.defaultMediaVideoModel],
  );

  const [modelKey, setModelKey] = React.useState(() => refKey(defaultRefFor(initialKind)));
  React.useEffect(() => {
    if (options.length === 0) {
      setModelKey("");
      return;
    }
    setModelKey((current) =>
      optionExists(options, parseRefKey(current)) ? current : refKey(options[0].ref),
    );
  }, [options]);

  const [prompt, setPrompt] = React.useState(initialPrompt);
  const [optimizing, setOptimizing] = React.useState(false);
  const autoOptimizedRef = React.useRef(false);

  const [references, setReferences] = React.useState<UploadedMediaFile[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [count, setCount] = React.useState("1");
  const [resolution, setResolution] = React.useState("");
  const [aspectRatio, setAspectRatio] = React.useState("");
  const [durationSeconds, setDurationSeconds] = React.useState("5");
  const [generateAudio, setGenerateAudio] = React.useState(false);

  const [records, setRecords] = React.useState<GeneratedMediaRecord[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [insertingId, setInsertingId] = React.useState<string | null>(null);
  const [capabilities, setCapabilities] = React.useState<CapabilityMap>(EMPTY_CAPABILITIES);

  React.useEffect(() => {
    let alive = true;
    api
      .get<{ capabilities?: CapabilityMap }>("settings/media-provider/models")
      .then((response) => {
        if (alive) setCapabilities(response.capabilities ?? EMPTY_CAPABILITIES);
      })
      .catch(() => {
        if (alive) setCapabilities(EMPTY_CAPABILITIES);
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    let alive = true;
    api
      .get<{ records: GeneratedMediaRecord[] }>("media/history?limit=40")
      .then((response) => {
        if (!alive) return;
        setRecords((current) => mergeRecords(current, response.records ?? []));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const selectedRef = parseRefKey(modelKey);
  const selectedProvider = selectedRef
    ? providers.find((provider) => provider.id === selectedRef.providerId)
    : undefined;
  const capability = selectedProvider ? capabilities[selectedProvider.type]?.[kind] : undefined;
  const params = React.useMemo(() => new Set(capability?.params ?? []), [capability]);
  const supportsCount = params.has("count");
  const supportsResolution = params.has("resolution");
  const supportsAspectRatio = params.has("aspectRatio");
  const supportsDuration = params.has("durationSeconds");
  const supportsAudio = params.has("generateAudio");
  const kindLabel = t(kind === "video" ? "media_studio.kind_video" : "media_studio.kind_image");

  const optimizePrompt = React.useCallback(
    async (source: string, silent = false) => {
      const text = source.trim();
      if (!text) return;
      // 独立页没有会话上下文:必须先在顶栏选好改写模型;右侧栏版仍用当前对话模型。
      if (rewritePicker && !settings?.mediaPromptRewriteModelId) {
        toast.error(t("media_studio.rewrite_model_required"));
        return;
      }
      setOptimizing(true);
      try {
        const response = await api.post<{ text: string }>(
          "prompt/optimize",
          {
            text,
            ...(conversationId ? { conversationId } : {}),
            ...(rewritePicker
              ? { modelId: settings?.mediaPromptRewriteModelId ?? "" }
              : chatModelId
                ? { modelId: chatModelId }
                : {}),
            purpose: "media",
            mediaKind: kind,
            // 用户拍板:媒体提示词不走全局「提示词优化模型」。
            useConversationModel: true,
          },
          { timeout: 60_000 },
        );
        const optimized = String(response.text ?? "").trim();
        if (!optimized) {
          toast.error(t("media_studio.optimize_empty"));
          return;
        }
        setPrompt(optimized);
        if (!silent) toast.success(t("media_studio.optimize_done"));
      } catch (error) {
        toast.error(extractErrorMessage(error, t("media_studio.optimize_failed")));
      } finally {
        setOptimizing(false);
      }
    },
    [chatModelId, conversationId, kind, rewritePicker, settings?.mediaPromptRewriteModelId, t],
  );

  React.useEffect(() => {
    if (!autoOptimize || autoOptimizedRef.current || !prompt.trim()) return;
    autoOptimizedRef.current = true;
    void optimizePrompt(prompt, true);
    // 只在首次挂载时自动优化;后续由用户点按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadReferences = React.useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      setUploading(true);
      try {
        const form = new FormData();
        for (const file of Array.from(files).slice(0, 16 - references.length)) {
          const normalized = await normalizeImageForModelUpload(file);
          form.append("files", normalized, normalized.name);
        }
        const response = await api.postMultipart<{ files: UploadedMediaFile[] }>(
          "files/upload",
          form,
          { timeout: false },
        );
        setReferences((current) => [...current, ...response.files].slice(0, 16));
      } catch (error) {
        toast.error(extractErrorMessage(error, t("media_studio.reference_failed")));
      } finally {
        setUploading(false);
      }
    },
    [references.length, t],
  );

  const generate = React.useCallback(async () => {
    if (!prompt.trim()) {
      toast.error(t("media_studio.no_prompt"));
      return;
    }
    if (!selectedRef) {
      toast.error(t("media_studio.no_model"));
      return;
    }
    setSubmitting(true);
    try {
      const response = await api.post<{ status: string; record: GeneratedMediaRecord | null }>(
        "media/generate",
        {
          kind,
          ref: selectedRef,
          prompt: prompt.trim(),
          ...(supportsCount ? { count: Number(count) || 1 } : {}),
          ...(supportsResolution && resolution.trim() ? { resolution: resolution.trim() } : {}),
          ...(supportsAspectRatio && aspectRatio.trim() ? { aspectRatio: aspectRatio.trim() } : {}),
          ...(supportsDuration ? { durationSeconds: Number(durationSeconds) || 5 } : {}),
          ...(supportsAudio ? { generateAudio } : {}),
          referenceFileIds: references.map((file) => file.id),
          ...(conversationId ? { conversationId } : {}),
        },
      );
      if (response.record) {
        setRecords((current) => mergeRecords(current, [response.record!]));
      }
      toast.success(t("media_studio.submitted"));
    } catch (error) {
      toast.error(extractErrorMessage(error, t("media_studio.generate_failed")));
    } finally {
      setSubmitting(false);
    }
  }, [
    aspectRatio,
    conversationId,
    count,
    durationSeconds,
    generateAudio,
    kind,
    prompt,
    references,
    selectedRef,
    supportsAspectRatio,
    supportsAudio,
    supportsCount,
    supportsDuration,
    supportsResolution,
    resolution,
    t,
  ]);

  const cancel = React.useCallback(
    async (record: GeneratedMediaRecord) => {
      try {
        const response = await api.post<{ record: GeneratedMediaRecord | null }>(
          `media/tasks/${record.id}/cancel`,
        );
        if (response.record) {
          setRecords((current) =>
            current.map((item) => (item.id === record.id ? response.record! : item)),
          );
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t("media_studio.cancel_failed")));
      }
    },
    [t],
  );

  const activeKey = records
    .filter(isActiveRecord)
    .map((record) => record.id)
    .join(",");
  React.useEffect(() => {
    const ids = activeKey ? activeKey.split(",") : [];
    if (ids.length === 0) return;
    let alive = true;
    const tick = async () => {
      const updates = await Promise.all(
        ids.map((id) =>
          api
            .get<{ record: GeneratedMediaRecord }>(`media/tasks/${id}`)
            .then((response) => response.record)
            .catch(() => null),
        ),
      );
      if (!alive) return;
      setRecords((current) =>
        current.map((item) => updates.find((update) => update?.id === item.id) ?? item),
      );
    };
    void tick();
    const timer = setInterval(() => void tick(), 2_500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeKey]);

  const insert = React.useCallback(
    async (record: GeneratedMediaRecord) => {
      const outputs = recordOutputs(record);
      if (outputs.length === 0) return;
      const parts: UIMessagePart[] = outputs.map((output) =>
        record.kind === "video"
          ? { type: "video", url: output.url, metadata: { fileId: output.fileId } }
          : { type: "image", url: output.url, metadata: { fileId: output.fileId } },
      );
      if (conversationId) {
        setInsertingId(record.id);
        try {
          await api.post(`conversations/${conversationId}/messages`, {
            parts: [
              {
                type: "text",
                text: t("media_studio.insert_message", {
                  kind: t(
                    record.kind === "video" ? "media_studio.kind_video" : "media_studio.kind_image",
                  ),
                  prompt: record.prompt,
                }),
              },
              ...parts,
            ],
          });
          toast.success(t("media_studio.inserted"));
        } catch (error) {
          toast.error(extractErrorMessage(error, t("media_studio.insert_failed")));
        } finally {
          setInsertingId(null);
        }
        return;
      }
      if (draftKey) {
        useChatInputStore.getState().addParts(draftKey, parts);
        toast.success(t("media_studio.inserted_draft"));
        return;
      }
      toast.error(t("media_studio.no_target"));
    },
    [conversationId, draftKey, t],
  );

  const visibleRecords = records.filter((record) => record.kind === kind);
  const canInsert = Boolean(conversationId || draftKey);
  const s3Warning =
    kind === "video" && references.length > 0 && !s3Complete(settings?.uploadS3Config);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex-1 overflow-y-auto">
        <div className={cn("space-y-3", compact ? "p-3" : "p-4")}>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(["image", "video"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                  kind === value
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "image" ? (
                  <ImagePlus className="size-4" />
                ) : (
                  <Clapperboard className="size-4" />
                )}
                {t(value === "image" ? "media_studio.tab_image" : "media_studio.tab_video")}
              </button>
            ))}
          </div>

          {options.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              <p>{t("media_studio.no_models", { kind: kindLabel })}</p>
              <Button asChild variant="tertiary" size="compact" className="mt-3">
                <SettingsLink search="?section=media&sub=providers">
                  {t("media_studio.manage")}
                </SettingsLink>
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  {t("media_studio.model")}
                </div>
                <Select value={modelKey} onValueChange={setModelKey}>
                  <SelectTrigger aria-label={t("media_studio.model")}>
                    <SelectValue placeholder={t("media_studio.select_model")} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={refKey(option.ref)} value={refKey(option.ref)}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 输入框自身不能有圆角:文字/选区从内容框左上角起绘,圆形裁剪区会把
                  首字的左上角切掉(看着像边框压字)。外框用全局 16px 圆角保持观感一致。 */}
              <div className="rounded-xl border bg-card p-3">
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={t("media_studio.prompt_placeholder")}
                  className="min-h-28 resize-none rounded-none border-0 bg-transparent p-0 text-sm shadow-none hover:shadow-none focus-visible:shadow-none placeholder:text-muted-foreground/60"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!prompt.trim() || optimizing}
                    onClick={() => void optimizePrompt(prompt)}
                  >
                    {optimizing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="size-3.5" />
                    )}
                    {optimizing ? t("media_studio.optimizing") : t("media_studio.optimize")}
                  </Button>
                  {rewritePicker ? (
                    <RewriteModelPicker />
                  ) : (
                    <span className="text-mini text-muted-foreground">
                      {t("media_studio.model_optimized_hint")}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t("media_studio.reference")}
                  </div>
                  <span className="text-mini text-muted-foreground">
                    {t("media_studio.reference_hint")}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {references.map((file) => (
                    <div
                      key={file.id}
                      className="group relative size-16 overflow-hidden rounded-md border bg-muted"
                    >
                      <img src={file.url} alt={file.fileName} className="size-full object-cover" />
                      <button
                        type="button"
                        className="absolute top-1 right-1 rounded-full bg-background/90 p-0.5 opacity-0 shadow transition group-hover:opacity-100"
                        onClick={() =>
                          setReferences((current) => current.filter((item) => item.id !== file.id))
                        }
                        aria-label={t("media_studio.remove_reference")}
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                  <input
                    ref={fileInputRef}
                    className="sr-only"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(event) => {
                      void uploadReferences(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="size-16 flex-col gap-1 border-dashed"
                    disabled={uploading || references.length >= 16}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    )}
                    <span className="text-mini">{t("media_studio.add_reference")}</span>
                  </Button>
                </div>
                {s3Warning ? (
                  <p className="rounded-md bg-[var(--ds-warning-bg)] px-2.5 py-2 text-mini text-[var(--ds-warning)]">
                    {t("media_studio.s3_warning")}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-2">
                {supportsCount ? (
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">{t("media_studio.count")}</span>
                    <Select value={count} onValueChange={setCount}>
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}

                {supportsResolution ? (
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {t("media_studio.resolution")}
                    </span>
                    <Input
                      value={resolution}
                      onChange={(event) => setResolution(event.target.value)}
                      placeholder={t("media_studio.resolution_auto")}
                      className="h-8"
                    />
                  </label>
                ) : null}

                {supportsAspectRatio ? (
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {t("media_studio.aspect_ratio")}
                    </span>
                    <Input
                      value={aspectRatio}
                      onChange={(event) => setAspectRatio(event.target.value)}
                      placeholder={t("media_studio.aspect_ratio_auto")}
                      className="h-8"
                    />
                  </label>
                ) : null}

                {supportsDuration ? (
                  <label className="space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {t("media_studio.duration")}
                    </span>
                    <Input
                      type="number"
                      min={1}
                      value={durationSeconds}
                      onChange={(event) => setDurationSeconds(event.target.value)}
                      className="h-8"
                    />
                  </label>
                ) : null}
              </div>

              {supportsAudio ? (
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <span className="text-sm">{t("media_studio.generate_audio")}</span>
                  <Switch checked={generateAudio} onCheckedChange={setGenerateAudio} />
                </label>
              ) : null}

              <Button
                type="button"
                className="w-full"
                disabled={submitting || optimizing || !prompt.trim() || !selectedRef}
                onClick={() => void generate()}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {submitting
                  ? t("media_studio.submitting")
                  : t("media_studio.generate", { kind: kindLabel })}
              </Button>
            </>
          )}

          <div className="space-y-2 pt-1">
            <div className="text-xs font-medium text-muted-foreground">
              {t("media_studio.history")}
            </div>
            {visibleRecords.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                {t("media_studio.empty")}
              </div>
            ) : (
              visibleRecords.map((record) => (
                <MediaRecordCard
                  key={record.id}
                  record={record}
                  canInsert={canInsert}
                  inserting={insertingId === record.id}
                  onCancel={(item) => void cancel(item)}
                  onInsert={(item) => void insert(item)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
