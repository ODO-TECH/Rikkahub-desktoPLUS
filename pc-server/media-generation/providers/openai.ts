// media-generation/providers/openai.ts — OpenAI Images（同步）：无参考走 generations，有参考走 multipart edits

import type { JsonValue } from "../../foundation/types";
import { fetchWithTimeout } from "../../foundation/net";
import { addLog } from "../../api/logs";
import type {
  MediaGenerationOutput,
  MediaGenerationRequest,
  MediaGenerationTask,
  MediaProviderAdapter,
  MediaProviderContext,
} from "../types";
import { MediaGenerationApiError } from "../types";
import {
  bearerHeaders,
  imageMimeFromHint,
  inputFileName,
  postMediaJson,
  readInputBuffer,
  MEDIA_HTTP_TIMEOUT_MS,
  asNumber,
  asString,
} from "./http";

const EDIT_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function isGrok(ctx: MediaProviderContext): boolean {
  try {
    const host = new URL(ctx.baseUrl).hostname.toLowerCase();
    if (host === "x.ai" || host.endsWith(".x.ai")) return true;
  } catch {
    // 非法 baseUrl 交给请求层报错
  }
  return ctx.model.modelId.toLowerCase().includes("grok");
}

function resolveSize(ctx: MediaProviderContext, size: string | undefined): string | undefined {
  if (!size || !size.trim() || size.toLowerCase() === "auto") return undefined;
  return isGrok(ctx) ? undefined : size;
}

function commonFields(ctx: MediaProviderContext, request: MediaGenerationRequest): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.extraParameters ?? {})) {
    fields[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  fields.model = ctx.model.modelId;
  fields.prompt = request.prompt?.trim() ?? "";
  if (request.count) fields.n = String(request.count);
  const size = resolveSize(ctx, request.resolution);
  if (size) fields.size = size;
  return fields;
}

function validate(request: MediaGenerationRequest) {
  if (!request.prompt?.trim()) throw new MediaGenerationApiError("OpenAI 图片生成需要非空提示词");
  if (request.aspectRatio) throw new MediaGenerationApiError("OpenAI 图片生成用 resolution 表达比例，不支持 aspectRatio");
  if (request.durationSeconds != null) throw new MediaGenerationApiError("OpenAI 图片生成不支持时长");
  if (request.generateAudio != null) throw new MediaGenerationApiError("OpenAI 图片生成不支持生成音频");
  if (request.watermark != null) throw new MediaGenerationApiError("OpenAI 图片生成不支持水印");
  if (request.seed != null) throw new MediaGenerationApiError("OpenAI 图片生成不支持 seed");
  if (request.promptEnhancement != null) throw new MediaGenerationApiError("OpenAI 图片生成不支持提示词增强");
}

function parseTask(body: Record<string, JsonValue>, modelId: string): MediaGenerationTask {
  const defaultFormat = asString(body.output_format);
  const data = Array.isArray(body.data) ? body.data : [];
  const outputs: MediaGenerationOutput[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, JsonValue>;
    const base64 = asString(item.b64_json)?.replace(/^.*base64,/, "") || undefined;
    const url = asString(item.url) || undefined;
    if (!base64 && !url) continue;
    outputs.push({
      url,
      data: base64 ? Buffer.from(base64, "base64") : undefined,
      mime: imageMimeFromHint(asString(item.output_format) ?? defaultFormat, "image/png"),
      resolution: asString(body.size),
    });
  }
  if (outputs.length === 0) {
    const error = body.error && typeof body.error === "object" && !Array.isArray(body.error)
      ? (body.error as Record<string, JsonValue>)
      : null;
    return {
      id: crypto.randomUUID(),
      provider: "openai",
      modelId,
      status: "failed",
      outputs: [],
      error: {
        code: asString(error?.code),
        message: asString(error?.message) ?? "OpenAI 未返回图片",
      },
    };
  }
  return {
    id: crypto.randomUUID(),
    provider: "openai",
    modelId,
    status: "succeeded",
    outputs,
    createdAt: asNumber(body.created),
  };
}

export const openaiMediaAdapter: MediaProviderAdapter = {
  type: "openai",

  async create(ctx, request) {
    validate(request);
    const base = ctx.baseUrl.replace(/\/+$/, "");
    if (request.inputs.length === 0) {
      const body: Record<string, JsonValue> = {};
      Object.assign(body, request.extraParameters ?? {});
      body.model = ctx.model.modelId;
      body.prompt = request.prompt ?? "";
      if (request.count) body.n = request.count;
      const size = resolveSize(ctx, request.resolution);
      if (size) body.size = size;
      const response = await postMediaJson(
        ctx,
        `${base}/images/generations`,
        body,
        { kind: "provider:media:generate" },
        bearerHeaders(ctx.config.apiKey),
      );
      return parseTask(response, ctx.model.modelId);
    }

    // 有参考图：multipart /images/edits
    const form = new FormData();
    for (const [key, value] of Object.entries(commonFields(ctx, request))) form.append(key, value);
    const field = request.inputs.length === 1 ? "image" : "image[]";
    for (const input of request.inputs) {
      if (input.type !== "image") {
        throw new MediaGenerationApiError("OpenAI 图片编辑只接受图片素材");
      }
      const ext = (input.fileName ?? input.localPath ?? "").split(".").pop()?.toLowerCase() ?? "";
      const mime = EDIT_IMAGE_MIME[ext];
      if (!mime) {
        throw new MediaGenerationApiError("OpenAI 图片编辑只支持 png / jpg / jpeg / webp 素材");
      }
      const buffer = readInputBuffer(input);
      form.append(field, new Blob([new Uint8Array(buffer)], { type: mime }), inputFileName(input, ext || "png"));
    }
    const started = Date.now();
    const headers = bearerHeaders(ctx.config.apiKey);
    const response = await fetchWithTimeout(`${base}/images/edits`, {
      method: "POST",
      headers,
      body: form,
      signal: ctx.signal,
      timeoutMs: MEDIA_HTTP_TIMEOUT_MS,
    });
    const text = await response.text();
    // 不走 postMediaJson:FormData 不能 JSON 序列化进日志,单独记一条 multipart 摘要。
    addLog({
      providerId: ctx.config.id,
      providerName: ctx.config.name,
      url: `${base}/images/edits`,
      ok: response.ok,
      status: response.status,
      kind: "provider:media:generate",
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      requestBody: `multipart image edit\nmodel=${ctx.model.modelId}\nprompt=${request.prompt ?? ""}\ninputs=${request.inputs.length}`,
      responseBody: text.slice(0, 2000),
      error: response.ok ? undefined : text.slice(0, 2000),
    });
    if (!response.ok) {
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as Record<string, JsonValue>;
        const error = parsed.error as Record<string, JsonValue> | undefined;
        message = String(error?.message ?? parsed.message ?? message);
      } catch {
        // 非 JSON 错误体直接用原文
      }
      throw new MediaGenerationApiError(`OpenAI 图片编辑失败 (${response.status}): ${message}`, response.status);
    }
    const parsed = JSON.parse(text || "{}") as Record<string, JsonValue>;
    return parseTask(parsed, ctx.model.modelId);
  },
};
