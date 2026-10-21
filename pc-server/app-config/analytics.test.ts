// C3(专题6复查)回归:使用时长信标学分钳制。前端权威计量真实聚焦毫秒数,
// 后端 beaconCreditSeconds 只负责钳制:非法输入 0、负数 0、正常拍原样折秒、
// 超长段(睡眠唤醒/时钟异常/伪造)封顶 90s。碎片化使用不再被"首拍固定 60s +
// 间隔全额计"的旧启发式高估。
import { describe, expect, test } from "bun:test";

import { beaconCreditSeconds } from "./analytics";

describe("beaconCreditSeconds", () => {
  test("正常拍按真实聚焦时长折秒", () => {
    expect(beaconCreditSeconds(60_000)).toBe(60);
    expect(beaconCreditSeconds(5_000)).toBe(5);
    expect(beaconCreditSeconds(500)).toBe(0.5);
  });

  test("碎片化短拍只记真实时长(旧法会记满 60s)", () => {
    expect(beaconCreditSeconds(1_000)).toBe(1);
  });

  test("超长段封顶 90s(睡眠唤醒/时钟异常/畸形请求)", () => {
    expect(beaconCreditSeconds(300_000)).toBe(90);
    expect(beaconCreditSeconds(Number.MAX_SAFE_INTEGER)).toBe(90);
  });

  test("非法与非正输入记 0", () => {
    expect(beaconCreditSeconds(0)).toBe(0);
    expect(beaconCreditSeconds(-5_000)).toBe(0);
    expect(beaconCreditSeconds(Number.NaN)).toBe(0);
    expect(beaconCreditSeconds(Infinity)).toBe(0);
  });
});
