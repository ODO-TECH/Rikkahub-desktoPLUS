// backup/kelivo/service.ts — 导出侧的开关与文件命名。Kelivo 兼容备份默认开启，
// 用户可在数据管理页关闭；关闭后本地与云备份都不再生成第二份归档。

import { basename, dirname, join } from "node:path";
import { state } from "../../persistence/json-store";
import { createKelivoBackupZipToPath, type KelivoExportResult } from "./encode";

export function kelivoExportEnabled(): boolean {
  return state.settings.exportKelivoBackup !== false;
}

/** 主备份旁边的 Kelivo 归档名：rikkahub-backup-X.zip → kelivo-backup-X.zip；
 *  backup_X.zip → kelivo_backup_X.zip；用户自定义名 → 原名-kelivo.zip。 */
export function kelivoSiblingPath(primaryPath: string): string {
  const dir = dirname(primaryPath);
  const base = basename(primaryPath).replace(/\.zip$/i, "");
  if (base.startsWith("rikkahub-backup-")) return join(dir, `kelivo-backup-${base.slice("rikkahub-backup-".length)}.zip`);
  if (base.startsWith("backup_")) return join(dir, `kelivo_backup_${base.slice("backup_".length)}.zip`);
  return join(dir, `${base}-kelivo.zip`);
}

export function createKelivoBackupIfEnabled(targetPath: string): KelivoExportResult | null {
  if (!kelivoExportEnabled()) return null;
  return createKelivoBackupZipToPath(targetPath);
}