// ssh/client.ts — SSH 连接、连接测试与一次性命令执行(ssh2)。
// 纪律:凭据只在进程内用于握手,绝不写日志、绝不进错误文案;每次调用新建连接,
// 用完即断(控制台不做长驻会话——命令之间不共享 cwd,见前端提示)。

import { Client, type ConnectConfig } from "ssh2";
import type { SshDevice } from "../foundation/types/settings";

const READY_TIMEOUT_MS = 12_000;
/** 单路输出上限:远端 cat 一个大文件不该把整进程内存拖垮。 */
const MAX_OUTPUT_BYTES = 200 * 1024;

export interface SshTestResult {
  latencyMs: number;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  /** 远端退出码;null = 被信号终止。 */
  code: number | null;
  signal: string;
  /** 输出超过上限,已截断。 */
  truncated: boolean;
}

function connectConfig(device: SshDevice): ConnectConfig {
  const base: ConnectConfig = {
    host: device.host,
    port: device.port,
    username: device.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 2,
  };
  if (device.authType === "key") {
    return {
      ...base,
      privateKey: device.privateKey,
      ...(device.passphrase ? { passphrase: device.passphrase } : {}),
    };
  }
  return { ...base, password: device.password };
}

/** 建立到 ready(认证完成)即断开,返回握手耗时。 */
export function testSshConnection(device: SshDevice): Promise<SshTestResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const startedAt = Date.now();
    let settled = false;
    const finish = (error?: unknown, result?: SshTestResult) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(result!);
    };
    client.on("ready", () => finish(undefined, { latencyMs: Date.now() - startedAt }));
    client.on("error", (error) => finish(error));
    client.on("close", () => finish(new Error("Connection closed before authentication completed")));
    client.connect(connectConfig(device));
  });
}

/** 单条命令(非交互 shell):收集 stdout/stderr 与退出码,超时/异常即收掉连接。 */
export function runSshCommand(device: SshDevice, command: string, timeoutMs: number): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stdout = "";
    let stderr = "";
    let truncated = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return next.slice(0, MAX_OUTPUT_BYTES);
      }
      return next;
    };

    const finish = (error?: unknown, result?: SshExecResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      client.end();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(result!);
    };

    timer = setTimeout(() => {
      finish(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    client.on("ready", () => {
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        let exitCode: number | null = null;
        let exitSignal = "";
        stream.on("exit", (code: number | null, signal?: string) => {
          exitCode = code ?? null;
          exitSignal = signal ?? "";
        });
        stream.on("data", (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
        stream.on("close", () => {
          finish(undefined, { stdout, stderr, code: exitCode, signal: exitSignal, truncated });
        });
      });
    });
    client.on("error", (error) => finish(error));
    client.on("close", () => finish(new Error("SSH connection closed before the command completed")));
    client.connect(connectConfig(device));
  });
}
