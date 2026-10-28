// im/registry.test.ts — 停机时先取消在途首连,不能等 QQ 的 20 秒连接预算跑完。
import { afterAll, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-im-registry-"));

class FakeQQBot extends EventEmitter {
  static starts = 0;
  static stops = 0;

  constructor(_options: unknown) {
    super();
  }

  start(signal: AbortSignal): Promise<void> {
    FakeQQBot.starts += 1;
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  stop(): void {
    FakeQQBot.stops += 1;
  }

  async sendText(): Promise<void> {}

  async sendTyping(): Promise<void> {}
}

mock.module("@tencent-connect/qqbot-nodejs", () => ({ QQBot: FakeQQBot }));

const jsonStore = await import("../persistence/json-store");
const { defaultSettings } = await import("../app-config/defaults");
const { defaultImAccess } = await import("../foundation/types/settings/im-access");
const { normalizeState } = await import("../persistence/state-load");
const {
  __resetImRegistryForTest,
  __setImStopBudgetForTest,
  getImStatus,
  reconcileImAdapters,
  stopAllImAdapters,
} = await import("./registry");

const priorState = jsonStore.state;
afterAll(() => {
  __resetImRegistryForTest();
  jsonStore.setState(priorState);
  try {
    rmSync(process.env.RIKKAHUB_PC_DATA_DIR!, { recursive: true, force: true });
  } catch {
    // Windows 句柄未尽
  }
});

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition not met before timeout");
}

test("首连中停机:立即取消并完成收口,不等 20 秒连接预算", async () => {
  const settings = defaultSettings();
  const imAccess = defaultImAccess();
  imAccess.qq.enabled = true;
  imAccess.qq.appId = "fake-app-id";
  imAccess.qq.appSecret = "fake-app-secret";
  settings.imAccess = imAccess;
  jsonStore.setState(normalizeState({ settings }));
  __resetImRegistryForTest();
  __setImStopBudgetForTest(200);

  reconcileImAdapters();
  await waitFor(() => FakeQQBot.starts === 1);
  expect(getImStatus().find((status) => status.platform === "qq")?.running).toBe(true);

  const started = performance.now();
  await stopAllImAdapters();
  const elapsed = performance.now() - started;

  expect(elapsed).toBeLessThan(1_000);
  expect(FakeQQBot.stops).toBe(1);
  expect(getImStatus().find((status) => status.platform === "qq")?.running).toBe(false);
});
