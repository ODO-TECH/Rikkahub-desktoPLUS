// workspace/labeling.ts — 完整性标签管理(icacls 包装,免提权,Windows 专用)
//
// 职责:把目录在 Low/Medium 完整性标签之间切换,并维护 pc-data/sandbox-labels.json
// 记录"当前被我们标成 Low 的目录清单"。这份清单有两个用途:
//   1. 快路径——标签是粘性文件系统状态,标过一次会一直在;清单里已有的目录下次
//      启动不再重复 icacls(对大目录的递归传播耗时可达秒级,每次启动都跑不可接受);
//   2. 还原路径——用户关掉受限档后,下一次 Medium 启动按清单把标签还原回 Medium,
//      不让用户目录长期停留在低完整性级别(Low 标签不削弱 DACL,但语义上应还原)。
//
// 事实依据(本机实测,tools/sandbox-spike):
//   - icacls /setintegritylevel 降 Low / 还原 Medium 都只要属主权限,免提权;
//   - (OI)(CI) 继承会传播到既有子文件(老文件不会"留在 Medium 上写不进去");
//   - Medium 进程写 Low 目录照常——所以"标注后 spawn 失败、以 Medium 继续跑"无害。
//
// 纪律:spawnSync 一律用参数数组,目录路径(含用户自选的 folder 工作区 root)绝不拼进
// 命令字符串;标签操作全部 best-effort,单目录失败记录、不中断其余目录。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { conversationsDbPath } from "../foundation/paths";

export interface SandboxLabelOutcome {
  /** 操作成功的目录 */
  labeled: string[];
  /** 操作失败的目录与原因(缺目录/icacls 非零退出) */
  failed: Array<{ dir: string; error: string }>;
  durationMs: number;
}

export interface SandboxLabelRecord {
  version: 1;
  /** 当前被我们标成 Low 的目录(绝对路径) */
  dirs: string[];
  at: number;
}

export function sandboxLabelsPath(dataDir: string): string {
  return join(dataDir, "sandbox-labels.json");
}

function isWindows(): boolean {
  return process.platform === "win32";
}

/** icacls 参数数组形态——安全纪律:路径只走 argv,不进命令字符串。 */
function icacls(dir: string, level: "L" | "M"): { code: number | null; stderr: string } {
  if (!isWindows()) return { code: null, stderr: "not windows" };
  const proc = Bun.spawnSync({
    cmd: ["icacls", dir, "/setintegritylevel", `(OI)(CI)${level}`],
    stdout: "ignore",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stderr: proc.stderr.toString() };
}

/** 批量设置完整性标签。目录不存在记失败;icacls 非零退出记失败;彼此独立、不中断。 */
export function setIntegrityLabels(dirs: Iterable<string>, level: "low" | "medium"): SandboxLabelOutcome {
  const started = Date.now();
  const seen = new Set<string>();
  const labeled: string[] = [];
  const failed: SandboxLabelOutcome["failed"] = [];
  for (const raw of dirs) {
    const dir = raw.trim();
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if (!existsSync(dir)) {
      failed.push({ dir, error: "directory does not exist" });
      continue;
    }
    const result = icacls(dir, level === "low" ? "L" : "M");
    if (result.code === 0) labeled.push(dir);
    else failed.push({ dir, error: result.code === null ? result.stderr : `icacls exit ${result.code}` });
  }
  return { labeled, failed, durationMs: Date.now() - started };
}

/** 查询单个目录当前的完整性标签。icacls 输出按 OEM 代码页编码,但标签行
 *  ("Mandatory Label\Low Mandatory Level")是纯 ASCII,任意代码页下按子串匹配即可。
 *  注意:Medium 是隐式默认,从未标注过的目录没有标签行 ⇒ 读回 "unknown"
 *  (不算错——"unknown" 对调用方的语义只是"需要标注/重新标注")。
 *  其余判不出情形(unusual 标签/解析失败)同样返回 "unknown"。 */
export function readIntegrityLabel(dir: string): "low" | "medium" | "unknown" {
  if (!isWindows() || !existsSync(dir)) return "unknown";
  const proc = Bun.spawnSync({ cmd: ["icacls", dir], stdout: "pipe", stderr: "ignore" });
  const output = proc.stdout.toString("latin1");
  if (output.includes("Low Mandatory Level")) return "low";
  if (output.includes("Medium Mandatory Level")) return "medium";
  return "unknown";
}

// ---- 记录文件(sandbox-labels.json) ----

export function readSandboxLabelRecord(dataDir: string): SandboxLabelRecord | null {
  try {
    const raw = JSON.parse(readFileSync(sandboxLabelsPath(dataDir), "utf8")) as Partial<SandboxLabelRecord>;
    if (raw?.version !== 1 || !Array.isArray(raw.dirs)) return null;
    return { version: 1, dirs: raw.dirs.filter((item): item is string => typeof item === "string"), at: Number(raw.at ?? 0) };
  } catch {
    return null;
  }
}

export function writeSandboxLabelRecord(dataDir: string, dirs: string[]): void {
  writeFileSync(sandboxLabelsPath(dataDir), JSON.stringify({ version: 1, dirs, at: Date.now() } satisfies SandboxLabelRecord, null, 2));
}

function clearSandboxLabelRecord(dataDir: string): void {
  try {
    rmSync(sandboxLabelsPath(dataDir), { force: true });
  } catch {
    // 删不掉无害:下次启动会再走一遍还原
  }
}

/** 按记录还原标签(Medium 启动时调用)。还原成功的目录从记录中移除;全部还原干净后
 *  删除记录文件。返回 null 表示没有记录(无需还原)。 */
export function restoreLabelsFromRecord(dataDir: string): SandboxLabelOutcome | null {
  const record = readSandboxLabelRecord(dataDir);
  if (!record || record.dirs.length === 0) return null;
  const outcome = setIntegrityLabels(record.dirs, "medium");
  const remaining = record.dirs.filter((dir) => !outcome.labeled.some((ok) => ok.toLowerCase() === dir.toLowerCase()));
  if (remaining.length === 0) clearSandboxLabelRecord(dataDir);
  else writeSandboxLabelRecord(dataDir, remaining);
  return outcome;
}

// ---- folder 工作区收集(prepare 阶段在 bootstrap 之前用,只读窥视活库) ----

/** 读取所有 folder 型工作区的边界根。只读短连接,不与 bootstrap 的主连接重叠
 *  (调用点在锁释放、主连接打开之前);库文件/表不存在(首次安装)返回空表。
 *  managed 型根在 dataDir/workspaces/ 下,随 dataDir 整体标注,不用单独收集;
 *  ssh 型边界根在远端,本机标不了。 */
export function collectFolderWorkspaceRoots(dbPath: string = conversationsDbPath): string[] {
  if (!isWindows() || !existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pc_workspace'")
      .get() as { name: string } | null;
    if (!table) return [];
    const rows = db
      .prepare("SELECT root FROM pc_workspace WHERE type = 'folder' AND root != ''")
      .all() as { root: string }[];
    return rows.map((row) => row.root).filter((root) => isAbsoluteWindowsPath(root));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function isAbsoluteWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}
