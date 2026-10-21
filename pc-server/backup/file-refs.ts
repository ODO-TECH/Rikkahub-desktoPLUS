// backup/file-refs.ts — 附件引用扫描/改写与内容指纹(备份 2.0 批5)。
// PC 全系统对附件的引用只有一种形态:/api/files/<id>/content(api/handlers/files.ts 路由;
// 消息 part、工具输出、生图画廊 url、助手头像均是)。generatedImages.fileId 是唯一的
// 纯数字引用,由调用方单独处理。

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import type { JsonValue } from "../foundation/types";

const PC_FILE_URL_RE = /\/api\/files\/(\d+)\/content/g;

// 5-7:分块流式哈希。此前 readFileSync 整读,单附件 >2GiB 撞 Node Buffer 上限直接抛错。
export function hashFileSha256(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const hash = createHash("sha256");
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      let read: number;
      while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 从任意 JSON 文本中收集被引用的文件 id(只增,调用方负责并集)。 */
export function collectPcFileRefs(jsonText: string, into: Set<number>): void {
  for (const m of jsonText.matchAll(PC_FILE_URL_RE)) into.add(Number(m[1]));
}

/** 把安卓 upload 引用改写成 PC 形态。匹配最后一段 upload/<name>(安卓原生 URI 是
 *  file:///data/user/0/me.rerere.rikkahub/files/upload/<name>),文件名在映射里才改写,
 *  未知 URL 原样透传。fileSchemeOnly 供 settings 场景使用:只动 file:// 开头的字符串,
 *  避免用户提示词等普通文本里碰巧出现 "upload/<某文件名>" 被误改。 */
export function rewriteAndroidFileUrl(url: string, map: Map<string, number>, opts: { fileSchemeOnly?: boolean } = {}): string {
  if (opts.fileSchemeOnly && !url.startsWith("file://")) return url;
  const match = url.match(/(?:^|[/\\])upload[/\\]([^/\\?#]+)/);
  if (!match) return url;
  const pcId = map.get(match[1]);
  if (pcId === undefined) return url;
  return `/api/files/${pcId}/content`;
}

/** 深改写任意 JSON 值中的安卓 upload 引用(语义见 rewriteAndroidFileUrl)。 */
export function rewriteAndroidFileUrlsDeep(value: JsonValue, map: Map<string, number>, opts: { fileSchemeOnly?: boolean } = {}): JsonValue {
  if (typeof value === "string") return rewriteAndroidFileUrl(value, map, opts);
  if (Array.isArray(value)) return value.map((v) => rewriteAndroidFileUrlsDeep(v, map, opts));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteAndroidFileUrlsDeep(v as JsonValue, map, opts);
    return out;
  }
  return value;
}

/** 深改写任意 JSON 值中的 /api/files/<id>/content 引用;map 未命中的 id 原样保留。 */
export function rewritePcFileUrlsDeep(value: JsonValue, idMap: Map<number, number>): JsonValue {
  if (typeof value === "string") {
    return value.replace(PC_FILE_URL_RE, (whole, idStr: string) => {
      const mapped = idMap.get(Number(idStr));
      return mapped === undefined ? whole : `/api/files/${mapped}/content`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => rewritePcFileUrlsDeep(v, idMap));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewritePcFileUrlsDeep(v as JsonValue, idMap);
    return out;
  }
  return value;
}
