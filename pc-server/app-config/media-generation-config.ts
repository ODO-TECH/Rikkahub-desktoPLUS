// app-config/media-generation-config.ts — 特性 B 媒体供应商配置的默认值与规范化（纯函数,无 IO）
// 放在 app-config 而非 media-generation 域:normalizeState 每次加载都要调用,若从运行时模块
// 引入会形成 state-load → media-generation → persistence 的循环。值对齐移动端 3.1.0
// MediaGenerationProviderSetting,便于备份整包互通。

import type { S3Config } from "../foundation/types";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaGenerationProviderType,
  MediaModelRef,
} from "../foundation/types/settings";
import { isRecord } from "../foundation/utils";

export interface MediaProviderPreset {
  name: string;
  baseUrl: string;
  models: MediaGenerationModel[];
}

export const MEDIA_PROVIDER_PRESETS: Record<MediaGenerationProviderType, MediaProviderPreset> = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { modelId: "gpt-image-2.5-sunburst", kind: "image" },
      { modelId: "gpt-image-2.5-flare", kind: "image" },
    ],
  },
  aliyun: {
    name: "Aliyun",
    baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
    models: [
      { modelId: "qwen-image-3.0", kind: "image" },
      { modelId: "wan3.0-video", kind: "video" },
    ],
  },
  volcengine: {
    name: "Volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      { modelId: "doubao-seedream-5-0-pro-260628", kind: "image" },
      { modelId: "doubao-seedance-2-5-260628", kind: "video" },
    ],
  },
  minimax: {
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v2",
    models: [{ modelId: "MiniMax-H3", kind: "video" }],
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { modelId: "openai/gpt-image-2.5-sunburst", kind: "image" },
      { modelId: "openai/gpt-image-2.5-flare", kind: "image" },
      { modelId: "google/veo-3.1", kind: "video" },
    ],
  },
};

export const MEDIA_PROVIDER_TYPES = Object.keys(MEDIA_PROVIDER_PRESETS) as MediaGenerationProviderType[];

export function isMediaProviderType(value: unknown): value is MediaGenerationProviderType {
  return typeof value === "string" && value in MEDIA_PROVIDER_PRESETS;
}

export function isMediaKind(value: unknown): value is MediaGenerationModel["kind"] {
  return value === "image" || value === "video";
}

/** 该厂商适配器实现了哪些 kind（不是某个模型一定支持）。 */
export function supportedMediaKinds(type: MediaGenerationProviderType): MediaGenerationModel["kind"][] {
  switch (type) {
    case "openai":
      return ["image"];
    case "minimax":
      return ["video"];
    default:
      return ["image", "video"];
  }
}

export function normalizeMediaModel(value: unknown): MediaGenerationModel | null {
  if (!isRecord(value)) return null;
  const modelId = String(value.modelId ?? "").trim();
  if (!modelId || !isMediaKind(value.kind)) return null;
  return { modelId, kind: value.kind };
}

export function normalizeMediaModelRef(value: unknown): MediaModelRef | null {
  if (!isRecord(value)) return null;
  const providerId = String(value.providerId ?? "").trim();
  const modelId = String(value.modelId ?? "").trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function normalizeMediaGenerationProvider(value: unknown): MediaGenerationProviderConfig | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (!isMediaProviderType(type)) return null;
  const id = String(value.id ?? "").trim();
  if (!id) return null;
  const preset = MEDIA_PROVIDER_PRESETS[type];
  const models = Array.isArray(value.models)
    ? value.models.map(normalizeMediaModel).filter((m): m is MediaGenerationModel => m !== null)
    : preset.models;
  const config: MediaGenerationProviderConfig = {
    id,
    type,
    name: String(value.name ?? "") || preset.name,
    apiKey: String(value.apiKey ?? ""),
    baseUrl: String(value.baseUrl ?? "") || preset.baseUrl,
    models,
  };
  if (type === "aliyun") config.workspaceId = String(value.workspaceId ?? "");
  return config;
}

export function normalizeMediaGenerationProviders(value: unknown): MediaGenerationProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: MediaGenerationProviderConfig[] = [];
  for (const item of value) {
    const provider = normalizeMediaGenerationProvider(item);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    result.push(provider);
  }
  return result;
}

/** 上传桶与备份桶同构,但允许「未配置」(null)。 */
export function normalizeMediaUploadS3Config(value: unknown, normalizeS3: (v: unknown) => S3Config): S3Config | null {
  return value == null ? null : normalizeS3(value);
}
