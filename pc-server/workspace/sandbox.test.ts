// workspace/sandbox.test.ts — 沙盒档位声明 / 探针实测单测
//
// 纪律：不碰真实系统目录、不改权限。用「不存在的探针路径」与「可写临时目录」两种
// 代表点覆盖判定分支；"写不进去"的分支依赖操作系统权限，交给部署自检（/api/app/sandbox）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSandbox, resetSandboxCacheForTests, sandboxBoundaryActive, sandboxStatus } from "./sandbox";

const originalTier = process.env.RIKKAHUB_SANDBOX;
const originalProbe = process.env.RIKKAHUB_SANDBOX_PROBE_PATH;

function setEnv(tier?: string, probePath?: string): void {
  if (tier === undefined) delete process.env.RIKKAHUB_SANDBOX;
  else process.env.RIKKAHUB_SANDBOX = tier;
  if (probePath === undefined) delete process.env.RIKKAHUB_SANDBOX_PROBE_PATH;
  else process.env.RIKKAHUB_SANDBOX_PROBE_PATH = probePath;
  resetSandboxCacheForTests();
}

afterEach(() => {
  setEnv(originalTier, originalProbe);
});

describe("档位声明", () => {
  test("未设置 / 非法值一律归为 off", () => {
    setEnv(undefined, undefined);
    expect(sandboxStatus().tier).toBe("off");
    setEnv("nonsense", undefined);
    expect(sandboxStatus().tier).toBe("off");
  });

  test("restricted / full 正常解析（大小写与空格容错）", () => {
    setEnv("restricted", undefined);
    expect(sandboxStatus().tier).toBe("restricted");
    setEnv("  FULL  ", undefined);
    expect(sandboxStatus().tier).toBe("full");
  });

  test("initSandbox 幂等：重复调用返回同一份结论", () => {
    setEnv("restricted", undefined);
    const first = initSandbox();
    const second = initSandbox();
    expect(second).toBe(first);
    expect(sandboxStatus()).toBe(first);
  });

  test("Windows 机制下汇报完整性标签现状（受限档必带标注汇报行）", () => {
    if (process.platform !== "win32") return;
    setEnv("restricted", join(tmpdir(), "rkh-sandbox-missing-x"));
    const status = sandboxStatus();
    expect(status.notes.join(" ")).toContain("完整性标签");
  });
});

describe("探针实测", () => {
  test("探针路径不存在 ⇒ unknown（不能新建，也不能当成边界生效）", () => {
    const missing = join(tmpdir(), "rkh-sandbox-does-not-exist-9f2c");
    setEnv("restricted", missing);
    const status = sandboxStatus();
    expect(status.measured).toBe("unknown");
    expect(status.boundaryActive).toBe(false);
    expect(status.notes.join(" ")).toContain("探针位置不存在");
  });

  test("探针位置可写 ⇒ not_enforced（没有边界），并点名声明与实测不符", () => {
    const writable = mkdtempSync(join(tmpdir(), "rkh-sandbox-probe-"));
    try {
      setEnv("restricted", writable);
      const status = sandboxStatus();
      expect(status.measured).toBe("not_enforced");
      expect(status.boundaryActive).toBe(false);
      expect(sandboxBoundaryActive()).toBe(false);
      expect(status.notes.join(" ")).toContain("声明为受限档");
    } finally {
      rmSync(writable, { recursive: true, force: true });
    }
  });

  test("探针写成功后不留残文件", () => {
    const writable = mkdtempSync(join(tmpdir(), "rkh-sandbox-clean-"));
    try {
      setEnv("off", writable);
      sandboxStatus();
      const leftover = join(writable, ".rikkahub-sandbox-probe-outside.tmp");
      expect(require("node:fs").existsSync(leftover)).toBe(false);
    } finally {
      rmSync(writable, { recursive: true, force: true });
    }
  });

  test("区内（数据目录）可写是实测前提，写不进去时结论降级为 unknown", () => {
    // dataDir 正常存在且可写 ⇒ insideWritable 为真；这条断言锁住"区内可写"这一前提。
    setEnv("off", join(tmpdir(), "rkh-sandbox-missing-x"));
    const status = sandboxStatus();
    expect(status.insideWritable).toBe(true);
  });
});
