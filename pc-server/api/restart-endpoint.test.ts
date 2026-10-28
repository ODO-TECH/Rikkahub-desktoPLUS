// S2b 补充回归:外挂后端自重启端点。
// 壳会 attach 到端口上已有的后端(dev 实例/残留旧实例),此时壳的 rikkahub://restart
// 因不持有进程句柄直接返回——受限沙盒开关永远等不到下一次真正的启动编排。端点契约:
// 刷盘/释放端口与锁后旧进程退出 0,替代进程在同一端口以新 pid 就绪;容器/壳管后端/
// 低完整性关沙盒三种场景明确拒绝且服务不停。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dir, "..", "server.ts");

type ServerProc = ReturnType<typeof Bun.spawn>;

function spawnServer(port: number, env: Record<string, string> = {}): ServerProc {
  const dataDir = mkdtempSync(join(tmpdir(), "rkh-restart-e2e-"));
  return Bun.spawn([process.execPath, serverEntry, "--port", String(port), "--no-open"], {
    env: {
      ...process.env,
      RIKKAHUB_PC_DATA_DIR: dataDir,
      RIKKAHUB_ANALYTICS: "0",
      // 清掉测试宿主可能带进来的标记,保证默认走"Medium 外挂后端"。
      RIKKAHUB_SHELL: "",
      RIKKAHUB_SANDBOX_LAUNCHED: "",
      RIKKAHUB_CONTAINER: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readHealth(port: number): Promise<{ pid?: number; spawnedByShell?: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return (await res.json()) as { pid?: number; spawnedByShell?: boolean };
  } catch {
    return null;
  }
}

/** 替代进程的 stdout 被忽略,只能轮询就绪闸门确认它已开始服务。 */
async function waitForReadyPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/startup/status`);
      const status = (await res.json()) as { ready?: boolean; failed?: boolean; error?: string };
      if (status.failed) throw new Error(`替代进程引导失败:${String(status.error ?? "")}`);
      if (status.ready) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("替代进程引导失败")) throw err;
    }
    await Bun.sleep(50);
  }
  throw new Error("替代进程超时未就绪");
}

async function shutdownQuietly(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/app/shutdown`, { method: "POST" });
  } catch {
    // 端口上已经没有服务(或正在退出)——收尾时无妨。
  }
}

describe("POST /api/app/restart(外挂后端自重启)", () => {
  test("旧进程退出 0,替代进程在同一端口以新 pid 就绪", async () => {
    const proc = spawnServer(18280);
    let port = 18280;
    try {
      port = await waitForServerReady(proc);
      const before = await readHealth(port);
      expect(before?.pid).toBe(proc.pid as number);
      expect(before?.spawnedByShell).toBe(false);

      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; pid: number; restarting: boolean };
      expect(body.ok).toBe(true);
      expect(body.restarting).toBe(true);
      expect(body.pid).toBe(proc.pid as number);

      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("旧进程 10s 内未退出")), 10_000)),
      ]);
      expect(exitCode).toBe(0);

      await waitForReadyPort(port);
      const after = await readHealth(port);
      expect(typeof after?.pid).toBe("number");
      expect(after?.pid).not.toBe(before?.pid);
    } finally {
      proc.kill();
      // 替代进程是 detached 的,必须显式停掉,否则留孤儿占着端口与数据目录锁。
      await shutdownQuietly(port);
    }
  }, 60_000);

  test("带代理转发头的请求被拒绝,服务不重启", async () => {
    const proc = spawnServer(18281);
    let port = 18281;
    try {
      port = await waitForServerReady(proc);
      const before = await readHealth(port);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, {
        method: "POST",
        headers: { "X-Forwarded-For": "203.0.113.7" },
      });
      expect(res.status).toBe(403);
      const alive = await readHealth(port);
      expect(alive?.pid).toBe(before?.pid);
    } finally {
      proc.kill();
      await shutdownQuietly(port);
    }
  }, 30_000);

  test("GET 不触发重启(只接受 POST)", async () => {
    const proc = spawnServer(18282);
    let port = 18282;
    try {
      port = await waitForServerReady(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: "GET" });
      expect(res.status).not.toBe(200);
      const alive = await readHealth(port);
      expect(alive?.pid).toBe(proc.pid as number);
    } finally {
      proc.kill();
      await shutdownQuietly(port);
    }
  }, 30_000);

  test("壳拉起的后端拒绝自重启(409,生命周期归壳)", async () => {
    const proc = spawnServer(18283, { RIKKAHUB_SHELL: "webview2" });
    let port = 18283;
    try {
      port = await waitForServerReady(proc);
      const health = await readHealth(port);
      expect(health?.spawnedByShell).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { errorCode?: string };
      expect(body.errorCode).toBe("restart_managed_by_shell");
      const alive = await readHealth(port);
      expect(alive?.pid).toBe(proc.pid as number);
    } finally {
      proc.kill();
      await shutdownQuietly(port);
    }
  }, 30_000);

  test("容器内拒绝自重启(400,避免连容器一起退出)", async () => {
    const proc = spawnServer(18284, { RIKKAHUB_CONTAINER: "1" });
    let port = 18284;
    try {
      port = await waitForServerReady(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: "POST" });
      expect(res.status).toBe(400);
      const alive = await readHealth(port);
      expect(alive?.pid).toBe(proc.pid as number);
    } finally {
      proc.kill();
      await shutdownQuietly(port);
    }
  }, 30_000);

  test("低完整性后端在开关已关时拒绝自重启(409,关沙盒需要 Medium 启动)", async () => {
    const proc = spawnServer(18285, { RIKKAHUB_SANDBOX_LAUNCHED: "1" });
    let port = 18285;
    try {
      port = await waitForServerReady(proc);
      const res = await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { errorCode?: string };
      expect(body.errorCode).toBe("restart_requires_medium_process");
      const alive = await readHealth(port);
      expect(alive?.pid).toBe(proc.pid as number);
    } finally {
      proc.kill();
      await shutdownQuietly(port);
    }
  }, 30_000);
});
