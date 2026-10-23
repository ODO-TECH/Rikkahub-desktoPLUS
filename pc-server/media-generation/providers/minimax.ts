// media-generation/providers/minimax.ts — MiniMax H3 视频（异步任务）
// 官方结果 URL 是带签名的直链（不同源）；中转站可能同源要求 Bearer，故下载头按同源判定。

import type { JsonValue } from "../../foundation/types";
import { isRecord } from "../../foundation/utils";
import type {
  MediaGenerationRequest,
  MediaGenerationTask,
  MediaProviderAdapter,
  MediaTaskStatus,
} from "../types";
import { MediaGenerationApiError } from "../types";
import {
  asNumber,
  asString,
  bearerHeaders,
  getMediaJson,
  postMediaJson,
  sameOriginBearer,
} from "./http";

function mediaRole(role: string): string {
  if (role === "first_frame") return "first_frame";
  if (role === "last_frame") return "last_frame";
  return "reference_image";
}

export function mapMiniMaxStatus(status: string | undefined): MediaTaskStatus {
  switch ((status ?? "").toLowerCase()) {
    case "queued":
    case "pending":
    case "preparing":
      return "queued";
    case "running":
    case "processing":
    case "in_progress":
      return "running";
    case "succeeded":
    case "success":
    case "completed":
      return "succeeded";
    case "failed":
    case "fail":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return "running";
  }
}

function createBody(modelId: string, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (!request.prompt?.trim()) throw new MediaGenerationApiError("MiniMax H3 需要非空提示词");
  if (request.count != null && request.count !== 1) throw new MediaGenerationApiError("MiniMax H3 一次只生成一段视频");
  if (request.generateAudio != null) throw new MediaGenerationApiError("MiniMax H3 不提供 generateAudio 选项");
  if (request.seed != null) throw new MediaGenerationApiError("MiniMax H3 不支持 seed");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("MiniMax H3 不支持提示词增强");
  const content: JsonValue[] = [{ type: "text", text: request.prompt }];
  for (const input of request.inputs) {
    const extra = { ...(input.extra ?? {}) };
    if (input.type === "image") {
      content.push({ ...extra, type: "image_url", image_url: { url: input.url }, role: mediaRole(input.role) });
    } else if (input.type === "video") {
      content.push({ ...extra, type: "video_url", video_url: { url: input.url }, role: "reference_video" });
    } else {
      content.push({ ...extra, type: "audio_url", audio_url: { url: input.url }, role: "reference_audio" });
    }
  }
  const body: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  body.model = modelId;
  body.content = content;
  if (request.resolution) body.resolution = request.resolution;
  if (request.aspectRatio) body.ratio = request.aspectRatio;
  if (request.durationSeconds != null) body.duration = request.durationSeconds;
  if (request.watermark != null) body.aigc_watermark = request.watermark;
  return body;
}

function parseTask(body: Record<string, JsonValue>): MediaGenerationTask {
  const task = isRecord(body.task) ? body.task : null;
  if (!task) throw new MediaGenerationApiError("MiniMax 响应缺少 task", undefined, undefined, "minimax");
  const content = isRecord(task.content) ? task.content : null;
  const errorObject = isRecord(task.error) ? task.error : null;
  const videoUrl = content ? asString(content.url) : undefined;
  const taskId = asString(task.id);
  if (!taskId) throw new MediaGenerationApiError("MiniMax task 缺少 id", undefined, undefined, "minimax");
  return {
    id: crypto.randomUUID(),
    providerTaskId: taskId,
    provider: "minimax",
    modelId: asString(task.model),
    status: mapMiniMaxStatus(asString(task.status)),
    outputs: videoUrl
      ? [
          {
            url: videoUrl,
            mime: "video/mp4",
            durationSeconds: asNumber(task.duration),
            resolution: asString(task.resolution),
            aspectRatio: asString(task.ratio),
          },
        ]
      : [],
    error: errorObject
      ? {
          code: asString(errorObject.code) ?? asString(errorObject.type),
          message: asString(errorObject.message) ?? "MiniMax 视频任务失败",
        }
      : undefined,
    createdAt: asNumber(task.created_at),
    updatedAt: asNumber(task.updated_at),
  };
}

export const minimaxMediaAdapter: MediaProviderAdapter = {
  type: "minimax",

  async create(ctx, request) {
    const response = await postMediaJson(
      ctx,
      `${ctx.baseUrl.replace(/\/+$/, "")}/video_generation`,
      createBody(ctx.model.modelId, request),
      { kind: "provider:media:generate" },
      bearerHeaders(ctx.config.apiKey),
    );
    const taskId = asString(response.task_id);
    if (!taskId) throw new MediaGenerationApiError("MiniMax 响应缺少 task_id", undefined, undefined, "minimax");
    return {
      id: crypto.randomUUID(),
      providerTaskId: taskId,
      provider: "minimax",
      modelId: ctx.model.modelId,
      status: "queued",
      outputs: [],
    };
  },

  async query(ctx, providerTaskId) {
    const response = await getMediaJson(
      ctx,
      `${ctx.baseUrl.replace(/\/+$/, "")}/query/video_generation/${encodeURIComponent(providerTaskId)}`,
      { kind: "provider:media:poll" },
      bearerHeaders(ctx.config.apiKey),
    );
    return parseTask(response);
  },

  downloadHeaders(ctx, url) {
    return sameOriginBearer(ctx.baseUrl, ctx.config.apiKey, url);
  },
};
