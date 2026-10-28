// workspace/sandbox.ts — 沙盒档位：声明 / 实测 / 汇报（跨平台同一份承诺）
//
// 承诺（受限档一句话）：agent 进程只能写工作区与自身数据目录；其余位置要么写不进去
// （Windows 低完整性内核拦截 / 容器只读根 fs），要么根本看不见（容器未挂载的宿主机路径）。
//
// 两个实现、一份声明、一次实测——这是"两处维护"问题的收口点：
//   - Windows：把 agent 进程降到"低完整性"（Mandatory Integrity Control）。内核的
//     no-write-up 规则让它写不了任何 Medium 及以上的对象；工作区被标成 Low 才可写
//     （icacls /setintegritylevel (OI)(CI)L）。降级需 SeRelabelPrivilege ⇒ 一次管理员授权。
//   - Docker：挂载表就是边界（:rw 只给工作区，其余 :ro 或不挂载）+ 只读根 fs。
// 机制不同、承诺相同，所以"策略"只声明一次，"实测"只有一份探针。
//
// 实测（probe）：
//   Windows = 往 %LOCALAPPDATA%\Temp 写临时文件。写成功 ⇒ 没有边界；写被拒 ⇒ 边界在起作用。
//   Linux/容器 = 读 /proc/self/mounts 判断根 fs 是否 ro。普通用户对 "/" 的 EACCES 只是
//   目录权限不足，不是系统沙盒——把它当成边界会撤销 full_access 和用户批准，正是 Linux
//   CI 曾出现的误判。RIKKAHUB_SANDBOX_PROBE_PATH 在容器内仍可选，用于实测某个"区外代表点"
//   是否真的可写；它写得进去说明存在 rw 例外，不能再宣称全局边界。
// 注意：不能用 os.tmpdir()——启动时 TEMP/TMP 已被改道到 dataDir/tmp（那正是区内可写处），
// 用它探针会永远得出"没有边界"的假阴性。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../foundation/paths";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "../foundation/platform";
import { collectFolderWorkspaceRoots, readSandboxLabelRecord } from "./labeling";

export type SandboxTier = "off" | "restricted" | "full";
export type SandboxMeasurement = "enforced" | "not_enforced" | "unknown";

export interface SandboxStatus {
  /** 部署声明的档位（RIKKAHUB_SANDBOX）：off=不设边界 / restricted=受约束 / full=不受约束 */
  tier: SandboxTier;
  /** 实测结论：enforced=边界在起作用 / not_enforced=没有边界 / unknown=探针无法判定 */
  measured: SandboxMeasurement;
  /** 实测边界是否生效（= measured === "enforced"）。权限层据此决定要不要给出"区外写入"的承诺。 */
  boundaryActive: boolean;
  /** 区内（数据目录）是否可写。false 表示部署本身坏了（连自己的数据都写不进去） */
  insideWritable: boolean;
  /** 探针位置（区外代表点） */
  probePath: string;
  /** 探针失败原因（写不进去时的 errno/错误码），成功则为空 */
  probeError: string;
  /** 边界机制：windows_integrity / container_mounts / none */
  mechanism: "windows_integrity" | "container_mounts" | "none";
  /** 标为 rw 的挂载点（不代表当前 uid 一定可写；Windows 恒空——由内核按完整性级别决定） */
  rwMounts: string[];
  /** 声明与实测的差异说明（无差异则为空数组） */
  notes: string[];
  checkedAt: number;
}

function normalizeTier(raw: string | undefined): SandboxTier {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "restricted" || value === "full" || value === "off") return value;
  return "off";
}

/** 默认探针位置：Windows 用真实用户临时目录（Medium 标签，低完整性进程写不进去）。
 *  Linux/容器不再默认往 "/" 写——边界由根 fs 的 ro 挂载判定，普通目录权限不是沙盒；
 *  需要实测某个区外代表点时，由 RIKKAHUB_SANDBOX_PROBE_PATH 显式指定。 */
function defaultProbePath(): string {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const userProfile = process.env.USERPROFILE?.trim();
  const base = localAppData || userProfile;
  return base ? join(base, "Temp") : "";
}

function probeWrite(dir: string, tag: string): { ok: boolean; error: string; missing: boolean } {
  if (!existsSync(dir)) {
    // 探针位置不存在 ⇒ 无从判定（不能新建：新建本身就是一次环境改动，
    // 而且会把"目录缺失"误判成"边界生效"）。
    return { ok: false, error: "probe path does not exist", missing: true };
  }
  const target = join(dir, `.rikkahub-sandbox-probe-${tag}.tmp`);
  try {
    writeFileSync(target, "probe");
    rmSync(target, { force: true });
    return { ok: true, error: "", missing: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    const message = err instanceof Error ? err.message : String(err);
    try {
      rmSync(target, { force: true });
    } catch {
      // 清不掉就算了（探针文件残留无害）
    }
    return { ok: false, error: code ? `${code}: ${message}` : message, missing: false };
  }
}

function detectMechanism(): SandboxStatus["mechanism"] {
  if (RUNNING_IN_CONTAINER) return "container_mounts";
  if (RUNTIME_PLATFORM === "win") return "windows_integrity";
  return "none";
}

export interface LinuxMountSummary {
  /** 根 fs 的挂载标志：true=ro / false=rw / null=读不到或无法解析 */
  rootReadOnly: boolean | null;
  /** 标为 rw 的挂载点（只描述挂载标志，不保证当前 uid 有写权限） */
  rwMounts: string[];
}

function unescapeMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
}

/** 解析 /proc/self/mounts：根 fs 的 ro 标志是容器边界的可靠依据；普通目录权限不是。
 *  导出为纯函数，平台无关地覆盖 Linux 判定分支。 */
export function summarizeLinuxMounts(raw: string): LinuxMountSummary {
  let rootReadOnly: boolean | null = null;
  const rwMounts: string[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 4) continue;
    const mountPoint = unescapeMountPath(parts[1]);
    const fstype = parts[2];
    const options = parts[3].split(",");
    if (mountPoint === "/") {
      if (options.includes("ro")) rootReadOnly = true;
      else if (options.includes("rw")) rootReadOnly = false;
      continue;
    }
    if (!options.includes("rw")) continue;
    if (fstype === "tmpfs") continue;
    rwMounts.push(mountPoint);
  }
  return { rootReadOnly, rwMounts };
}

function linuxMountSummary(): LinuxMountSummary {
  try {
    return summarizeLinuxMounts(readFileSync("/proc/self/mounts", "utf8"));
  } catch {
    return { rootReadOnly: null, rwMounts: [] };
  }
}

let cached: SandboxStatus | null = null;

/** Windows 完整性标签现状汇报。依据是 pc-data/sandbox-labels.json 记录(标注成功者
 *  才进记录,见 labeling.ts):受限档下对照"本应标注的目录"逐个报 成功/未标注;
 *  非受限档下若记录仍在,说明上次还原没做完,点名残留。 */
function integrityLabelNotes(tier: SandboxTier): string[] {
  const record = readSandboxLabelRecord(dataDir);
  const expected = [dataDir, ...collectFolderWorkspaceRoots()];
  if (tier === "restricted") {
    const labeledSet = new Set((record?.dirs ?? []).map((dir) => dir.toLowerCase()));
    const labeled = expected.filter((dir) => labeledSet.has(dir.toLowerCase()));
    const notLabeled = expected.filter((dir) => !labeledSet.has(dir.toLowerCase()));
    const parts = [`完整性标签:成功标注 ${labeled.length} 个目录`];
    if (labeled.length > 0) parts.push(`已标为 Low 可写:${labeled.join("、")}`);
    if (notLabeled.length > 0) parts.push(`未标注(标注失败或尚未标注,见启动日志):${notLabeled.join("、")}`);
    return [parts.join(";") + "。"];
  }
  if (record && record.dirs.length > 0) {
    return [`上次受限档的标注残留 ${record.dirs.length} 个目录仍为 Low(还原未完成,下次启动会重试):${record.dirs.join("、")}。`];
  }
  return [];
}

/** 实测一次并缓存。幂等：重复调用返回同一份结论（探针只写一个临时文件，代价可忽略，
 *  但结论必须稳定，否则 UI 上的"受限中"会跳变）。 */
export function initSandbox(): SandboxStatus {
  if (cached) return cached;
  const tier = normalizeTier(process.env.RIKKAHUB_SANDBOX);
  const explicitProbePath = process.env.RIKKAHUB_SANDBOX_PROBE_PATH?.trim() || "";
  const explicitProbe = Boolean(explicitProbePath);
  const mechanism = detectMechanism();
  // 只有 Windows 与显式指定的容器探针才真正落盘；其余情况 probePath 留空，
  // 免得把"没做过的探针"报成一个看起来执行过的位置。
  const probePath = explicitProbePath || (mechanism === "windows_integrity" ? defaultProbePath() : "");
  const notes: string[] = [];
  const linuxMounts = mechanism === "container_mounts" ? linuxMountSummary() : null;
  const outside =
    mechanism === "windows_integrity" || (mechanism === "container_mounts" && explicitProbe)
      ? probeWrite(probePath, "outside")
      : { ok: false, error: "", missing: false };
  // 区内探针前先确保数据目录存在：首次启动时它还没被建出来（json-store 稍后才建），
  // 目录不存在会被判成"探针位置缺失"→unknown，等于把首启误报成"测不出"。
  // 建自己的数据目录不改变环境——应用本来就要建它。
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    // 建不出来（比如只读挂载）就交给下面 inside 探针报错
  }
  const inside = probeWrite(dataDir, "inside");
  const rwMounts = linuxMounts?.rwMounts ?? [];

  let measured: SandboxMeasurement;
  if (mechanism === "windows_integrity") {
    measured = outside.ok ? "not_enforced" : "enforced";
    if (outside.missing) {
      measured = "unknown";
      notes.push(
        probePath
          ? `探针位置不存在(${probePath}):无法判定边界是否生效。`
          : "未找到 Windows 用户临时目录(LOCALAPPDATA/USERPROFILE):无法判定边界是否生效。",
      );
    }
  } else if (mechanism === "container_mounts") {
    if (linuxMounts?.rootReadOnly === true) {
      measured = explicitProbe && outside.ok ? "not_enforced" : "enforced";
      notes.push("容器根 fs 为只读挂载，区外写入由挂载表拒绝。");
      if (explicitProbe && outside.ok) {
        notes.push(`探针位置可写(${probePath}):存在 rw 例外挂载，不能宣称全局边界。`);
      } else if (explicitProbe && outside.missing) {
        notes.push(`探针位置不存在(${probePath}):不影响根 fs 只读的判定。`);
      }
    } else if (linuxMounts?.rootReadOnly === false) {
      measured = "not_enforced";
      notes.push("容器根 fs 为可写挂载，无法据此认定系统边界生效(普通目录权限不足不等于沙盒)。");
    } else {
      measured = "unknown";
      notes.push("无法读取 /proc/self/mounts 的根 fs 挂载标志，不能判定容器边界。");
    }
  } else {
    // Linux 桌面没有低完整性/挂载表这类系统级边界机制；"/" 的 EACCES 只是权限不足。
    measured = "not_enforced";
  }
  if (!inside.ok) {
    // 区内都写不进去：探针结论不可信（部署坏了，不是边界在起作用）。
    measured = "unknown";
    notes.push(`数据目录不可写(${inside.error})：部署本身有问题，边界结论不可信。`);
  }
  if (tier === "restricted" && measured === "not_enforced") {
    notes.push(
      mechanism === "none"
        ? "声明为受限档，但当前平台没有可用的系统级沙盒机制(仅 Windows 低完整性和容器挂载部署支持)。"
        : "声明为受限档，但实测没有系统边界:区外仍可能可写(检查容器 read_only 与挂载表)。",
    );
  }
  if (tier !== "restricted" && measured === "enforced") {
    notes.push(
      mechanism === "container_mounts"
        ? `声明为${tier === "full" ? "完全访问" : "不设边界"}档，但容器根 fs 实际为只读:区外写入仍受系统限制。`
        : `声明为${tier === "full" ? "完全访问" : "不设边界"}档，但区外探针写入被拒:该位置实际受保护。`,
    );
  }
  if (tier === "restricted" && measured === "unknown") {
    notes.push("受限档无法确认边界是否生效(见上一条)。");
  }
  if (mechanism === "container_mounts") {
    notes.push(
      rwMounts.length > 0
        ? `容器内 rw 挂载点(仍受目录属主与权限约束):${rwMounts.join("、")};未挂载的宿主路径 agent 根本看不见。`
        : "容器内未发现 rw 挂载(根 fs 只读时属正常);未挂载的宿主路径 agent 根本看不见。",
    );
  }
  if (mechanism === "windows_integrity") {
    notes.push(...integrityLabelNotes(tier));
  }

  cached = {
    tier,
    measured,
    boundaryActive: measured === "enforced",
    insideWritable: inside.ok,
    probePath,
    probeError: !outside.ok && (outside.missing || outside.error) ? outside.error : "",
    mechanism,
    rwMounts,
    notes,
    checkedAt: Date.now(),
  };
  return cached;
}

/** 当前沙盒状态（未初始化则就地初始化一次）。 */
export function sandboxStatus(): SandboxStatus {
  return cached ?? initSandbox();
}

/** 实测边界是否生效。权限层用它决定"要不要给区外写入的承诺"：
 *  边界生效时，内核/挂载表会替我们拒绝区外写入，应用层就不能再弹"允许一次写区外"——
 *  给做不到的承诺比不给更糟。 */
export function sandboxBoundaryActive(): boolean {
  return sandboxStatus().boundaryActive;
}

/** 供测试与脚本重置缓存（生产路径不会调用）。 */
export function resetSandboxCacheForTests(): void {
  cached = null;
}
