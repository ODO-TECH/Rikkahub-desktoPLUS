// 1-5 回归:dataDir 单实例互斥锁。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataDirLockedError, acquireDataDirLockIn, releaseDataDirLockIn } from "./instance-lock";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "rikka-lock-"));
}

describe("dataDir 互斥锁(1-5)", () => {
  test("无锁时获取成功并写入自己的 pid", () => {
    const dir = makeDir();
    try {
      const lockPath = acquireDataDirLockIn(dir);
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(parsed.pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("持有者存活时拒绝启动,报错含 PID 与锁路径", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "pc-server.lock"), JSON.stringify({ pid: 99999, startedAt: 1 }));
      expect(() => acquireDataDirLockIn(dir, () => true)).toThrow(DataDirLockedError);
      try {
        acquireDataDirLockIn(dir, () => true);
      } catch (err) {
        expect((err as DataDirLockedError).holderPid).toBe(99999);
        expect((err as DataDirLockedError).message).toContain("99999");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("持有者已死(陈旧锁)→ 接管", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "pc-server.lock"), JSON.stringify({ pid: 99999, startedAt: 1 }));
      const lockPath = acquireDataDirLockIn(dir, () => false);
      const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      expect(parsed.pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("锁文件损坏 → 视为陈旧,接管", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "pc-server.lock"), "not-json{{{");
      const lockPath = acquireDataDirLockIn(dir, () => true);
      expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("释放只删自己的锁;他人锁不动", () => {
    const dir = makeDir();
    try {
      acquireDataDirLockIn(dir);
      releaseDataDirLockIn(dir);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(false);

      writeFileSync(join(dir, "pc-server.lock"), JSON.stringify({ pid: 99999 }));
      releaseDataDirLockIn(dir);
      expect(existsSync(join(dir, "pc-server.lock"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("同进程重复获取(重启内部逻辑)不自锁", () => {
    const dir = makeDir();
    try {
      acquireDataDirLockIn(dir);
      expect(() => acquireDataDirLockIn(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
