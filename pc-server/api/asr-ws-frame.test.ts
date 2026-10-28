// 批次二 R5-6 回归:ASR WebSocket 收到非 JSON 文本帧必须静默丢弃——旧实现裸
// JSON.parse,恶意/损坏帧直接抛进 uncaughtException 安全网(每帧一条错误中心记录)。
// 断言:发垃圾帧后连接不断、服务进程照常响应 API。
import { waitForServerReady } from "../test-utils/e2e-server";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverEntry = join(import.meta.dir, "..", "server.ts");

describe("ASR WebSocket 恶意帧防护", () => {
  test("非 JSON 文本帧被静默丢弃,连接与服务均存活", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rkh-ws-frame-"));
    const proc = Bun.spawn([process.execPath, serverEntry, "--port", "18260", "--no-open"], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await waitForServerReady(proc);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/asr/realtime`);
      await new Promise<void>((resolvePromise, reject) => {
        ws.onopen = () => resolvePromise();
        ws.onerror = () => reject(new Error("WebSocket 连接失败"));
      });

      let closed = false;
      ws.onclose = () => {
        closed = true;
      };
      ws.send("{not-json!!!");
      ws.send("\u0000\uFFFD garbage");
      await new Promise((r) => setTimeout(r, 300));

      expect(closed).toBe(false);
      const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
      expect(res.status).toBe(200);
      ws.close();
    } finally {
      proc.kill();
    }
  }, 30_000);
});
