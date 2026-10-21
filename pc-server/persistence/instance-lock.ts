// persistence/instance-lock.ts — dataDir 单实例互斥锁(全面审查 1-5)
// Tauri 形态有 single-instance 插件,但 Linux 裸二进制/Docker/CLI 误双开时,第二实例
// 端口自动顺延成功启动,两进程共写同一 dataDir:state.json last-writer-wins 互相覆盖
// (A 实例改的设置被 B 实例的旧内存整包冲掉)。启动时写 pid lockfile:持有者存活则
// 拒绝启动;进程已死/文件损坏视为陈旧锁,直接接管。pid 复用误判(极小概率)接受——
// 审查建议的存活检查级别,不引入进程启动时间比对的复杂度。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../foundation/paths";

const LOCK_FILENAME = "pc-server.lock";

export class DataDirLockedError extends Error {
  constructor(
    readonly holderPid: number,
    readonly lockPath: string,
  ) {
    super(
      `数据目录正被另一个 RikkaHub 实例(PID ${holderPid})使用。` +
        `若确认没有运行中的实例,删除 ${lockPath} 后重试。`,
    );
    this.name = "DataDirLockedError";
  }
}

/** kill(pid, 0) 不发信号只探存活;EPERM 表示进程存在但无权限,同样算活着。 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireDataDirLockIn(dir: string, isPidAlive: (pid: number) => boolean = defaultIsPidAlive): string {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, LOCK_FILENAME);
  if (existsSync(lockPath)) {
    let holderPid = 0;
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      holderPid = Number(parsed.pid) || 0;
    } catch { /* 损坏 → 陈旧锁,接管 */ }
    if (holderPid > 0 && holderPid !== process.pid && isPidAlive(holderPid)) {
      throw new DataDirLockedError(holderPid, lockPath);
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return lockPath;
}

/** 只释放自己持有的锁(pid 匹配才删),避免误删接管者刚写下的锁。 */
export function releaseDataDirLockIn(dir: string): void {
  const lockPath = join(dir, LOCK_FILENAME);
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    if (Number(parsed.pid) === process.pid) rmSync(lockPath);
  } catch { /* 不存在/损坏 → 无需释放 */ }
}

export function acquireDataDirLock(): string {
  return acquireDataDirLockIn(dataDir);
}

export function releaseDataDirLock(): void {
  releaseDataDirLockIn(dataDir);
}
