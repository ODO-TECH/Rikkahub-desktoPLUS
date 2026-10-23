// media-generation/s3-upload.ts — 视频类接口的本地素材 → 公网临时 URL
// 独立 uploadS3Config 桶（与备份桶分离，对齐移动端）。未配置时的错误文案必须可操作。

import { createHash } from "node:crypto";
import { s3PresignUrl, s3PutObject } from "../backup/storage";
import { state } from "../persistence/json-store";
import type { S3Config } from "../foundation/types";
import type { MediaInput } from "./types";
import { MediaGenerationApiError } from "./types";
import { inputMime, readInputBuffer } from "./providers/http";

const PRESIGN_SECONDS = 24 * 60 * 60;
const UPLOAD_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

const uploadCache = new Map<string, { url: string; expiresAt: number }>();

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
};

export function uploadS3Config(): S3Config | null {
  const config = state.settings.uploadS3Config;
  if (!config) return null;
  if (!config.bucket.trim() || !config.accessKeyId.trim() || !config.secretAccessKey.trim()) return null;
  return config;
}

export function uploadS3MissingMessage(): string {
  return "视频参考素材需要公网地址：请先在 设置 → 媒体 → 上传与存储 配置 S3";
}

function uploadKey(sha: string, mime: string): string {
  return `rikkahub_uploads/${sha}${EXT_BY_MIME[mime] ?? ""}`;
}

/** 本地素材上传到 S3 并预签名；已有公网 URL 的素材原样返回。 */
export async function publishInputToS3(input: MediaInput, signal?: AbortSignal): Promise<MediaInput> {
  if (!input.localPath) return input;
  const config = uploadS3Config();
  if (!config) throw new MediaGenerationApiError(uploadS3MissingMessage());
  if (signal?.aborted) throw new MediaGenerationApiError("媒体生成已停止");
  const buffer = readInputBuffer(input);
  const mime = inputMime(input);
  const sha = createHash("sha256").update(buffer).digest("hex");
  const cached = uploadCache.get(sha);
  if (cached && cached.expiresAt > Date.now()) return { ...input, url: cached.url };
  const key = uploadKey(sha, mime);
  await s3PutObject(config, key, buffer, mime);
  const url = s3PresignUrl(config, key, PRESIGN_SECONDS);
  uploadCache.set(sha, { url, expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS });
  return { ...input, url };
}
