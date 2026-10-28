// im/pairing.ts — 配对码:谁能用这两个机器人
//
// 为什么要有这一层:QQ 机器人一旦被搜到,任何人都能给它发消息;而这里每条消息最终都会
// 变成一次真实的模型调用(花的是用户的钱),并且助手的提示词/记忆会进入对方视野。所以
// 默认拒绝——陌生人的第一句话只会收到"请发配对码",不会触达模型。
//
// 配对码是全局一次性凭据(两个平台共用):界面生成 → 用户私下发给对方 → 对方在 IM 里
// 原样发出 → 兑换成功即作废。兑换成功后该用户永久进白名单,直到用户在界面上移除。

import type { ImAccessConfig, ImPlatformId } from "../foundation/types/settings/im-access";

/** 排除 0/O/1/I/L:配对码要在手机上手敲,这些字符认错一次就白折腾一轮。 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_TTL_MS = 60 * 60_000;

/** 同一用户连续猜错 5 次后锁 5 分钟:配对码是 32^6 ≈ 10 亿空间,但机器人是常驻服务,
 *  不限速就等于给暴力枚举留了个免费接口。 */
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_MAX_FAILURES = 5;

const failures = new Map<string, { count: number; firstAt: number }>();

export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[crypto.getRandomValues(new Uint32Array(1))[0] % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

export function pairingCodeActive(config: ImAccessConfig, now = Date.now()): boolean {
  return Boolean(
    config.pairing.enabled && config.pairing.code && config.pairing.expiresAt && config.pairing.expiresAt > now,
  );
}

/** 生成/重新生成配对码:总是换新码并重置有效期(旧码即刻失效,不存在两码并行)。 */
export function issuePairingCode(config: ImAccessConfig, now = Date.now()): { config: ImAccessConfig; code: string } {
  const code = newPairingCode();
  return {
    code,
    config: { ...config, pairing: { ...config.pairing, code, expiresAt: now + PAIRING_CODE_TTL_MS } },
  };
}

export function revokePairingCode(config: ImAccessConfig): ImAccessConfig {
  return { ...config, pairing: { ...config.pairing, code: null, expiresAt: null } };
}

/** 配对总开关。关闭时顺手作废存量码:开关说"不再接受新配对",手里还留着一把能开门的码
 *  就自相矛盾了。 */
export function setPairingEnabled(config: ImAccessConfig, enabled: boolean): ImAccessConfig {
  return enabled
    ? { ...config, pairing: { ...config.pairing, enabled: true } }
    : { ...config, pairing: { enabled: false, code: null, expiresAt: null } };
}

export function isUserPaired(
  config: ImAccessConfig,
  platform: ImPlatformId,
  userId: string,
): boolean {
  const users = platform === "qq" ? config.qq.pairedUsers : config.wechat.pairedUsers;
  return users.some((user) => user.userId === userId);
}

export type PairAttempt =
  | { outcome: "not_attempted" }
  | { outcome: "rejected"; reason: "disabled" | "no_code" | "expired" | "mismatch" | "rate_limited" }
  | { outcome: "paired"; config: ImAccessConfig };

/**
 * 尝试用一条消息文本兑换配对码。
 *
 * 只在文本与当前有效码相等(忽略大小写与首尾空白)时放行;成功即作废该码并写入白名单,
 * 因此一个码只能带进来一个人。失败原因原样回给调用方,由界面上的日志/回复文案决定怎么说。
 */
export function redeemPairingCode(
  config: ImAccessConfig,
  platform: ImPlatformId,
  userId: string,
  displayName: string,
  text: string,
  now = Date.now(),
): PairAttempt {
  const trimmed = text.trim();
  if (!trimmed) return { outcome: "not_attempted" };
  // 关闭时直接拒绝:不消耗限速额度,也不产生"码不对"的误导——这里根本没有可兑的码。
  if (!config.pairing.enabled) return { outcome: "rejected", reason: "disabled" };

  const rateKey = `${platform}:${userId}`;
  const record = failures.get(rateKey);
  if (record && now - record.firstAt <= RATE_WINDOW_MS && record.count >= RATE_MAX_FAILURES) {
    return { outcome: "rejected", reason: "rate_limited" };
  }

  const { code, expiresAt } = config.pairing;
  if (!code || !expiresAt) return { outcome: "rejected", reason: "no_code" };
  if (now >= expiresAt) return { outcome: "rejected", reason: "expired" };

  if (trimmed.toUpperCase() !== code.toUpperCase()) {
    const prev = record && now - record.firstAt <= RATE_WINDOW_MS ? record : { count: 0, firstAt: now };
    failures.set(rateKey, { count: prev.count + 1, firstAt: prev.firstAt });
    return { outcome: "rejected", reason: "mismatch" };
  }

  failures.delete(rateKey);
  const paired = { userId, displayName: displayName.trim() || userId.slice(0, 12), pairedAt: now };
  if (platform === "qq") {
    const rest = config.qq.pairedUsers.filter((user) => user.userId !== userId);
    return { outcome: "paired", config: { ...config, qq: { ...config.qq, pairedUsers: [...rest, paired] }, pairing: { ...config.pairing, code: null, expiresAt: null } } };
  }
  const rest = config.wechat.pairedUsers.filter((user) => user.userId !== userId);
  return { outcome: "paired", config: { ...config, wechat: { ...config.wechat, pairedUsers: [...rest, paired] }, pairing: { ...config.pairing, code: null, expiresAt: null } } };
}

/** 移除一个已配对用户(界面「已授权」列表上的撤销动作)。 */
export function unpairUser(config: ImAccessConfig, platform: ImPlatformId, userId: string): ImAccessConfig {
  if (platform === "qq") {
    return { ...config, qq: { ...config.qq, pairedUsers: config.qq.pairedUsers.filter((u) => u.userId !== userId) } };
  }
  return { ...config, wechat: { ...config.wechat, pairedUsers: config.wechat.pairedUsers.filter((u) => u.userId !== userId) } };
}

/** 测试隔离:限速表是模块级内存态,用例之间必须清空,否则前一个用例的失败会锁死后一个。 */
export function __resetPairingRateLimitForTest(): void {
  failures.clear();
}
