// ssh/errors.ts — SSH 层的错误分类与文案。
//
// 纪律(与安卓端一致的两条分工):
// - 传输/远端错误 → 英文原文直接进 message,界面原样显示(JSch/ssh2 的真实原因没有本地化价值,
//   翻译反而丢掉排障线索)。安卓端同理:连接与保存失败弹的是 e.message。
// - 用户能改正的表单/路径错误 → 带 errorCode,前端按 `errors.<code>` 查文案;message 是英文兜底。
// 凭据纪律:任何构造函数的入参都不接受密码/私钥/口令,文案里只允许出现 user@host:port。

import type { SshHostKey } from "../foundation/types/settings";

/** 服务器出示的密钥还没被信任过:认证前就断,凭据一个字节都不会发出去。 */
export class SshHostKeyUnknownError extends Error {
  constructor(readonly presented: SshHostKey) {
    super(`Unknown SSH host key ${presented.type} ${presented.fingerprint}`);
    this.name = "SshHostKeyUnknownError";
  }
}

/** 与已信任的密钥不一致:可能是服务器重装,也可能是中间人;默认拒绝。 */
export class SshHostKeyChangedError extends Error {
  constructor(
    readonly expected: SshHostKey,
    readonly presented: SshHostKey,
  ) {
    super(
      `SSH host key changed: expected ${expected.fingerprint}, got ${presented.type} ${presented.fingerprint}`,
    );
    this.name = "SshHostKeyChangedError";
  }
}

/**
 * 「请求确定没送到服务器」的失败(连接已断 / channel 没开成)。
 * 只有这一类允许池重连后重试一次;安卓端对应 SshChannelOpenException。
 */
export class SshChannelOpenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SshChannelOpenError";
  }
}

/** 调用方取消(点停止 / 关页面)。文案沿用仓库既有约定 "aborted"。 */
export class SshAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "SshAbortedError";
  }
}

/** 用户可改正的输入错误(路径越界、太大、不是文件……);HTTP 层映射 400。 */
export class SshInputError extends Error {
  constructor(
    message: string,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = "SshInputError";
  }
}

/** 传输层失败(连不上、认证被拒、SFTP 报错);HTTP 层映射 502。 */
export class SshTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SshTransportError";
  }
}

export function isHostKeyError(err: unknown): err is SshHostKeyUnknownError | SshHostKeyChangedError {
  return err instanceof SshHostKeyUnknownError || err instanceof SshHostKeyChangedError;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof SshAbortedError || (err instanceof Error && err.message === "aborted");
}

/** 界面与日志通用的目标地址:user@host:port(不含任何凭据)。 */
export function addressOf(parts: { username: string; host: string; port: number }): string {
  return `${parts.username}@${parts.host}:${parts.port}`;
}

/** 安卓端 IOException 系列的等价包装,保留 cause 供 --dev 日志追。 */
export function transportError(message: string, cause?: unknown): SshTransportError {
  return new SshTransportError(message, cause);
}
