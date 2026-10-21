// ssh/devices.ts — SSH 设备条目的形状归一与校验(纯函数,不读写 state)。
// 与其它列表实体同款:前端整对象回传,服务端在写边界收敛类型,手改 state / 安卓导入
// 带来的脏条目在加载时过滤而不是把整页放大成崩溃。

import type { SshDevice } from "../foundation/types/settings";
import { id, isRecord } from "../foundation/utils";

const DEFAULT_PORT = 22;
const MAX_PORT = 65535;

function normalizePort(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT ? parsed : DEFAULT_PORT;
}

/** 表单/请求体 → 设备条目。仅拒绝非对象;host / username 允许为空——自动保存要在
 *  用户逐字填写的过程中持续落库,连接前的完整性由调用方(测试/执行)另行校验。
 *  id 缺省时现生成(新建与手改 state 共用)。凭据字段一律保留原文本,不在入口修剪:
 *  私钥的首尾空白与口令里的空格都有语义。 */
export function parseSshDevice(input: unknown, fallbackId: () => string = id): SshDevice | null {
  if (!isRecord(input)) return null;
  return {
    id: String(input.id ?? "").trim() || fallbackId(),
    name: String(input.name ?? "").trim(),
    host: String(input.host ?? "").trim(),
    port: normalizePort(input.port),
    username: String(input.username ?? "").trim(),
    authType: input.authType === "key" ? "key" : "password",
    password: String(input.password ?? ""),
    privateKey: String(input.privateKey ?? ""),
    passphrase: String(input.passphrase ?? ""),
  };
}

/** 认证所需凭据是否齐全。返回缺失项(用于 400 文案),齐全为 null。 */
export function sshCredentialError(device: SshDevice): "password" | "key" | null {
  if (device.authType === "key") return device.privateKey.trim() ? null : "key";
  return device.password ? null : "password";
}

/** state 加载时的数组归一:非数组 → 空;逐条过 parseSshDevice,整条空白的脏记录丢弃。 */
export function normalizeSshDevices(value: unknown): SshDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const device = parseSshDevice(item);
    if (!device) return [];
    if (!device.name && !device.host && !device.username) return [];
    return [device];
  });
}
