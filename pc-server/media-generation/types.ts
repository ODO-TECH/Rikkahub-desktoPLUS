// media-generation/types.ts — 特性 B 媒体生成的请求 / 任务 / 适配器契约
// 蓝本为移动端 3.1.0 mediagen 模块的 model 与 provider 接口；字段名保持同形，
// 便于对照实现与后续协议升级。

import type { JsonValue } from "../foundation/types";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
  MediaGenerationProviderType,
} from "../foundation/types/settings";

export type MediaKind = "image" | "video";

/** 图片素材在视频请求里的角色（首帧 / 尾帧 / 参考图）。图片接口只认 reference。 */
export type MediaImageRole = "reference" | "first_frame" | "last_frame";

export interface MediaImageInput {
  type: "image";
  role: MediaImageRole;
  url: string;
  /** 本机文件路径（来自 state.files 或工作区）。需要 multipart / data URI 时读它。 */
  localPath?: string;
  mime?: string;
  fileName?: string;
  extra?: Record<string, JsonValue>;
}

export interface MediaVideoInput {
  type: "video";
  url: string;
  localPath?: string;
  mime?: string;
  fileName?: string;
  extra?: Record<string, JsonValue>;
}

export interface MediaAudioInput {
  type: "audio";
  url: string;
  localPath?: string;
  mime?: string;
  fileName?: string;
  extra?: Record<string, JsonValue>;
}

export type MediaInput = MediaImageInput | MediaVideoInput | MediaAudioInput;

export interface MediaGenerationRequest {
  prompt?: string;
  inputs: MediaInput[];
  count?: number;
  resolution?: string;
  aspectRatio?: string;
  /** -1 = 由模型决定时长（移动端同义）。 */
  durationSeconds?: number;
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  promptEnhancement?: boolean;
  extraParameters?: Record<string, JsonValue>;
}

export type MediaTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export interface MediaGenerationOutput {
  url?: string;
  data?: Buffer;
  mime: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  lastFrameUrl?: string;
}

export interface MediaGenerationTask {
  /** 本地任务 id；异步接口另给 providerTaskId。 */
  id: string;
  providerTaskId?: string;
  provider: MediaGenerationProviderType;
  modelId?: string;
  status: MediaTaskStatus;
  outputs: MediaGenerationOutput[];
  error?: { code?: string; message: string };
  metadata?: JsonValue;
  createdAt?: number;
  updatedAt?: number;
}

/** 适配器调用上下文：已解析好的供应商配置 + 模型。 */
export interface MediaProviderContext {
  config: MediaGenerationProviderConfig;
  model: MediaGenerationModel;
  baseUrl: string;
  signal?: AbortSignal;
}

export interface MediaProviderAdapter {
  type: MediaGenerationProviderType;
  /** 提交。同步供应商直接返回终态；异步供应商返回 queued/running + providerTaskId。 */
  create(ctx: MediaProviderContext, request: MediaGenerationRequest): Promise<MediaGenerationTask>;
  /** 异步供应商轮询；同步供应商不实现。 */
  query?(ctx: MediaProviderContext, providerTaskId: string): Promise<MediaGenerationTask>;
  /** 下载产出时的额外头（MiniMax / OpenRouter 同源要带 Bearer）。 */
  downloadHeaders?(ctx: MediaProviderContext, url: string): Record<string, string>;
}

/** 供应商返回 4xx/5xx 或协议错误。statusCode 供上层区分「不要原样重试 4xx」。 */
export class MediaGenerationApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly code?: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "MediaGenerationApiError";
  }
}

export class MediaGenerationCancelledError extends Error {
  constructor() {
    super("媒体生成已停止");
    this.name = "MediaGenerationCancelledError";
  }
}
