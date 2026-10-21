// backup/kelivo/options.ts — Kelivo 同步范围（多选）。
// 导入端按用户勾选取舍；导出端不需要范围（Kelivo 备份是一份完整快照）。

import type { KelivoSyncOptions } from "../../foundation/types/settings/storage-config";

export const KELIVO_SYNC_OPTION_KEYS = [
  "conversations",
  "assistants",
  "memories",
  "models",
  "worldBooks",
  "promptInjections",
  "quickMessages",
  "searchServices",
] as const;

export type KelivoSyncOptionKey = (typeof KELIVO_SYNC_OPTION_KEYS)[number];
export type { KelivoSyncOptions };

/** 历史行为：Kelivo 导入只带助手/对话/记忆。没有显式选项时保持这个集合，
 *  避免旧客户端/云恢复路径突然把 providers、世界书等一并写进 PC。 */
export const LEGACY_KELIVO_SYNC_OPTIONS: KelivoSyncOptions = {
  conversations: true,
  assistants: true,
  memories: true,
  models: false,
  worldBooks: false,
  promptInjections: false,
  quickMessages: false,
  searchServices: false,
};

/** 新装默认：全选。用户可在数据管理页逐项取消。 */
export const DEFAULT_KELIVO_SYNC_OPTIONS: KelivoSyncOptions = {
  conversations: true,
  assistants: true,
  memories: true,
  models: true,
  worldBooks: true,
  promptInjections: true,
  quickMessages: true,
  searchServices: true,
};

export function isKelivoSyncOptionKey(value: string): value is KelivoSyncOptionKey {
  return (KELIVO_SYNC_OPTION_KEYS as readonly string[]).includes(value);
}

/** 宽松解析：对象（settings 持久化）或逗号分隔字符串（URL query）。
 *  缺省的键取 fallback；非法键忽略。 */
export function normalizeKelivoSyncOptions(raw: unknown, fallback: KelivoSyncOptions = LEGACY_KELIVO_SYNC_OPTIONS): KelivoSyncOptions {
  const result: KelivoSyncOptions = { ...fallback };
  if (typeof raw === "string") {
    if (raw.trim() === "none") {
      for (const key of KELIVO_SYNC_OPTION_KEYS) result[key] = false;
      return result;
    }
    const selected = new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
    for (const key of KELIVO_SYNC_OPTION_KEYS) {
      if (selected.size > 0) result[key] = selected.has(key);
    }
    return result;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of KELIVO_SYNC_OPTION_KEYS) {
      if (typeof record[key] === "boolean") result[key] = record[key] as boolean;
    }
  }
  return result;
}

export function kelivoSyncOptionsToParam(options: KelivoSyncOptions): string {
  return KELIVO_SYNC_OPTION_KEYS.filter((key) => options[key]).join(",");
}