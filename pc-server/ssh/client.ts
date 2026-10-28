// ssh/client.ts — 面向调用方的 SSH 服务门面:连接复用走池,探测走临时连接。
//
// 对齐前这里是「每次调用新建连接、用完即断」:一条命令一次完整握手,控制台不能 cd,
// 密码认证被服务器按多次失败风控,也没有任何地方承载主机密钥确认。现在连接层在
// ssh/connection.ts、复用在 ssh/pool.ts,本文件只做两件事:
// 1) 把 handler/工具的用词(探测、执行一条命令)翻译成池的操作;
// 2) 收口超时夹取与错误到 HTTP 语义的边界,让上层不必自己重复这些纪律。
//
// 纪律:凭据只在建连参数里出现一次,绝不写日志、绝不进错误文案;对外只有 user@host:port。

import type { SshDevice } from "../foundation/types/settings";
import { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS, SHELL_TIMEOUT_MAX_MS } from "./constants";
import type { SshExecOptions, SshExecOutcome, SshProbeResult } from "./connection";
import { sshPool } from "./pool";

export interface SshRunOptions {
  /** 远程工作目录(绝对路径);给定了才套安卓端那层外壳,cwd 缺省即「不进入任何目录」。 */
  cwd?: string;
  /** 调用方请求的超时;缺省 30s,上限按用途夹取(界面 120s,AI 工具 600s)。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 写类操作传 false:连接断了也不重放,避免不可重复的命令跑两遍。 */
  retry?: boolean;
  onData?: SshExecOptions["onData"];
  stdin?: SshExecOptions["stdin"];
}

/** 界面用的超时夹取:缺省 30s,最大 120s(和安卓端控制台一致)。 */
export function consoleTimeout(timeoutMs?: number): number {
  return clampTimeout(timeoutMs, EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS);
}

/** AI shell 工具用的超时夹取:最大 600s(安卓端 SHELL_TIMEOUT_MAX_SECONDS)。 */
export function agentTimeout(timeoutMs?: number): number {
  return clampTimeout(timeoutMs, EXEC_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS);
}

function clampTimeout(requested: number | undefined, fallback: number, max: number): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * 测试连接 = 一次性探测(临时连接,不进池):握手、认证、核对主机密钥,再读回
 * shell / 主目录 / 目标目录是否存在。主机密钥未确认时抛 SshHostKeyUnknownError,
 * 里面带着服务器出示的密钥,界面据此弹首次确认。
 * remoteDir 留空即「只测连通性」;填了但不是绝对路径会抛 ssh.path_relative(400),
 * 路径本身只做词法归一,进远端时仍走 command-wrap 的逐字引用,不存在拼命令。
 */
export function probeSshDevice(
  device: SshDevice,
  remoteDir?: string | null,
  signal?: AbortSignal,
): Promise<SshProbeResult> {
  return sshPool.probe(device, remoteDir ?? "", signal);
}

/** 在设备的复用连接上执行一条命令(远程目录给了就套外壳;退出码/截断/超时语义见 connection.ts)。 */
export function runSshCommand(device: SshDevice, command: string, options: SshRunOptions = {}): Promise<SshExecOutcome> {
  return sshPool.use(device, (connection) => connection.exec(command, {
    cwd: options.cwd,
    timeoutMs: clampTimeout(options.timeoutMs, EXEC_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS),
    signal: options.signal,
    stdin: options.stdin,
    onData: options.onData,
  }), { retry: options.retry, signal: options.signal });
}

/** 设备保存/删除后丢掉它的连接(配置变化本身由池按指纹自动重连,不需要这里)。 */
export function closeSshDevice(deviceId: string): void {
  sshPool.close(deviceId);
}

/** 进程退出前调用:关掉所有连接,免得退出流程里还挂着远端会话。 */
export function closeAllSshConnections(): void {
  sshPool.closeAll();
}
