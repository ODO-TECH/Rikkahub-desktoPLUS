// media-generation/config.ts — 从 settings 解析「会话选中的供应商 + 模型」并给出可操作错误
// 工具层与设置 API 共用这一份选型逻辑，避免两处各判一遍。

import { state } from "../persistence/json-store";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaModelRef,
} from "../foundation/types/settings";
import { mediaCapability } from "./capabilities";
import type { MediaKind } from "./types";
import { MediaGenerationApiError } from "./types";

export interface ResolvedMediaTarget {
  provider: MediaGenerationProviderConfig;
  model: MediaGenerationModel;
  baseUrl: string;
}

const ALIYUN_WORKSPACE_PLACEHOLDER = "{WorkspaceId}";

/** 阿里云按业务空间分域：替换 {WorkspaceId}；不含占位符的旧地址原样使用。 */
export function mediaProviderBaseUrl(provider: MediaGenerationProviderConfig): string {
  const base = provider.baseUrl.trim().replace(/\/+$/, "");
  if (!base.includes(ALIYUN_WORKSPACE_PLACEHOLDER)) return base;
  const workspaceId = (provider.workspaceId ?? "").trim();
  if (!workspaceId) {
    throw new MediaGenerationApiError(
      `阿里云媒体供应商「${provider.name}」缺少 WorkspaceId：请在 设置 → 媒体 → 生成服务 补全`,
    );
  }
  return base.replace(ALIYUN_WORKSPACE_PLACEHOLDER, workspaceId);
}

export function mediaProviderReady(provider: MediaGenerationProviderConfig): boolean {
  return provider.apiKey.trim() !== "" && provider.baseUrl.trim() !== "";
}

/** 已配置（且有密钥）的某类模型清单，供设置页下拉与错误文案使用。 */
export function listConfiguredMediaModels(kind: MediaKind): Array<{ provider: MediaGenerationProviderConfig; model: MediaGenerationModel }> {
  const result: Array<{ provider: MediaGenerationProviderConfig; model: MediaGenerationModel }> = [];
  for (const provider of state.settings.mediaGenerationProviders ?? []) {
    if (!mediaProviderReady(provider)) continue;
    if (!mediaCapability(provider.type, kind)) continue;
    for (const model of provider.models) {
      if (model.kind === kind) result.push({ provider, model });
    }
  }
  return result;
}

export function listAllMediaModels(kind: MediaKind): Array<{ provider: MediaGenerationProviderConfig; model: MediaGenerationModel }> {
  const result: Array<{ provider: MediaGenerationProviderConfig; model: MediaGenerationModel }> = [];
  for (const provider of state.settings.mediaGenerationProviders ?? []) {
    if (!mediaCapability(provider.type, kind)) continue;
    for (const model of provider.models) {
      if (model.kind === kind) result.push({ provider, model });
    }
  }
  return result;
}

export function findMediaTarget(ref: MediaModelRef | null | undefined, kind: MediaKind): ResolvedMediaTarget | null {
  if (!ref) return null;
  const provider = (state.settings.mediaGenerationProviders ?? []).find((item) => item.id === ref.providerId);
  if (!provider || !mediaProviderReady(provider)) return null;
  if (!mediaCapability(provider.type, kind)) return null;
  const model = provider.models.find((item) => item.modelId === ref.modelId && item.kind === kind);
  if (!model) return null;
  // 声明装配在每轮请求热路径:阿里云缺 WorkspaceId 时静默视为不可用,由执行层给可操作错误。
  try {
    return { provider, model, baseUrl: mediaProviderBaseUrl(provider) };
  } catch {
    return null;
  }
}

export function resolveMediaTarget(ref: MediaModelRef | null | undefined, kind: MediaKind): ResolvedMediaTarget {
  const label = kind === "image" ? "图片" : "视频";
  if (!ref) {
    throw new MediaGenerationApiError(`本会话尚未选择${label}模型：请在输入框的「媒体」菜单里选择`);
  }
  const provider = (state.settings.mediaGenerationProviders ?? []).find((item) => item.id === ref.providerId);
  if (!provider) {
    throw new MediaGenerationApiError(
      `媒体供应商已不存在（${ref.providerId}）：请重新选择${label}模型`,
    );
  }
  if (!mediaProviderReady(provider)) {
    throw new MediaGenerationApiError(
      `媒体供应商「${provider.name}」未配置 API Key：请先在 设置 → 媒体 → 生成服务 补全`,
    );
  }
  if (!mediaCapability(provider.type, kind)) {
    throw new MediaGenerationApiError(`供应商「${provider.name}」不支持${label}生成`);
  }
  const model = provider.models.find((item) => item.modelId === ref.modelId && item.kind === kind);
  if (!model) {
    const available = listConfiguredMediaModels(kind)
      .map((entry) => `${entry.provider.name}/${entry.model.modelId}`)
      .join("、");
    throw new MediaGenerationApiError(
      `找不到${label}模型「${ref.modelId}」（供应商 ${provider.name}）。可用模型：${available || "无，请先在设置中配置"}`,
    );
  }
  return { provider, model, baseUrl: mediaProviderBaseUrl(provider) };
}

/** 新会话默认选择；失效时返回 null，让会话列表回落到第一项。 */
export function defaultMediaRefFor(kind: MediaKind): MediaModelRef | null {
  const ref = kind === "image" ? state.settings.defaultMediaImageModel : state.settings.defaultMediaVideoModel;
  if (!ref) return null;
  return findMediaTarget(ref, kind) ? ref : null;
}
