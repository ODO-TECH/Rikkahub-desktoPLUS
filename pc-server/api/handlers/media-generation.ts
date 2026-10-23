// api/handlers/media-generation.ts — 特性 B 设置端点
// 供应商 CRUD / 默认模型 / 上传存储(与备份 S3 分离)。所有写入经 app-config 规范化,
// 避免前端回传的脏形状直接落进 state.settings。

import type { S3Config } from "../../foundation/types";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaModelRef,
} from "../../foundation/types/settings";
import {
  isMediaProviderType,
  MEDIA_PROVIDER_PRESETS,
  MEDIA_PROVIDER_TYPES,
  normalizeMediaGenerationProvider,
  normalizeMediaModelRef,
  normalizeMediaUploadS3Config,
  supportedMediaKinds,
} from "../../app-config/media-generation-config";
import { updateSettings } from "../../app-config";
import { normalizeS3Config } from "../../app-config/backup-config";
import { s3TestConnection } from "../../backup/storage";
import { getConversation } from "../../conversations";
import {
  cancelMediaGeneration,
  defaultMediaRefFor,
  fetchMediaProviderModels,
  findMediaTarget,
  MEDIA_CAPABILITIES,
  mediaCapability,
  MediaGenerationApiError,
  mediaProviderReady,
  resolveMediaTarget,
  startMediaGeneration,
  type MediaInput,
  type MediaKind,
} from "../../media-generation";
import { id } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { error, json, readJson } from "../request";

function dedupeModels(models: MediaGenerationModel[]): MediaGenerationModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.kind}:${model.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 保存前校验(B7.1):地址可解析、至少一个模型、模型类型与适配器匹配;阿里云补 WorkspaceId。 */
function providerValidationError(provider: MediaGenerationProviderConfig): string | null {
  if (!provider.name.trim()) return "名称不能为空";
  const supported = supportedMediaKinds(provider.type);
  provider.models = dedupeModels(provider.models.filter((model) => supported.includes(model.kind)));
  if (provider.models.length === 0) {
    return `「${provider.name}」至少需要一个 ${supported.join(" / ")} 模型`;
  }
  // 未填密钥的供应商允许先建后补；一旦要可用（有密钥），WorkspaceId 就必须齐。
  if (
    provider.type === "aliyun"
    && provider.baseUrl.includes("{WorkspaceId}")
    && !provider.workspaceId?.trim()
    && provider.apiKey.trim() !== ""
  ) {
    return "阿里云需要在 Base URL 含 {WorkspaceId} 时填写 WorkspaceId";
  }
  const probe = provider.baseUrl.replace("{WorkspaceId}", provider.workspaceId?.trim() || "workspace");
  try {
    const parsed = new URL(probe);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Base URL 必须是 http(s) 地址";
  } catch {
    return "Base URL 不是合法地址";
  }
  return null;
}

function defaultRefsClearedOf(providerId: string, ref: MediaModelRef | null | undefined): MediaModelRef | null {
  return ref?.providerId === providerId ? null : (ref ?? null);
}

function parseMediaKind(value: unknown): MediaKind | null {
  return value === "image" || value === "video" ? value : null;
}

function mediaErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mediaErrorStatus(err: unknown): number {
  return err instanceof MediaGenerationApiError && (err.statusCode ?? 400) < 500 ? 400 : 502;
}

/** 手动生成：入参按能力矩阵裁剪；返回账本记录，客户端轮询 media/tasks/:id。 */
async function handleManualGenerate(request: Request): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const kind = parseMediaKind(body.kind);
  if (!kind) return error("kind 必须是 image 或 video", 400);
  const ref = body.ref === undefined || body.ref === null
    ? defaultMediaRefFor(kind)
    : normalizeMediaModelRef(body.ref);
  if (!ref) {
    return error(
      kind === "image"
        ? "尚未配置默认图片模型：请在 设置 → 媒体 → 生成服务 添加并填写密钥"
        : "尚未配置默认视频模型：请在 设置 → 媒体 → 生成服务 添加并填写密钥",
      400,
    );
  }
  let target;
  try {
    target = resolveMediaTarget(ref, kind);
  } catch (err) {
    return error(mediaErrorMessage(err), mediaErrorStatus(err));
  }
  const capability = mediaCapability(target.provider.type, kind);
  if (!capability) return error(`供应商「${target.provider.name}」不支持该媒体类型`, 400);

  const supported = new Set<string>(capability.params);
  const str = (key: string) => {
    if (!supported.has(key)) return undefined;
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const num = (key: string) => {
    if (!supported.has(key)) return undefined;
    const value = Number(body[key]);
    return Number.isFinite(value) ? value : undefined;
  };
  const bool = (key: string) => {
    if (!supported.has(key)) return undefined;
    return typeof body[key] === "boolean" ? body[key] as boolean : undefined;
  };

  const values: Record<string, string | number | boolean | undefined> = {
    resolution: str("resolution"),
    aspectRatio: str("aspectRatio"),
    durationSeconds: num("durationSeconds"),
    generateAudio: bool("generateAudio"),
    watermark: bool("watermark"),
    seed: num("seed"),
    promptEnhancement: bool("promptEnhancement"),
  };
  // 必填参数给可用的默认值，让 MiniMax 这类接口在用户没展开高级项时也能生成。
  const requiredDefaults: Record<string, string | number | boolean> = {
    resolution: "720P",
    aspectRatio: "16:9",
    durationSeconds: 5,
  };
  for (const key of capability.required) {
    if (values[key] === undefined) values[key] = requiredDefaults[key];
    if (values[key] === undefined) return error(`当前视频模型缺少必填参数：${key}`, 400);
  }
  const count = kind === "image"
    ? Math.min(Math.max(Math.round(num("count") ?? 1), 1), 4)
    : undefined;

  const rawIds = Array.isArray(body.referenceFileIds) ? body.referenceFileIds : [];
  const fileIds = rawIds.map(Number).filter(Number.isFinite);
  const inputs: MediaInput[] = [];
  for (const fileId of fileIds) {
    const file = state.files.find((item) => item.id === fileId);
    if (!file) return error(`参考文件 ${fileId} 不存在`, 400);
    if (!file.mime.startsWith("image/")) return error("参考素材目前只支持图片", 400);
    inputs.push({
      type: "image",
      role: "reference",
      url: `/api/files/${file.id}/content`,
      localPath: file.path,
      mime: file.mime,
      fileName: file.fileName,
    });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (capability.requiresPrompt && !prompt) return error("请输入提示词", 400);

  const requestedConversation = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  if (requestedConversation && !getConversation(requestedConversation)) {
    return error("Conversation not found", 404);
  }

  try {
    const recordId = await startMediaGeneration({
      kind,
      ref,
      prompt,
      inputs,
      count,
      resolution: values.resolution as string | undefined,
      aspectRatio: values.aspectRatio as string | undefined,
      durationSeconds: values.durationSeconds as number | undefined,
      generateAudio: values.generateAudio as boolean | undefined,
      watermark: values.watermark as boolean | undefined,
      seed: values.seed as number | undefined,
      promptEnhancement: values.promptEnhancement as boolean | undefined,
      conversationId: requestedConversation || null,
    });
    const record = state.generatedMedia.find((item) => item.id === recordId) ?? null;
    return json({ status: "queued", record }, { status: 202 });
  } catch (err) {
    return error(mediaErrorMessage(err), mediaErrorStatus(err));
  }
}

export async function handleMediaGenerationRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  if (path === "media/generate" && request.method === "POST") {
    return handleManualGenerate(request);
  }
  if (path === "media/history" && request.method === "GET") {
    const kind = parseMediaKind(url.searchParams.get("kind"));
    const rawLimit = Number(url.searchParams.get("limit") ?? "60");
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 60;
    const records = state.generatedMedia
      .filter((record) => !kind || record.kind === kind)
      .slice(0, limit);
    return json({ records });
  }
  const taskMatch = path.match(/^media\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "GET") {
    const record = state.generatedMedia.find((item) => item.id === decodeURIComponent(taskMatch[1]));
    if (!record) return error("Media task not found", 404);
    return json({ record });
  }
  const taskCancel = path.match(/^media\/tasks\/([^/]+)\/cancel$/);
  if (taskCancel && request.method === "POST") {
    const recordId = decodeURIComponent(taskCancel[1]);
    if (!state.generatedMedia.some((item) => item.id === recordId)) return error("Media task not found", 404);
    return json({ status: "cancelled", record: cancelMediaGeneration(recordId) });
  }

  if (path === "settings/media-provider/detail" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const requestedType = body.type;
    if (!isMediaProviderType(requestedType)) {
      return error(`Unknown media provider type: ${String(requestedType ?? "")}`, 400);
    }
    const providerId = String(body.id ?? "").trim() || `media-${id()}`;
    const existing = state.settings.mediaGenerationProviders.find((provider) => provider.id === providerId);
    if (existing && existing.type !== requestedType) return error("Provider type cannot be changed after creation", 400);
    const preset = MEDIA_PROVIDER_PRESETS[requestedType];
    const base = existing ?? { ...preset, type: requestedType, id: providerId, apiKey: "" };
    const provider = normalizeMediaGenerationProvider({ ...base, ...body, id: providerId, type: requestedType });
    if (!provider) return error("Invalid media provider", 400);
    const validation = providerValidationError(provider);
    if (validation) return error(validation, 400);
    updateSettings({
      ...state.settings,
      mediaGenerationProviders: existing
        ? state.settings.mediaGenerationProviders.map((item) => (item.id === provider.id ? provider : item))
        : [...state.settings.mediaGenerationProviders, provider],
    });
    return json({ status: "ok", provider });
  }

  const providerDelete = path.match(/^settings\/media-provider\/([^/]+)$/);
  if (providerDelete && request.method === "DELETE") {
    const providerId = decodeURIComponent(providerDelete[1]);
    if (!state.settings.mediaGenerationProviders.some((provider) => provider.id === providerId)) {
      return error("Media provider not found", 404);
    }
    updateSettings({
      ...state.settings,
      mediaGenerationProviders: state.settings.mediaGenerationProviders.filter((provider) => provider.id !== providerId),
      defaultMediaImageModel: defaultRefsClearedOf(providerId, state.settings.defaultMediaImageModel),
      defaultMediaVideoModel: defaultRefsClearedOf(providerId, state.settings.defaultMediaVideoModel),
    });
    return json({ status: "deleted" });
  }

  if (path === "settings/media-provider/defaults" && request.method === "POST") {
    const body = await readJson<{ image?: unknown; video?: unknown }>(request);
    const image = body.image === undefined ? state.settings.defaultMediaImageModel ?? null : normalizeMediaModelRef(body.image);
    const video = body.video === undefined ? state.settings.defaultMediaVideoModel ?? null : normalizeMediaModelRef(body.video);
    if (image && !findMediaTarget(image, "image")) return error("默认图片模型不可用：请先在供应商配置中补全", 400);
    if (video && !findMediaTarget(video, "video")) return error("默认视频模型不可用：请先在供应商配置中补全", 400);
    updateSettings({ ...state.settings, defaultMediaImageModel: image, defaultMediaVideoModel: video });
    return json({ status: "ok", image, video });
  }

  // 「获取模型」：只列不改，勾选结果由前端回传 detail 保存。要求先填地址与密钥。
  if (path === "settings/media-provider/fetch-models" && request.method === "POST") {
    const body = await readJson<{ providerId?: unknown }>(request);
    const providerId = String(body.providerId ?? "").trim();
    const provider = state.settings.mediaGenerationProviders.find((item) => item.id === providerId);
    if (!provider) return error("Media provider not found", 404);
    if (!mediaProviderReady(provider)) return error("请先填写 Base URL 与 API Key，再获取模型列表", 400);
    try {
      const { endpoint, models } = await fetchMediaProviderModels(provider);
      return json({ status: "ok", endpoint, models });
    } catch (err) {
      return error(mediaErrorMessage(err), mediaErrorStatus(err));
    }
  }

  if (path === "settings/media-upload/config" && request.method === "POST") {
    const body = await readJson<{ config?: unknown }>(request);
    const config = normalizeMediaUploadS3Config(body.config ?? null, normalizeS3Config);
    updateSettings({ ...state.settings, uploadS3Config: config });
    return json({ status: "ok", config });
  }
  if (path === "settings/media-upload/test" && request.method === "POST") {
    const body = await readJson<{ config?: unknown }>(request);
    const config = normalizeMediaUploadS3Config(
      body.config ?? state.settings.uploadS3Config ?? null,
      normalizeS3Config,
    ) as S3Config | null;
    if (!config) return error("尚未配置上传存储", 400);
    try {
      await s3TestConnection(config);
      return json({ status: "ok" });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 502);
    }
  }

  // 设置页/会话弹层的模型清单(不含密钥):只读投影,便于前端统一下拉来源。
  // presets 一并下发:「恢复默认地址与模型」以服务端预设为唯一事实源,前端不复制一份。
  if (path === "settings/media-provider/models" && request.method === "GET") {
    return json({
      providers: state.settings.mediaGenerationProviders.map((provider) => ({
        id: provider.id,
        type: provider.type,
        name: provider.name,
        ready: provider.apiKey.trim() !== "" && provider.baseUrl.trim() !== "",
        kinds: supportedMediaKinds(provider.type),
        models: provider.models,
      })),
      types: MEDIA_PROVIDER_TYPES,
      presets: Object.fromEntries(
        MEDIA_PROVIDER_TYPES.map((type) => [
          type,
          { ...MEDIA_PROVIDER_PRESETS[type], kinds: supportedMediaKinds(type) },
        ]),
      ),
      // 能力矩阵是参数表单的唯一事实源；前端据此只展示供应商真正接受的参数。
      capabilities: MEDIA_CAPABILITIES,
    });
  }

  return null;
}
