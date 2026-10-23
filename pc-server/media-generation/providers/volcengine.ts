// media-generation/providers/volcengine.ts — 火山方舟 Seedream / Seedance
// 图片同步返回；视频是 contents/generations/tasks 异步任务。

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
  asNumber,
  asString,
  bearerHeaders,
  getMediaJson,
  imageMimeFromHint,
  inputToUrlOrDataUri,
  postMediaJson,
  urlFileExtension,
} from "./http";

function mediaRole(role: string): string {
  if (role === "first_frame") return "first_frame";
  if (role === "last_frame") return "last_frame";
  return "reference_image";
}

function mapStatus(status: string | undefined): MediaTaskStatus {
  switch ((status ?? "").toLowerCase()) {
    case "queued":
    case "pending":
      return "queued";
    case "running":
    case "in_progress":
      return "running";
    case "succeeded":
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
      // 未知状态继续轮询；24h 总时限兜底
      return "running";
  }
}

function imageBody(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (!request.prompt?.trim()) throw new MediaGenerationApiError("火山图片生成需要非空提示词");
  if (request.count != null && request.count !== 1) {
    throw new MediaGenerationApiError("火山一次生成一张图片；组图请用 extraParameters 的 sequential_image_generation");
  }
  if (request.aspectRatio) throw new MediaGenerationApiError("火山图片生成从提示词或像素尺寸取比例，不支持 aspectRatio");
  if (request.durationSeconds != null) throw new MediaGenerationApiError("火山图片生成不支持时长");
  if (request.generateAudio != null) throw new MediaGenerationApiError("火山图片生成不支持生成音频");
  if (request.seed != null) throw new MediaGenerationApiError("火山图片生成不支持 seed");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("火山图片生成用 optimize_prompt_options 控制提示词优化");
  const body: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  body.model = ctx.model.modelId;
  body.prompt = request.prompt;
  const images = request.inputs.map((input) => {
    if (input.type !== "image") throw new MediaGenerationApiError("火山图片生成只接受图片素材");
    return inputToUrlOrDataUri(input);
  });
  if (images.length === 1) body.image = images[0];
  else if (images.length > 1) body.image = images;
  if (request.resolution?.trim()) body.size = request.resolution;
  if (request.watermark != null) body.watermark = request.watermark;
  return body;
}

function videoBody(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (request.count != null && request.count !== 1) throw new MediaGenerationApiError("火山一次只生成一段视频");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("火山视频接口不暴露提示词增强");
  const body: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  body.model = ctx.model.modelId;
  const content: JsonValue[] = [];
  if (request.prompt?.trim()) content.push({ type: "text", text: request.prompt });
  for (const input of request.inputs) {
    const extra = { ...(input.extra ?? {}) };
    if (input.type === "image") {
      content.push({
        ...extra,
        type: "image_url",
        image_url: { url: input.url },
        role: mediaRole(input.role),
      });
    } else if (input.type === "video") {
      content.push({ ...extra, type: "video_url", video_url: { url: input.url }, role: "reference_video" });
    } else {
      content.push({ ...extra, type: "audio_url", audio_url: { url: input.url }, role: "reference_audio" });
    }
  }
  body.content = content;
  if (request.resolution) body.resolution = request.resolution;
  if (request.aspectRatio) body.ratio = request.aspectRatio;
  if (request.durationSeconds != null) body.duration = request.durationSeconds;
  if (request.generateAudio != null) body.generate_audio = request.generateAudio;
  if (request.watermark != null) body.watermark = request.watermark;
  if (request.seed != null) body.seed = request.seed;
  return body;
}

function parseImageTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const items = Array.isArray(body.data) ? body.data : [];
  const outputs: MediaGenerationOutput[] = [];
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const url = asString(entry.url);
    const base64 = asString(entry.b64_json);
    if (!url && !base64) continue;
    outputs.push({
      url,
      data: base64 ? Buffer.from(base64, "base64") : undefined,
      mime: imageMimeFromHint(asString(entry.output_format) ?? (url ? urlFileExtension(url) : undefined), "image/jpeg"),
      resolution: asString(entry.size),
    });
  }
  const errorObject = isRecord(body.error) ? body.error : null;
  return {
    id: crypto.randomUUID(),
    provider: "volcengine",
    modelId,
    status: outputs.length ? "succeeded" : "failed",
    outputs,
    error: outputs.length
      ? undefined
      : {
          code: asString(errorObject?.code),
          message: asString(errorObject?.message) ?? "火山未返回图片",
        },
    createdAt: asNumber(body.created),
  };
}

function parseVideoTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const content = isRecord(body.content) ? body.content : null;
  const usage = isRecord(body.usage) ? body.usage : null;
  const errorObject = isRecord(body.error) ? body.error : null;
  const taskId = asString(body.id);
  if (!taskId) throw new MediaGenerationApiError("火山视频响应缺少 id", undefined, undefined, "volcengine");
  const videoUrl = content ? asString(content.video_url) : undefined;
  return {
    id: crypto.randomUUID(),
    providerTaskId: taskId,
    provider: "volcengine",
    modelId,
    status: mapStatus(asString(body.status)),
    outputs: videoUrl
      ? [
          {
            url: videoUrl,
            mime: "video/mp4",
            durationSeconds: asNumber(body.duration),
            resolution: asString(body.resolution),
            aspectRatio: asString(body.ratio),
            lastFrameUrl: content ? asString(content.last_frame_url) : undefined,
          },
        ]
      : [],
    error: errorObject
      ? { code: asString(errorObject.code), message: asString(errorObject.message) ?? "火山视频任务失败" }
      : undefined,
    createdAt: asNumber(body.created_at),
    updatedAt: asNumber(body.updated_at),
    // usage 仅记录 token 总量，不落整包
    metadata: usage ? { usage } : undefined,
  };
}

export const volcengineMediaAdapter: MediaProviderAdapter = {
  type: "volcengine",

  async create(ctx, request) {
    const base = ctx.baseUrl.replace(/\/+$/, "");
    const headers = bearerHeaders(ctx.config.apiKey);
    if (ctx.model.kind === "image") {
      const response = await postMediaJson(
        ctx,
        `${base}/images/generations`,
        imageBody(ctx, request),
        { kind: "provider:media:generate" },
        headers,
      );
      return parseImageTask(response, ctx.model.modelId);
    }
    const response = await postMediaJson(
      ctx,
      `${base}/contents/generations/tasks`,
      videoBody(ctx, request),
      { kind: "provider:media:generate" },
      headers,
    );
    return parseVideoTask(response, ctx.model.modelId);
  },

  async query(ctx, providerTaskId) {
    const response = await getMediaJson(
      ctx,
      `${ctx.baseUrl.replace(/\/+$/, "")}/contents/generations/tasks/${encodeURIComponent(providerTaskId)}`,
      { kind: "provider:media:poll" },
      bearerHeaders(ctx.config.apiKey),
    );
    return parseVideoTask(response, ctx.model.modelId);
  },
};
