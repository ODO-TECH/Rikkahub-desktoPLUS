// restricted-launch.test.ts — 受限档启动编排:触发矩阵单测(纯函数,无 IO/无 spawn)
import { describe, expect, test } from "bun:test";
import { resolveRestrictedLaunchIntent } from "./restricted-launch";

describe("resolveRestrictedLaunchIntent 触发矩阵", () => {
  test("非 Windows 一律跳过(降级机制是低完整性,别的平台没有这条链路)", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "linux", launched: undefined, declaredTier: "restricted", toggle: true, recordExists: true })).toBe("skip");
    expect(resolveRestrictedLaunchIntent({ platform: "darwin", launched: undefined, declaredTier: undefined, toggle: true, recordExists: false })).toBe("skip");
  });

  test("LAUNCHED=1 的 Low 子进程直接跳过(防自重启循环的硬不变量)", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: "1", declaredTier: "restricted", toggle: true, recordExists: true })).toBe("child");
  });

  test("设置开关或部署声明任一为 restricted ⇒ 标注并自重启", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: undefined, toggle: true, recordExists: false })).toBe("label_and_relaunch");
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: "restricted", toggle: false, recordExists: false })).toBe("label_and_relaunch");
  });

  test("声明大小写与空白容错", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: "  RESTRICTED  ", toggle: false, recordExists: false })).toBe("label_and_relaunch");
  });

  test("off 且无残留记录 ⇒ 跳过(常态零开销)", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: undefined, toggle: false, recordExists: false })).toBe("skip");
  });

  test("off 但有残留标注记录 ⇒ 还原", () => {
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: "off", toggle: false, recordExists: true })).toBe("restore");
    expect(resolveRestrictedLaunchIntent({ platform: "win32", launched: undefined, declaredTier: undefined, toggle: false, recordExists: true })).toBe("restore");
  });
});
