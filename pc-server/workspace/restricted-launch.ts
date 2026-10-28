// workspace/restricted-launch.ts — 受限档启动编排(S2b)
//
// 只在「首次 Medium 启动」时干活,三种结局:
//   开(设置/部署声明任一为 restricted):把工作区目录标成 Low 可写(labeling.ts,已有
//     标注记录的跳过——icacls 对大目录的传播可达秒级)→ 用低完整性令牌把后端(自己)
//     再拉起一遍(low-integrity.ts)→ 本准备进程干净退出;
//   关:上次受限档留下的标注记录若还在,还原回 Medium,以普通模式继续;
//   启动失败(FFI/标注不成功):还原已做的标注,以不受限模式继续并如实记日志——
//     "降级失败还自称受限"是谎报,绝不发生。
//
// 位置纪律:必须在 dataDir 单实例锁之前调用——准备进程不抢锁,Low 子进程拿锁没有
// 竞态。防自重启循环的硬不变量是环境变量 RIKKAHUB_SANDBOX_LAUNCHED=1
// (buildLowSandboxEnvironment 最后强制写入,子进程走到这里直接跳过)。

import { dataDir } from "../foundation/paths";
import { bootNote } from "../observability/boot-trace";
import { peekSandboxRestricted } from "../persistence/json-store";
import {
  collectFolderWorkspaceRoots,
  readIntegrityLabel,
  readSandboxLabelRecord,
  restoreLabelsFromRecord,
  SandboxLabelOutcome,
  setIntegrityLabels,
  writeSandboxLabelRecord,
} from "./labeling";
import { buildLowSandboxEnvironment, spawnProcessAtLowIntegrity } from "./low-integrity";

export type RestrictedLaunchIntent =
  | "skip" /** 非受限档且无残留,无事可做(常态,零开销) */
  | "child" /** 自己就是 Low 子进程,别再动 */
  | "restore" /** 受限档已关,还原上次残留的标签 */
  | "label_and_relaunch"; /** 受限档:标注 → 自重启 */

/** 触发矩阵(纯函数,单测覆盖)。真实输入来自环境与 state.json 窥探。 */
export function resolveRestrictedLaunchIntent(input: {
  platform: string;
  launched: string | undefined;
  declaredTier: string | undefined;
  toggle: boolean;
  recordExists: boolean;
}): RestrictedLaunchIntent {
  if (input.platform !== "win32") return "skip";
  if (input.launched === "1") return "child";
  const declared = String(input.declaredTier ?? "").trim().toLowerCase();
  const wantRestricted = declared === "restricted" || input.toggle;
  if (wantRestricted) return "label_and_relaunch";
  if (input.recordExists) return "restore";
  return "skip";
}

export type RestrictedLaunchOutcome =
  | { action: "continue" }
  | { action: "restored"; outcome: SandboxLabelOutcome }
  | { action: "relaunched"; pid: number; labeled: string[]; failed: SandboxLabelOutcome["failed"] }
  | { action: "relaunch_failed"; reason: string; restored: SandboxLabelOutcome | null };

/** 启动编排入口。只做决定与执行,不自行退进程——退出策略(bootCleanExit + exit 0)
 *  留给调用方 server.ts,便于此处被测试与将来复用。 */
export function maybeRelaunchForRestrictedSandbox(): RestrictedLaunchOutcome {
  const record = readSandboxLabelRecord(dataDir);
  const intent = resolveRestrictedLaunchIntent({
    platform: process.platform,
    launched: process.env.RIKKAHUB_SANDBOX_LAUNCHED,
    declaredTier: process.env.RIKKAHUB_SANDBOX,
    toggle: peekSandboxRestricted(),
    recordExists: (record?.dirs.length ?? 0) > 0,
  });
  if (intent !== "label_and_relaunch" && intent !== "restore") {
    return { action: "continue" };
  }

  if (intent === "restore") {
    const outcome = restoreLabelsFromRecord(dataDir);
    if (outcome) bootNote("sandboxRestore", `还原 ${outcome.labeled.length} 个目录,失败 ${outcome.failed.length}`);
    return { action: "restored", outcome: outcome ?? { labeled: [], failed: [], durationMs: 0 } };
  }

  // ---- label_and_relaunch ----
  // 记录里已有的目录不再 icacls(标签是粘性文件系统状态;重放秒级传播不可接受)。
  // 代价是记录与真实标签可能脱节(用户手动 icacls 撤了标签)——方向安全:没标成 Low
  // 的目录 agent 写不进去,只是该工作区降级为只读,/api/app/sandbox 的标注汇报行可见。
  const already = new Set((record?.dirs ?? []).map((dir) => dir.toLowerCase()));
  const targets = [dataDir, ...collectFolderWorkspaceRoots()].filter((dir) => !already.has(dir.toLowerCase()));
  const labelOutcome =
    targets.length > 0
      ? setIntegrityLabels(targets, "low")
      : { labeled: [] as string[], failed: [] as SandboxLabelOutcome["failed"], durationMs: 0 };
  for (const failure of labelOutcome.failed) {
    bootNote("sandboxLabelFailed", `${failure.dir}: ${failure.error}`);
  }
  const dirs = [...new Set([...(record?.dirs ?? []), ...labelOutcome.labeled])];
  if (dirs.length > 0) writeSandboxLabelRecord(dataDir, dirs);

  // dataDir 必须实测带 Low 标签——低完整性进程写不了自己的库,标不上就别降级
  // (这条不信任记录:记录说标过不等于现在真是 Low)。
  if (readIntegrityLabel(dataDir) !== "low") {
    const reason = `数据目录完整性标注未生效(${labelOutcome.failed.find((f) => f.dir.toLowerCase() === dataDir.toLowerCase())?.error ?? "icacls 查询非 Low"})`;
    bootNote("sandboxRelaunchAborted", reason);
    const restored = dirs.length > 0 ? restoreLabelsFromRecord(dataDir) : null;
    return { action: "relaunch_failed", reason, restored };
  }

  const spawned = spawnProcessAtLowIntegrity({
    exe: process.execPath,
    args: Bun.argv.slice(1),
    cwd: process.cwd(),
    env: buildLowSandboxEnvironment(dataDir, process.env),
  });
  if (!spawned.ok) {
    bootNote("sandboxRelaunchFailed", spawned.error);
    const restored = dirs.length > 0 ? restoreLabelsFromRecord(dataDir) : null;
    return { action: "relaunch_failed", reason: spawned.error, restored };
  }
  bootNote("sandboxRelaunched", `pid ${spawned.pid},标注 ${dirs.length} 个目录(耗时 ${labelOutcome.durationMs}ms)`);
  return { action: "relaunched", pid: spawned.pid, labeled: dirs, failed: labelOutcome.failed };
}
