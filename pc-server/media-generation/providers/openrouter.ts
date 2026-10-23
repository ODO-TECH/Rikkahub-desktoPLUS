// media-generation/providers/openrouter.ts — OpenRouter 自有协议
// 图片 POST /images 同步返回 base64；视频 POST /videos 异步，轮询 completed 后从 unsigned_urls 下载。

import type { JsonValue } from "../../foundation/types";
import { isRecord } from "../../foundation/utils";
import type {
  MediaGenerationOutput,
  MediaGenerationRequest,
  MediaGenerationTask,
  MediaProviderAdapter,
  MediaProviderContext,
  MediaTaskStatus,
} from "../types";
import { MediaGenerationApiError } from "../types";
import {
  bearerHeaders,
  getMediaJson,
  postMediaJson,
  sameOriginBearer,
} from "./http";

const PIXEL_SIZE = /^\d+[xX]\d+$/;

function requestHeaders(ctx: MediaProviderContext): Record<string, string> {
  return {
    ...bearerHeaders(ctx.config.apiKey),
    // 与聊天请求一致的来源标识
    "X-Title": "RikkaHub",
    "HTTP-Referer": "https://rikka-ai.com",
  };
}

/** 像素尺寸（1280x720）走 size，档位（2K / 1080p）走 resolution。 */
function putResolution(body: Record<string, JsonValue>, resolution: string | undefined): void {
  if (!resolution?.trim()) return;
  body[PIXEL_SIZE.test(resolution) ? "size" : "resolution"] = resolution;
}

function imageUrlPart(input: { url: string; extra?: Record<string, JsonValue> }): Record<string, JsonValue> {
  return { ...(input.extra ?? {}), type: "image_url", image_url: { url: input.url } };
}

function mapVideoStatus(status: string | undefined): MediaTaskStatus {
  switch ((status ?? "").toLowerCase()) {
    case "pending":
      return "queued";
    case "in_progress":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
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

function imageBody(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (!request.prompt?.trim()) throw new MediaGenerationApiError("OpenRouter 图像生成需要非空提示词");
  if (request.durationSeconds != null) throw new MediaGenerationApiError("OpenRouter 图像生成不支持时长");
  if (request.generateAudio != null) throw new MediaGenerationApiError("OpenRouter 图像生成不支持生成音频");
  if (request.watermark != null) throw new MediaGenerationApiError("OpenRouter 图像生成不支持水印");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("OpenRouter 图像生成不支持提示词增强");
  const body: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  body.model = ctx.model.modelId;
  body.prompt = request.prompt;
  const references = request.inputs.map((input) => {
    if (input.type !== "image") throw new MediaGenerationApiError("OpenRouter 图像生成只接受图片素材");
    return imageUrlPart(input);
  });
  if (references.length) body.input_references = references;
  if (request.count) body.n = request.count;
  putResolution(body, request.resolution);
  if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
  if (request.seed != null) body.seed = request.seed;
  return body;
}

function parseImageTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const items = Array.isArray(body.data) ? body.data : [];
  const outputs: MediaGenerationOutput[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const base64 = typeof entry.b64_json === "string" ? entry.b64_json : undefined;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    if (!base64 && !url) continue;
    outputs.push({
      data: base64 ? Buffer.from(base64, "base64") : undefined,
      url,
      mime: typeof entry.media_type === "string" ? entry.media_type : "image/png",
    });
  }
  const errorObject = isRecord(body.error) ? body.error : null;
  return {
    id: crypto.randomUUID(),
    provider: "openrouter",
    modelId,
    status: outputs.length ? "succeeded" : "failed",
    outputs,
    error: outputs.length
      ? undefined
      : {
          code: errorObject ? (typeof errorObject.code === "string" ? errorObject.code : undefined) : undefined,
          message: (errorObject && typeof errorObject.message === "string" ? errorObject.message : undefined) ?? "OpenRouter 未返回图片",
        },
  };
}

function videoBody(modelId: string, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (request.count != null && request.count !== 1) throw new MediaGenerationApiError("OpenRouter 一次只生成一段视频");
  if (request.watermark != null) throw new MediaGenerationApiError("OpenRouter 视频接口不暴露水印");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("OpenRouter 视频接口不暴露提示词增强");
  const frames: JsonValue[] = [];
  const references: JsonValue[] = [];
  for (const input of request.inputs) {
    const extra = { ...(input.extra ?? {}) };
    if (input.type === "image") {
      const part = imageUrlPart(input);
      if (input.role === "reference") references.push(part);
      else frames.push({ ...part, frame_type: input.role });
    } else if (input.type === "video") {
      references.push({ ...extra, type: "video_url", video_url: { url: input.url } });
    } else {
      references.push({ ...extra, type: "audio_url", audio_url: { url: input.url } });
    }
  }
  const body: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  body.model = modelId;
  if (request.prompt?.trim()) body.prompt = request.prompt;
  if (frames.length) body.frame_images = frames;
  if (references.length) body.input_references = references;
  putResolution(body, request.resolution);
  if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
  if (request.durationSeconds != null) body.duration = request.durationSeconds;
  if (request.generateAudio != null) body.generate_audio = request.generateAudio;
  if (request.seed != null) body.seed = request.seed;
  return body;
}

function parseVideoTask(ctx: MediaProviderContext, body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const taskId = typeof body.id === "string" ? body.id : undefined;
  if (!taskId) throw new MediaGenerationApiError("OpenRouter 视频响应缺少 id", undefined, undefined, "openrouter");
  const urls = Array.isArray(body.unsigned_urls)
    ? body.unsigned_urls.filter((url): url is string => typeof url === "string")
    : [];
  let errorMessage: string | undefined;
  if (isRecord(body.error) && typeof body.error.message === "string") errorMessage = body.error.message;
  else if (typeof body.error === "string") errorMessage = body.error;
  let base: URL | null = null;
  try {
    base = new URL(ctx.baseUrl);
  } catch {
    base = null;
  }
  return {
    id: crypto.randomUUID(),
    providerTaskId: taskId,
    provider: "openrouter",
    modelId,
    status: mapVideoStatus(typeof body.status === "string" ? body.status : undefined),
    outputs: urls.map((url) => {
      let absolute = url;
      try {
        absolute = base ? new URL(url, base).toString() : url;
      } catch {
        absolute = url;
      }
      return { url: absolute, mime: "video/mp4" };
    }),
    error: errorMessage ? { message: errorMessage } : undefined,
  };
}

export const openrouterMediaAdapter: MediaProviderAdapter = {
  type: "openrouter",

  async create(ctx, request) {
    const base = ctx.baseUrl.replace(/\/+$/, "");
    const headers = requestHeaders(ctx);
    if (ctx.model.kind === "image") {
      const response = await postMediaJson(
        ctx,
        `${base}/images`,
        imageBody(ctx, request),
        { kind: "provider:media:generate" },
        headers,
      );
      return parseImageTask(response, ctx.model.modelId);
    }
    const response = await postMediaJson(
      ctx,
      `${base}/videos`,
      videoBody(ctx.model.modelId, request),
      { kind: "provider:media:generate" },
      headers,
    );
    return parseVideoTask(ctx, response, ctx.model.modelId);
  },

  async query(ctx, providerTaskId) {
    const response = await getMediaJson(
      ctx,
      `${ctx.baseUrl.replace(/\/+$/, "")}/videos/${encodeURIComponent(providerTaskId)}`,
      { kind: "provider:media:poll" },
      requestHeaders(ctx),
    );
    return parseVideoTask(ctx, response, ctx.model.modelId);
  },

  downloadHeaders(ctx, url) {
    return sameOriginBearer(ctx.baseUrl, ctx.config.apiKey, url);
  },
};
