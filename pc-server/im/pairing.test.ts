// im/pairing.test.ts — 配对码是"钱袋子"的门栓:陌生人默认进不来,进来一个码就作废。
//
// 这一层的每条分支都直接决定"陌生人能不能让本机模型开口",所以逐条钉死:
// no_code / expired / mismatch / rate_limited 四种拒绝理由,以及兑换成功后白名单与
// 作废语义。限速表是模块级内存态,用例之间必须清空(见 __resetPairingRateLimitForTest)。

import { beforeEach, describe, expect, test } from "bun:test";

import { defaultImAccess } from "../foundation/types/settings/im-access";
import {
  __resetPairingRateLimitForTest,
  isUserPaired,
  issuePairingCode,
  newPairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  pairingCodeActive,
  redeemPairingCode,
  revokePairingCode,
  setPairingEnabled,
  unpairUser,
} from "./pairing";

beforeEach(() => __resetPairingRateLimitForTest());

describe("码形", () => {
  test("长度固定,只在排除易混字符的字母表里取", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newPairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET.includes(ch)).toBe(true);
    }
    // 手机上手敲:0/O、1/I/L 认错一次就白折腾一轮。
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
  });

  test("生成即生效;到点那一毫秒起失效", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    expect(pairingCodeActive(issued.config, 1_000)).toBe(true);
    expect(pairingCodeActive(issued.config, 1_000 + PAIRING_CODE_TTL_MS - 1)).toBe(true);
    expect(pairingCodeActive(issued.config, 1_000 + PAIRING_CODE_TTL_MS)).toBe(false);
  });

  test("撤销后不再有效", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const revoked = revokePairingCode(issued.config);
    expect(revoked.pairing).toEqual({ enabled: true, code: null, expiresAt: null });
    expect(pairingCodeActive(revoked, 1_000)).toBe(false);
  });

  test("总开关关闭:存量码立即失效;重新开启不会复活旧码", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const closed = setPairingEnabled(issued.config, false);
    expect(closed.pairing).toEqual({ enabled: false, code: null, expiresAt: null });
    expect(pairingCodeActive(closed, 1_000)).toBe(false);

    const reopened = setPairingEnabled(closed, true);
    expect(reopened.pairing.enabled).toBe(true);
    expect(pairingCodeActive(reopened, 1_000)).toBe(false);
  });
});

describe("兑换", () => {
  test("没有码时明确拒绝(而不是静默放行)", () => {
    const attempt = redeemPairingCode(defaultImAccess(), "qq", "u1", "小明", "你好");
    expect(attempt).toEqual({ outcome: "rejected", reason: "no_code" });
  });

  test("空白消息不触发兑换,交给上层当普通消息处理", () => {
    const attempt = redeemPairingCode(defaultImAccess(), "qq", "u1", "小明", "   ");
    expect(attempt.outcome).toBe("not_attempted");
  });

  test("总开关关闭时:正确码也拒绝,且不进白名单", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const closed = setPairingEnabled(issued.config, false);
    const attempt = redeemPairingCode(closed, "qq", "u1", "小明", issued.code, 1_001);
    expect(attempt).toEqual({ outcome: "rejected", reason: "disabled" });
    expect(closed.qq.pairedUsers).toEqual([]);
  });

  test("总开关关闭时:不消耗限速额度(重新开启后可正常兑换)", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const closed = setPairingEnabled(issued.config, false);
    for (let i = 0; i < 10; i += 1) redeemPairingCode(closed, "qq", "u1", "小明", "AAAAAA", 1_001 + i);

    const reopened = setPairingEnabled(issuePairingCode(closed, 2_000).config, true);
    const code = reopened.pairing.code!;
    expect(redeemPairingCode(reopened, "qq", "u1", "小明", code, 2_001).outcome).toBe("paired");
  });

  test("过期码按过期拒绝", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const attempt = redeemPairingCode(issued.config, "qq", "u1", "小明", issued.code, 1_000 + PAIRING_CODE_TTL_MS);
    expect(attempt).toEqual({ outcome: "rejected", reason: "expired" });
  });

  test("错误码拒绝且不消耗配对码", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const attempt = redeemPairingCode(issued.config, "qq", "u1", "小明", "ZZZZZZ", 1_001);
    expect(attempt).toEqual({ outcome: "rejected", reason: "mismatch" });
    expect(pairingCodeActive(issued.config, 1_001)).toBe(true);
  });

  test("忽略大小写与首尾空白;成功后该码作废、用户进白名单、其余配置不动", () => {
    const base = defaultImAccess();
    const issued = issuePairingCode(base, 1_000);
    const attempt = redeemPairingCode(issued.config, "wechat", "wx-1", "  阿花  ", ` ${issued.code.toLowerCase()} `, 1_002);
    expect(attempt.outcome).toBe("paired");
    if (attempt.outcome !== "paired") return;
    expect(attempt.config.pairing).toEqual({ enabled: true, code: null, expiresAt: null });
    expect(attempt.config.wechat.pairedUsers).toEqual([
      { userId: "wx-1", displayName: "阿花", pairedAt: 1_002 },
    ]);
    // 原配置不被就地改写(updateSettings 的入参必须是一份新对象)。
    expect(issued.config.wechat.pairedUsers).toEqual([]);
    expect(isUserPaired(attempt.config, "wechat", "wx-1")).toBe(true);
    // 一个码只带进来一个人:重放同一个码不再放行。
    expect(redeemPairingCode(attempt.config, "qq", "u2", "小红", issued.code, 1_003).outcome).toBe("rejected");
  });

  test("显示名留空时回落到 userId 前缀", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const attempt = redeemPairingCode(issued.config, "qq", "openid-abcdefghijkl", "  ", issued.code, 1_001);
    expect(attempt.outcome).toBe("paired");
    if (attempt.outcome !== "paired") return;
    expect(attempt.config.qq.pairedUsers[0].displayName).toBe("openid-abcde");
  });

  test("同一用户连续猜错 5 次后锁 5 分钟,正确码也进不来", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    for (let i = 0; i < 5; i += 1) {
      expect(redeemPairingCode(issued.config, "qq", "u1", "小明", "AAAAAA", 1_001 + i).outcome).toBe("rejected");
    }
    const locked = redeemPairingCode(issued.config, "qq", "u1", "小明", issued.code, 1_010);
    expect(locked).toEqual({ outcome: "rejected", reason: "rate_limited" });
    // 锁是按人算的:换一个人照样能兑。
    expect(redeemPairingCode(issued.config, "qq", "u2", "小红", issued.code, 1_010).outcome).toBe("paired");
  });

  test("限速窗口外自动解除", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    for (let i = 0; i < 5; i += 1) redeemPairingCode(issued.config, "qq", "u1", "小明", "AAAAAA", 1_001 + i);
    const later = 1_001 + 5 * 60_000 + 1;
    expect(redeemPairingCode(issued.config, "qq", "u1", "小明", issued.code, later).outcome).toBe("paired");
  });
});

describe("解除授权", () => {
  test("只摘掉指定平台的指定用户", () => {
    const issued = issuePairingCode(defaultImAccess(), 1_000);
    const attempt = redeemPairingCode(issued.config, "qq", "u1", "小明", issued.code, 1_001);
    expect(attempt.outcome).toBe("paired");
    if (attempt.outcome !== "paired") return;
    const withWechat = {
      ...attempt.config,
      wechat: { ...attempt.config.wechat, pairedUsers: [{ userId: "wx-1", displayName: "阿花", pairedAt: 1 }] },
    };
    const next = unpairUser(withWechat, "qq", "u1");
    expect(next.qq.pairedUsers).toEqual([]);
    expect(next.wechat.pairedUsers).toHaveLength(1);
    expect(isUserPaired(next, "qq", "u1")).toBe(false);
    expect(isUserPaired(next, "wechat", "wx-1")).toBe(true);
  });
});
