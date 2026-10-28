// ssh/devices.ts — SSH 设备条目的形状归一与校验(纯函数,不读写 state)。
// 与其它列表实体同款:前端整对象回传,服务端在写边界收敛类型,手改 state / 安卓导入
// 带来的脏条目在加载时过滤而不是把整页放大成崩溃。
//
// 两条写边界纪律:
// - 主机密钥的 fingerprint 是派生值,一律按 blob 重算(客户端传什么都不信);解码失败就当未信任,
//   宁可让用户重新确认一次,也不带着坏条目去连。
// - 远程目录是「授权」,归一只做形状收敛(斜杠、去重),路径合法性留给使用处报错——
//   自动保存要求半填的条目也能落库,不能因为用户正在敲 `home/user` 就把整行吞掉。

import { createHash } from "node:crypto";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import { id, isRecord } from "../foundation/utils";
import { withFingerprint } from "./host-key";
import { normalizeRemotePath } from "./remote-path";
import { MAX_PRIVATE_KEY_BYTES } from "./constants";

const DEFAULT_PORT = 22;
const MAX_PORT = 65535;
const MAX_NAME_CHARS = 120;
const MAX_DIR_PATH_CHARS = 512;

function normalizePort(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT ? parsed : DEFAULT_PORT;
}

/**
 * 目录条目 → {id, name, path}。path 空串保留(草稿态,不可绑定),非空时尽量归一;
 * 相对路径这类「还在敲」的输入原样留下,由连接/绑定时统一报 ssh.path_relative。
 */
function parseRemoteDir(input: unknown, taken: Set<string>, fallbackId: () => string): SshRemoteDir | null {
  if (!isRecord(input)) return null;
  const rawPath = String(input.path ?? "").trim().replace(/\\/g, "/");
  let path = rawPath;
  if (rawPath) {
    try {
      path = normalizeRemotePath(rawPath);
    } catch {
      path = rawPath;
    }
  }
  let dirId = String(input.id ?? "").trim();
  if (!dirId || taken.has(dirId)) dirId = fallbackId();
  taken.add(dirId);
  return {
    id: dirId,
    name: String(input.name ?? "").trim().slice(0, MAX_NAME_CHARS),
    path: path.slice(0, MAX_DIR_PATH_CHARS),
  };
}

/**
 * 表单/请求体 → 设备条目。仅拒绝非对象;host / username 允许为空——自动保存要在
 * 用户逐字填写的过程中持续落库,连接前的完整性由调用方(测试/执行)另行校验。
 * id 缺省时现生成(新建与手改 state 共用)。凭据字段一律保留原文本,不在入口修剪:
 * 私钥的首尾空白与口令里的空格都有语义。
 */
export function parseSshDevice(input: unknown, fallbackId: () => string = id): SshDevice | null {
  if (!isRecord(input)) return null;
  const taken = new Set<string>();
  const dirs = Array.isArray(input.dirs)
    ? input.dirs.flatMap((item) => {
      const dir = parseRemoteDir(item, taken, fallbackId);
      return dir ? [dir] : [];
    })
    : [];
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
    hostKey: withFingerprint(isRecord(input.hostKey) ? input.hostKey : null),
    dirs,
  };
}

/** 认证所需凭据是否齐全。返回缺失项(用于 400 文案),齐全为 null。 */
export function sshCredentialError(device: SshDevice): "password" | "key" | null {
  if (device.authType === "key") return device.privateKey.trim() ? null : "key";
  return device.password ? null : "password";
}

/**
 * 条目本身的硬限制(超出就整条拒绝,不做静默截断——私钥被截断只会变成「认证失败」,
 * 用户更难查)。返回 errorCode,合格为 null。
 */
export function sshDeviceInputError(device: SshDevice): string | null {
  if (device.privateKey.length > MAX_PRIVATE_KEY_BYTES) return "ssh.key_too_large";
  if (!device.hostKey) return null;
  // withFingerprint 已在入口收敛过;这里兜住手改 state 直接塞进来的脏值。
  if (!device.hostKey.key || !device.hostKey.type) return "ssh.host_key_invalid";
  return null;
}

/** state 加载时的数组归一:非数组 → 空;逐条过 parseSshDevice,整条空白的脏记录丢弃。 */
export function normalizeSshDevices(value: unknown): SshDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const device = parseSshDevice(item);
    if (!device) return [];
    if (!device.name && !device.host && !device.username && device.dirs.length === 0) return [];
    return [device];
  });
}

/**
 * 连接参数指纹:任影响连接的字段变了,池里的旧连接就不能再用。
 * 返回 sha256 摘要而不是原文——池条目会长期持有它,不该再多存一份明文凭据,也杜绝了
 * 以后有人把它当日志键打出来的可能。摘要只做「配置是否变过」的变更检测,不是凭据的
 * 安全存储形式,也不参与任何认证判断;它只活在内存里,不落盘、不进日志、不进错误文案。
 */
export function sshConnectionSignature(device: SshDevice): string {
  const credential = device.authType === "key"
    ? `${device.privateKey}\n${device.passphrase}`
    : device.password;
  const material = [
    device.host,
    String(device.port),
    device.username,
    device.authType,
    device.hostKey?.key ?? "",
    credential,
  ].join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

/** 已授权且填完的目录;绑定时只认这里的条目。 */
export function usableRemoteDirs(device: SshDevice): SshRemoteDir[] {
  return device.dirs.filter((dir) => dir.path.length > 0);
}

/** 按 id 找授权目录(id 优先,兼容旧数据只有路径的情况)。 */
export function findRemoteDir(device: SshDevice, dirId: string): SshRemoteDir | null {
  return device.dirs.find((dir) => dir.id === dirId)
    ?? device.dirs.find((dir) => dir.path === dirId && dir.path.length > 0)
    ?? null;
}
