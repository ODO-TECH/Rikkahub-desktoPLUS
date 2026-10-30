// tools/mcp-stdio.ts — MCP 本地 stdio 传输
//
// 协议：每行一条 JSON-RPC 消息（MCP stdio transport），stdout 只承载协议消息，
// stderr 作为诊断日志。子进程按服务器 id 常驻复用；命令/参数/env/工作目录任一变化
// 即重启，服务器删除或应用退出时整组清理（Windows 用 taskkill /T 连带子进程）。
//
// 纪律：本模块不读写 state，不依赖 api；日志由调用方（mcp.ts）统一记录。

import type { JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { readMcpHeaders } from "./mcp-headers";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const STDERR_TAIL_LIMIT = 8000;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StdioRuntime {
  serverId: string;
  fingerprint: string;
  process: Bun.PipedSubprocess;
  pending: Map<number, PendingRequest>;
  nextId: number;
  stdoutBuffer: string;
  stderrTail: string;
  ready: Promise<void>;
  closed: boolean;
}

const runtimes = new Map<string, StdioRuntime>();

export function isStdioMcpServer(server: Record<string, JsonValue>): boolean {
  return String(server.type ?? "") === "stdio";
}

function readStringArray(raw: JsonValue | undefined): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item ?? "")).filter((item) => item.length > 0);
  if (typeof raw === "string" && raw.trim()) return raw.trim().split(/\s+/).filter(Boolean);
  return [];
}

function envRecord(server: Record<string, JsonValue>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const pair of readMcpHeaders(server.env)) {
    const name = pair.name.trim();
    if (name) env[name] = pair.value;
  }
  return env;
}

function resolveCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("本地 MCP 服务器缺少启动命令");
  return Bun.which(trimmed) ?? trimmed;
}

function fingerprintOf(server: Record<string, JsonValue>): string {
  return JSON.stringify({
    command: String(server.command ?? ""),
    args: readStringArray(server.args),
    env: readMcpHeaders(server.env),
    cwd: String(server.cwd ?? ""),
  });
}

/** 日志展示用的地址（不含参数，避免把令牌等敏感值带进 URL 字段）。 */
export function stdioLabel(server: Record<string, JsonValue>): string {
  return `stdio://${String(server.command ?? "").trim() || "command"}`;
}

/** 决定是否需要重启子进程的配置指纹（command/args/env/cwd）。设置层据此在保存时主动收掉旧进程。 */
export function stdioConfigFingerprint(server: Record<string, JsonValue>): string {
  return fingerprintOf(server);
}

function appendStderr(runtime: StdioRuntime, chunk: string): void {
  runtime.stderrTail = (runtime.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
}

function failureMessage(runtime: StdioRuntime, reason: string): string {
  const tail = runtime.stderrTail.trim();
  return tail ? `${reason}\n${tail.slice(-1500)}` : reason;
}

function closeRuntime(runtime: StdioRuntime): void {
  if (runtime.closed) return;
  runtime.closed = true;
  for (const pending of runtime.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`${pending.method} 已中止：本地 MCP 进程已关闭`));
  }
  runtime.pending.clear();
  try {
    runtime.process.stdin.end();
  } catch {
    // 进程可能已经退出。
  }
  try {
    if (runtime.process.exitCode === null) {
      if (process.platform === "win32") {
        Bun.spawnSync({
          cmd: ["taskkill", "/pid", String(runtime.process.pid), "/T", "/F"],
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        });
      } else {
        runtime.process.kill();
      }
    }
  } catch {
    // 已退出或无权终止；交给 exited 回调清理。
  }
  if (runtimes.get(runtime.serverId) === runtime) runtimes.delete(runtime.serverId);
}

export function closeStdioClient(serverId: string): void {
  const runtime = runtimes.get(serverId);
  if (runtime) closeRuntime(runtime);
}

/** 配置变化后清理已不存在的服务器进程（由健康 Supervisor 的 reconcile 调用）。 */
export function pruneStdioClients(activeServerIds: ReadonlySet<string>): void {
  for (const [serverId, runtime] of runtimes) {
    if (!activeServerIds.has(serverId)) closeRuntime(runtime);
  }
}

export function closeAllStdioClients(): void {
  for (const runtime of Array.from(runtimes.values())) closeRuntime(runtime);
}

function writeMessage(runtime: StdioRuntime, message: Record<string, unknown>): void {
  if (runtime.closed) throw new Error("本地 MCP 进程已关闭");
  runtime.process.stdin.write(`${JSON.stringify(message)}\n`);
  const flushed = runtime.process.stdin.flush();
  // Bun 的 flush 通常同步返回；类型上允许 Promise，这里不阻塞解析循环。
  if (flushed instanceof Promise) void flushed.catch(() => undefined);
}

function respondToServerRequest(runtime: StdioRuntime, message: Record<string, unknown>): void {
  const requestId = message.id;
  if (requestId === undefined) return;
  const method = String(message.method ?? "");
  if (method === "ping") {
    writeMessage(runtime, { jsonrpc: "2.0", id: requestId, result: {} });
    return;
  }
  writeMessage(runtime, {
    jsonrpc: "2.0",
    id: requestId,
    error: { code: -32601, message: `Client does not support '${method}'` },
  });
}

function handleLine(runtime: StdioRuntime, line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    // 不守协议的 stdout 行（启动横幅等）当作诊断信息保留，不打断会话。
    appendStderr(runtime, `${line}\n`);
    return;
  }
  if (!isRecord(message)) return;
  const hasId = message.id !== undefined && message.id !== null;
  const method = typeof message.method === "string" ? message.method : undefined;
  // 服务器 → 客户端的请求（ping/roots/sampling 等）：能力集声明为空，除 ping 外一律回
  // method not found，避免服务器无限等待。
  if (method !== undefined) {
    if (hasId) respondToServerRequest(runtime, message);
    return;
  }
  if (!hasId) return;
  const pending = runtime.pending.get(Number(message.id));
  if (!pending) return;
  runtime.pending.delete(Number(message.id));
  clearTimeout(pending.timer);
  if (isRecord(message.error)) {
    const err = message.error;
    pending.reject(new Error(String(err.message ?? JSON.stringify(err))));
    return;
  }
  pending.resolve(message.result ?? null);
}

function pumpStdout(runtime: StdioRuntime): void {
  const reader = runtime.process.stdout.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        runtime.stdoutBuffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = runtime.stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = runtime.stdoutBuffer.slice(0, newline).replace(/\r$/, "").trim();
          runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newline + 1);
          if (line) handleLine(runtime, line);
        }
      }
    } catch {
      // 进程退出时 read 抛错属正常路径，由 exited 回调统一收尾。
    }
  })();
}

function pumpStderr(runtime: StdioRuntime): void {
  const reader = runtime.process.stderr.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        appendStderr(runtime, decoder.decode(value, { stream: true }));
      }
    } catch {
      // 同上。
    }
  })();
}

function sendRequest(runtime: StdioRuntime, method: string, params: Record<string, JsonValue> | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = runtime.nextId++;
    const timer = setTimeout(() => {
      runtime.pending.delete(requestId);
      reject(new Error(`MCP stdio ${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      closeRuntime(runtime);
    }, timeoutMs);
    runtime.pending.set(requestId, { method, resolve, reject, timer });
    try {
      writeMessage(runtime, { jsonrpc: "2.0", id: requestId, method, params: params ?? {} });
    } catch (err) {
      runtime.pending.delete(requestId);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function sendNotification(runtime: StdioRuntime, method: string, params?: Record<string, JsonValue>): void {
  writeMessage(runtime, { jsonrpc: "2.0", method, params: params ?? {} });
}

function createRuntime(server: Record<string, JsonValue>): StdioRuntime {
  const serverId = String(server.id ?? "");
  if (!serverId) throw new Error("本地 MCP 服务器缺少 id");
  const command = resolveCommand(String(server.command ?? ""));
  const args = readStringArray(server.args);
  const cwd = String(server.cwd ?? "").trim();
  let processHandle: Bun.PipedSubprocess;
  try {
    processHandle = Bun.spawn({
      cmd: [command, ...args],
      cwd: cwd || undefined,
      env: envRecord(server),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`无法启动本地 MCP 命令「${command}」：${message}`);
  }
  // Bun.spawn 对部分启动失败只在 exited 上暴露（如工作目录不存在、解释器缺失）。
  const runtime: StdioRuntime = {
    serverId,
    fingerprint: fingerprintOf(server),
    process: processHandle,
    pending: new Map(),
    nextId: 1,
    stdoutBuffer: "",
    stderrTail: "",
    ready: Promise.resolve(),
    closed: false,
  };
  runtimes.set(serverId, runtime);
  pumpStdout(runtime);
  pumpStderr(runtime);
  void processHandle.exited.then((code) => {
    runtime.closed = true;
    for (const pending of runtime.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(failureMessage(runtime, `本地 MCP 进程已退出（code ${code}）`)));
    }
    runtime.pending.clear();
    if (runtimes.get(serverId) === runtime) runtimes.delete(serverId);
  });
  // 初始化握手：MCP 规范要求 initialize 后紧跟 notifications/initialized。
  // 超时放宽到 60s：npx -y / uvx 冷启动要先下载安装整个包（受限沙盒下缓存还是全新的），
  // midi-file-mcp 这类带大依赖的包 30s 装不完，会被误判成"进程已退出/无响应"。
  runtime.ready = (async () => {
    await sendRequest(runtime, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "RikkaHub PC", version: "pc-dev" },
    }, 60_000);
    sendNotification(runtime, "notifications/initialized");
  })().catch((err) => {
    closeRuntime(runtime);
    throw err;
  });
  return runtime;
}

/** 取（或重建）服务器对应的 stdio 运行时。命令/参数/env/cwd 变化会重启子进程。 */
function ensureRuntime(server: Record<string, JsonValue>): StdioRuntime {
  const serverId = String(server.id ?? "");
  const fingerprint = fingerprintOf(server);
  const existing = runtimes.get(serverId);
  if (existing && !existing.closed && existing.fingerprint === fingerprint) return existing;
  if (existing) closeRuntime(existing);
  return createRuntime(server);
}

/** 发一条 JSON-RPC 请求（自动完成 initialize 握手）。只支持服务器支持的方法。 */
export async function stdioRequest(
  server: Record<string, JsonValue>,
  method: string,
  params: Record<string, JsonValue> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const runtime = ensureRuntime(server);
  await runtime.ready;
  return sendRequest(runtime, method, params, timeoutMs);
}
