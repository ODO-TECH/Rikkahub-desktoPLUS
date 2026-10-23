// media-generation/providers/http.ts — 媒体适配器共用的出站请求、日志与素材编码
// 与 5 家适配器一一对应的小工具，不承载业务语义。

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { JsonValue } from "../../foundation/types";
import { fetchWithTimeout } from "../../foundation/net";
import { isRecord } from "../../foundation/utils";
import { addLog } from "../../api/logs";
import { jsonBody, textBody } from "../../model-providers";
import type { MediaInput, MediaProviderContext } from "../types";
import { MediaGenerationApiError } from "../types";

export const MEDIA_HTTP_TIMEOUT_MS = 120_000;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 180_000;

export interface MediaHttpLogInfo {
  providerId: string;
  providerName: string;
  kind: string;
  url: string;
}

function errorFields(body: Record<string, JsonValue>): { code?: string; message?: string } {
  const error = isRecord(body.error) ? body.error : null;
  const output = isRecord(body.output) ? body.output : null;
  const code = error ? error.code ?? error.type : body.code;
  const message = (error?.message ?? body.message ?? output?.message ?? body.msg) as unknown;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

export function bearerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/** POST JSON 并解析响应。非 2xx 抛 MediaGenerationApiError（带 provider 原始 message）。 */
export async function postMediaJson(
  ctx: MediaProviderContext,
  url: string,
  body: unknown,
  log: Omit<MediaHttpLogInfo, "url" | "providerId" | "providerName">,
  headers: Record<string, string> = {},
): Promise<Record<string, JsonValue>> {
  const started = Date.now();
  const requestHeaders = { "Content-Type": "application/json", ...headers };
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: ctx.signal,
      timeoutMs: MEDIA_HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    addLog({
      providerId: ctx.config.id,
      providerName: ctx.config.name,
      url,
      ok: false,
      status: 0,
      kind: log.kind,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders,
      requestBody: jsonBody(body),
      error: textBody(String(err)),
    });
    throw err;
  }
  const text = await response.text();
  addLog({
    providerId: ctx.config.id,
    providerName: ctx.config.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: log.kind,
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: jsonBody(body),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  return parseJsonResponse(response, text, ctx);
}

export async function getMediaJson(
  ctx: MediaProviderContext,
  url: string,
  log: Omit<MediaHttpLogInfo, "url" | "providerId" | "providerName">,
  headers: Record<string, string> = {},
): Promise<Record<string, JsonValue>> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "GET",
      headers,
      signal: ctx.signal,
      timeoutMs: MEDIA_HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    addLog({
      providerId: ctx.config.id,
      providerName: ctx.config.name,
      url,
      ok: false,
      status: 0,
      kind: log.kind,
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: headers,
      error: textBody(String(err)),
    });
    throw err;
  }
  const text = await response.text();
  addLog({
    providerId: ctx.config.id,
    providerName: ctx.config.name,
    url,
    ok: response.ok,
    status: response.status,
    kind: log.kind,
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  return parseJsonResponse(response, text, ctx);
}

function parseJsonResponse(response: Response, text: string, ctx: MediaProviderContext): Record<string, JsonValue> {
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  const body = isRecord(parsed) ? (parsed as Record<string, JsonValue>) : {};
  if (!response.ok) {
    const { code, message } = errorFields(body);
    throw new MediaGenerationApiError(
      `${ctx.config.name} 媒体请求失败 (${response.status}${code ? `, ${code}` : ""}): ${message ?? text.slice(0, 500)}`,
      response.status,
      code,
      ctx.config.type,
    );
  }
  return body;
}

/** 下载产出。返回字节与推测的 MIME。 */
export async function downloadMedia(
  ctx: MediaProviderContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ buffer: Buffer; mime: string }> {
  const started = Date.now();
  const response = await fetchWithTimeout(url, { headers, signal: ctx.signal, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    addLog({
      providerId: ctx.config.id,
      providerName: ctx.config.name,
      url,
      ok: false,
      status: response.status,
      kind: "provider:media:download",
      durationMs: Date.now() - started,
      method: "GET",
      requestHeaders: headers,
      responseBody: textBody(text),
      error: textBody(text),
    });
    throw new MediaGenerationApiError(
      `下载生成结果失败 (${response.status}): ${text.slice(0, 300) || url}`,
      response.status,
      undefined,
      ctx.config.type,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "";
  addLog({
    providerId: ctx.config.id,
    providerName: ctx.config.name,
    url,
    ok: true,
    status: response.status,
    kind: "provider:media:download",
    durationMs: Date.now() - started,
    method: "GET",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
  });
  return { buffer, mime };
}

const IMAGE_MIME_BY_HINT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
};

/** 从 output_format / URL 扩展名 / Content-Type 推 MIME。 */
export function imageMimeFromHint(hint: string | undefined, fallback: string): string {
  if (!hint) return fallback;
  const value = hint.toLowerCase().trim().replace(/^\./, "");
  if (value.startsWith("image/")) return value;
  return IMAGE_MIME_BY_HINT[value] ?? fallback;
}

/** URL 或文件路径的扩展名（不含点）。 */
export function urlFileExtension(url: string): string | undefined {
  try {
    const pathname = /^https?:\/\//i.test(url) ? new URL(url).pathname : url;
    const ext = extname(pathname).replace(/^\./, "").toLowerCase();
    if (ext) return ext;
  } catch {
    // URL 解析失败按无扩展名处理
  }
  return undefined;
}

export function mimeForExtension(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "mp4" || e === "m4v") return "video/mp4";
  if (e === "webm") return "video/webm";
  if (e === "mov") return "video/quicktime";
  if (e === "mp3") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "m4a") return "audio/mp4";
  return IMAGE_MIME_BY_HINT[e] ?? "application/octet-stream";
}

export function inputMime(input: MediaInput): string {
  if (input.mime) return input.mime;
  const ext = input.localPath ? extname(input.localPath).replace(/^\./, "") : urlFileExtension(input.url);
  return mimeForExtension(ext ?? "");
}

export function inputFileName(input: MediaInput, fallbackExt: string): string {
  if (input.fileName) return input.fileName;
  if (input.localPath) return basename(input.localPath);
  return `input.${fallbackExt}`;
}

export function readInputBuffer(input: MediaInput): Buffer {
  if (!input.localPath) throw new MediaGenerationApiError(`素材 ${input.url} 缺少本地文件，无法上传`);
  return readFileSync(input.localPath);
}

/** 本地素材转 data URI；已是 http/data URL 的原样返回。 */
export function inputToUrlOrDataUri(input: MediaInput): string {
  if (!input.localPath) return input.url;
  const mime = inputMime(input);
  return `data:${mime};base64,${readInputBuffer(input).toString("base64")}`;
}

/** MiniMax / OpenRouter：结果地址与 baseUrl 同源时带 Bearer，否则原样下载。 */
export function sameOriginBearer(baseUrl: string, apiKey: string, url: string): Record<string, string> {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    const sameOrigin =
      target.protocol === base.protocol && target.hostname === base.hostname && target.port === base.port;
    return sameOrigin ? { Authorization: `Bearer ${apiKey}` } : {};
  } catch {
    return {};
  }
}

export function asNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
