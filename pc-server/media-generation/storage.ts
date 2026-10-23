// media-generation/storage.ts — 产出落盘（filesDir + state.files）与账本登记

import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filesDir } from "../foundation/paths";
import type { GeneratedMediaRecord, StoredFile } from "../foundation/types";
import { saveState } from "../persistence/json-store";
import { state } from "../persistence/json-store";
import type { MediaKind } from "./types";

const VIDEO_EXT_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

export function mediaExtension(mime: string, kind: MediaKind): string {
  const normalized = mime.split(";")[0]?.trim().toLowerCase();
  if (kind === "video") return VIDEO_EXT_BY_MIME[normalized] ?? ".mp4";
  return IMAGE_EXT_BY_MIME[normalized] ?? ".png";
}

/** 字节写入 filesDir 并登记 state.files；返回新条目。 */
export function saveMediaFile(buffer: Buffer, mime: string, kind: MediaKind): StoredFile {
  const fileId = state.nextFileId++;
  const ext = mediaExtension(mime, kind);
  const fileName = `media-${Date.now()}-${fileId}${ext}`;
  const target = join(filesDir, fileName);
  writeFileSync(target, buffer);
  const entry: StoredFile = { id: fileId, path: target, fileName, mime, size: statSync(target).size };
  state.files.push(entry);
  return entry;
}

export function mediaFileUrl(fileId: number): string {
  return `/api/files/${fileId}/content`;
}

/** 新记录入账（倒序，上限 300）。 */
export function registerMediaRecord(record: GeneratedMediaRecord): GeneratedMediaRecord {
  state.generatedMedia.unshift(record);
  state.generatedMedia = state.generatedMedia.slice(0, 300);
  return record;
}

export function updateMediaRecord(id: string, patch: Partial<GeneratedMediaRecord>): GeneratedMediaRecord | null {
  const record = state.generatedMedia.find((item) => item.id === id);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: Date.now() });
  return record;
}

export function saveMediaState(): void {
  saveState();
}
