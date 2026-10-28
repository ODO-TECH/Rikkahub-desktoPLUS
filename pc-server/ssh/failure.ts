// ssh/failure.ts — 错误对象 → 界面载荷(HTTP 响应体与终端 error 帧共用同一份映射)。
//
// 为什么要单独一层:主机密钥确认框靠的不只是「出错了」,而是服务器当场出示的密钥、核对命令和
// 期望指纹;这些字段在 ssh/exec(400 JSON)和 WebSocket 终端里必须长同一个样子。两处各写各的,
// 就会出现「控制台能弹确认框,终端里同样的错误只剩一句英文」这类分裂。
//
// 纪律:载荷里只允许 user@host:port、路径与密钥指纹,任何凭据都不进来(文案构造本来也不接受它们)。

import type { SshHostKey } from "../foundation/types/settings";
import { hostKeyVerifyCommand } from "./host-key";
import {
  isAbortError,
  SshHostKeyChangedError,
  SshHostKeyUnknownError,
  SshInputError,
} from "./errors";

/**
 * status 沿用仓库既有约定(HTTP 侧直接拿它当响应码):
 * 400 = 用户可改正的输入/密钥确认问题;403 = 路径或目录不在授权范围(见下 FORBIDDEN_ERROR_CODES);
 * 499 = 客户端自己取消;502 = 传输或远端失败。
 */
export interface SshFailureInfo {
  status: number;
  message: string;
  /** 有码就按 errors.<code> 查文案;没有就原样显示 message。 */
  errorCode?: string;
  /** 主机密钥未信任/已变更时带上服务器出示的密钥:界面靠它做确认与逐字节比对。 */
  hostKey?: SshHostKey;
  verifyCommand?: string;
  expectedFingerprint?: string;
}

/**
 * 越权类错误码:输入没错,是这条路径/目录不在授权范围里 → 403。
 * 与 exec 路由里「Path is not an authorized remote directory」403 同一条判断,
 * 免得同一个越界在控制台拿到 403、在文件面板拿到 400(界面按 code 分支,码不同就分叉)。
 */
const FORBIDDEN_ERROR_CODES = new Set(["ssh.dir_unauthorized", "ssh.path_escape"]);

export function sshFailureInfo(err: unknown): SshFailureInfo {
  if (err instanceof SshHostKeyChangedError) {
    return {
      status: 400,
      message: err.message,
      errorCode: "ssh.host_key_changed",
      hostKey: err.presented,
      verifyCommand: hostKeyVerifyCommand(err.presented.type),
      expectedFingerprint: err.expected.fingerprint,
    };
  }
  if (err instanceof SshHostKeyUnknownError) {
    return {
      status: 400,
      message: err.message,
      errorCode: "ssh.host_key_unknown",
      hostKey: err.presented,
      verifyCommand: hostKeyVerifyCommand(err.presented.type),
    };
  }
  if (isAbortError(err)) return { status: 499, message: "Client cancelled" };
  if (err instanceof SshInputError) {
    const code = err.errorCode;
    return {
      status: code && FORBIDDEN_ERROR_CODES.has(code) ? 403 : 400,
      message: err.message,
      errorCode: code,
    };
  }
  return { status: 502, message: err instanceof Error ? err.message : String(err) };
}

/** 载荷 → HTTP JSON 响应体字段(与旧版 sshFailure 的输出逐字一致,不新增也不丢字段)。 */
export function sshFailureBody(info: SshFailureInfo): Record<string, unknown> {
  return {
    error: info.message,
    code: info.status,
    ...(info.errorCode ? { errorCode: info.errorCode } : {}),
    ...(info.hostKey ? { hostKey: info.hostKey } : {}),
    ...(info.verifyCommand ? { verifyCommand: info.verifyCommand } : {}),
    ...(info.expectedFingerprint ? { expectedFingerprint: info.expectedFingerprint } : {}),
  };
}
