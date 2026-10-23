// media-generation/providers/aliyun.ts — 阿里云百炼
// 图片走多模态生成（同步）；视频走 video-synthesis（异步，X-DashScope-Async）。

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

const PIXEL_SIZE = /^(\d+)\s*[xX*]\s*(\d+)$/;

/** 公共字段写 1536x1024,百炼写 1536*1024；1K / 2K 档位原样下发。 */
function toAliyunSize(size: string): string {
  const match = PIXEL_SIZE.exec(size.trim());
  return match ? `${match[1]}*${match[2]}` : size;
}

function mediaRole(role: string): string {
  if (role === "first_frame") return "first_frame";
  if (role === "last_frame") return "last_frame";
  return "reference_image";
}

function mapVideoStatus(status: string | undefined): MediaTaskStatus {
  switch ((status ?? "").toUpperCase()) {
    case "PENDING":
      return "queued";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    // 百炼的 UNKNOWN = 任务不存在（task_id 只保留 24h）
    case "UNKNOWN":
      return "expired";
    default:
      return "running";
  }
}

function parseImageTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const usage = isRecord(body.usage) ? body.usage : null;
  let resolution: string | undefined;
  if (usage) {
    const size = asString(usage.size);
    if (size) resolution = size.replace(/\*/g, "x");
    else {
      const width = asNumber(usage.output_width) ?? asNumber(usage.width);
      const height = asNumber(usage.output_height) ?? asNumber(usage.height);
      if (width && height) resolution = `${width}x${height}`;
    }
  }
  const urls: string[] = [];
  const output = isRecord(body.output) ? body.output : null;
  const choices = output && Array.isArray(output.choices) ? output.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    const content = choice.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isRecord(item)) continue;
      const url = asString(item.image);
      if (url) urls.push(url);
    }
  }
  const outputs: MediaGenerationOutput[] = urls.map((url) => ({
    url,
    mime: imageMimeFromHint(urlFileExtension(url), "image/png"),
    resolution,
  }));
  return {
    id: crypto.randomUUID(),
    provider: "aliyun",
    modelId,
    status: outputs.length ? "succeeded" : "failed",
    outputs,
    error: outputs.length
      ? undefined
      : {
          code: asString(body.code),
          message: asString(body.message) ?? "阿里云未返回图片",
        },
    metadata: body,
  };
}

function parseVideoTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const output = isRecord(body.output) ? body.output : body;
  const usage = isRecord(body.usage) ? body.usage : null;
  const videoUrl = asString(output.video_url);
  const taskId = asString(output.task_id);
  if (!taskId) throw new MediaGenerationApiError("阿里云视频响应缺少 task_id", undefined, undefined, "aliyun");
  const errorMessage = asString(output.message) ?? asString(body.message);
  return {
    id: crypto.randomUUID(),
    providerTaskId: taskId,
    provider: "aliyun",
    modelId,
    status: mapVideoStatus(asString(output.task_status)),
    outputs: videoUrl
      ? [
          {
            url: videoUrl,
            mime: "video/mp4",
            durationSeconds: usage ? asNumber(usage.output_video_duration) ?? asNumber(usage.duration) : undefined,
            resolution: usage ? asString(usage.SR) : undefined,
            aspectRatio: usage ? asString(usage.ratio) : undefined,
          },
        ]
      : [],
    error: errorMessage ? { code: asString(body.code), message: errorMessage } : undefined,
    metadata: body,
  };
}

function imageBody(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (!request.prompt?.trim()) throw new MediaGenerationApiError("阿里云图片生成需要非空提示词");
  if (request.aspectRatio) throw new MediaGenerationApiError("阿里云图片生成用 resolution 表达比例，不支持 aspectRatio");
  if (request.durationSeconds != null) throw new MediaGenerationApiError("阿里云图片生成不支持时长");
  if (request.generateAudio != null) throw new MediaGenerationApiError("阿里云图片生成不支持生成音频");
  const content: JsonValue[] = [{ text: request.prompt }];
  for (const input of request.inputs) {
    if (input.type !== "image") throw new MediaGenerationApiError("阿里云图片生成只接受图片素材");
    content.push({ image: inputToUrlOrDataUri(input) });
  }
  const parameters: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  if (request.resolution?.trim()) parameters.size = toAliyunSize(request.resolution);
  if (request.count) parameters.n = request.count;
  if (request.watermark != null) parameters.watermark = request.watermark;
  if (request.seed != null) parameters.seed = request.seed;
  if (request.promptEnhancement != null) parameters.prompt_extend = request.promptEnhancement;
  return {
    model: ctx.model.modelId,
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

function videoBody(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, JsonValue> {
  if (request.count != null && request.count !== 1) throw new MediaGenerationApiError("阿里云一次只生成一段视频");
  const input: Record<string, JsonValue> = {};
  if (request.prompt?.trim()) input.prompt = request.prompt;
  if (request.inputs.length > 0) {
    input.media = request.inputs.map((item) => {
      const extra = { ...(item.extra ?? {}) };
      if (item.type === "image") {
        return { ...extra, type: mediaRole(item.role), url: item.url };
      }
      return { ...extra, type: item.type === "video" ? "reference_video" : "reference_audio", url: item.url };
    });
  }
  const parameters: Record<string, JsonValue> = { ...(request.extraParameters ?? {}) };
  if (request.resolution) parameters.resolution = request.resolution;
  if (request.aspectRatio) parameters.ratio = request.aspectRatio;
  if (request.durationSeconds != null) parameters.duration = request.durationSeconds;
  if (request.generateAudio != null) parameters.audio = request.generateAudio;
  if (request.watermark != null) parameters.watermark = request.watermark;
  if (request.seed != null) parameters.seed = request.seed;
  if (request.promptEnhancement != null) parameters.prompt_extend = request.promptEnhancement;
  return { model: ctx.model.modelId, input, parameters };
}

export const aliyunMediaAdapter: MediaProviderAdapter = {
  type: "aliyun",

  async create(ctx, request) {
    const base = ctx.baseUrl;
    const headers = bearerHeaders(ctx.config.apiKey);
    if (ctx.model.kind === "image") {
      const response = await postMediaJson(
        ctx,
        `${base}/services/aigc/multimodal-generation/generation`,
        imageBody(ctx, request),
        { kind: "provider:media:generate" },
        headers,
      );
      return parseImageTask(response, ctx.model.modelId);
    }
    const response = await postMediaJson(
      ctx,
      `${base}/services/aigc/video-generation/video-synthesis`,
      videoBody(ctx, request),
      { kind: "provider:media:generate" },
      { ...headers, "X-DashScope-Async": "enable" },
    );
    return parseVideoTask(response, ctx.model.modelId);
  },

  async query(ctx, providerTaskId) {
    const response = await getMediaJson(
      ctx,
      `${ctx.baseUrl}/tasks/${encodeURIComponent(providerTaskId)}`,
      { kind: "provider:media:poll" },
      bearerHeaders(ctx.config.apiKey),
    );
    return parseVideoTask(response, ctx.model.modelId);
  },
};
