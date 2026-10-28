// ssh/host-key.ts — 主机密钥的解码、指纹与「在服务器上怎么核对」提示命令。
//
// 为什么自己解码:ssh2 把 SSH_MSG_KEXINIT 回包里的原始公钥 blob 交给 hostVerifier,而我们要
// 存的是「算法名 + blob base64」、给人看的是 OpenSSH 的 `SHA256:<base64(sha256(blob))>`。
// 三者都能从同一个 blob 确定性算出,不需要拉进 ssh2 的密钥解析栈(它会碰 PEM 与可选依赖)。
// 语义与安卓端 workspace/ssh/SshConfig.kt 的 SshHostKey 一致:比对只认 blob,指纹只用于展示。

import { createHash } from "node:crypto";
import type { SshHostKey } from "../foundation/types/settings";

/**
 * 从 SSH 公钥 blob(长度前缀字符串 + 各算法字段)头部取出算法名。
 * blob 不是合法 SSH 字符串,或长度对不上时返回 null(宁可拒绝连接,不做猜测)。
 */
export function hostKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length <= 0 || length > blob.length - 4) return null;
  const type = blob.subarray(4, 4 + length).toString("ascii");
  // 算法名是可打印 ASCII;出现控制字符说明解析跑偏了。
  return /^[\x20-\x7e]+$/.test(type) ? type : null;
}

/** blob → 存储形态;无法解码返回 null。 */
export function encodeHostKey(blob: Buffer): SshHostKey | null {
  const type = hostKeyType(blob);
  if (!type) return null;
  const key = blob.toString("base64");
  return { type, key, fingerprint: fingerprintOf(key) };
}

/** base64 blob → `SHA256:...`(去掉填充,和 `ssh-keygen -lf` 的输出对得上)。 */
export function fingerprintOf(keyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** 把界面/存储里的裸 {type,key} 补齐成带指纹的完整值;解码失败返回 null。 */
export function withFingerprint(hostKey: { type?: string; key?: string } | null | undefined): SshHostKey | null {
  if (!hostKey) return null;
  const key = String(hostKey.key ?? "");
  const type = String(hostKey.type ?? "");
  if (!key || !type) return null;
  const blob = Buffer.from(key, "base64");
  if (hostKeyType(blob) !== type) return null;
  return { type, key, fingerprint: fingerprintOf(key) };
}

/** 两个主机密钥是否同一把(只比 blob)。 */
export function sameHostKey(a: SshHostKey | null, b: SshHostKey | null): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key;
}

/**
 * 「在服务器上跑这条命令对照指纹」的建议,与安卓端 EditorPage 的推导一致:
 * `ssh-ed25519` → ssh_host_ed25519_key.pub,`ecdsa-sha2-nistp256` → ssh_host_ecdsa_key.pub。
 */
export function hostKeyVerifyCommand(type: string): string {
  const shortName = type.replace(/^ssh-/, "").split("-")[0] || "ssh_host_key";
  return `ssh-keygen -lf /etc/ssh/ssh_host_${shortName}_key.pub`;
}
