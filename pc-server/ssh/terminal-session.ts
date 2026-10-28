// ssh/terminal-session.ts — WebSocket 终端会话:前端的终端模拟器 ↔ 连接池里那条带 PTY 的 channel。
//
// 为什么是 WebSocket 而不是 HTTP 分片轮询:终端是双向、连续、按字节的一段流。「远端随时可写」和
// 「按键立刻生效」在请求-响应模型里都表达不了。仓库里 /api/asr/realtime 已是同一形状
// (server.ts 里 upgrade + websocket 分派),这里照它接。
//
// 帧协议(全是文本帧,内容 JSON;远端输出用 base64——一个 UTF-8 字符可能被 PTY 分包切成两半,
// 字符串帧会在前端解出替换字符,字节帧交给 xterm.js 自己按流解码):
//   前端 → 服务端  {type:"start",deviceId,dirId,cols,rows} → 打开终端
//                 {type:"input",data}                       → 写进 shell 的输入
//                 {type:"resize",cols,rows}                 → 窗口尺寸变更
//                 {type:"close"}                            → 主动结束终端
//   服务端 → 前端  {type:"output",data:<base64>}            → 远端输出(PTY 已合并 stderr)
//                 {type:"exit",code,connectionLost}         → 终端结束(code 为 null = 没拿到退出码)
//                 {type:"error",...}                        → sshFailureBody 的那份载荷
//
// 与安卓端 SshTerminalTransport + Termux TerminalSession 的对齐(状态行连排版都照抄,前端不必特判):
// - 打开前往缓冲区写 `[Connecting to user@host:port...]\r\n`(initializeEmulator 打印 describeStart)。
// - 结束前写 `\r\n[<描述>]`:拿到退出码 → `Process completed (code N) - press Enter`,
//   没拿到且连接已断 → `Connection lost`,其余(本地关闭、被信号带走)→ `Session closed`
//   (describeExit 的三支)。
// - 连接途中就被关掉 → `[Terminal closed]`(start 里 killed 分支抛的那个 IOException)。
// - 前端读得慢就暂停 channel 的 readable(安卓端读取队列写满时停止读取,同一取向)。
//
// 纪律:输入与输出都不写日志、不进错误中心——终端里敲的可能是 sudo 密码,回显里可能有密钥。
// 授权目录仍是唯一边界:dirId 必须是设备条目里已登记的那一条,没有「先连上再浏览」。

import type { SshDevice } from "../foundation/types/settings";
import { state } from "../persistence/json-store";
import type { SshTerminalHandle } from "./connection";
import { addressOf } from "./errors";
import { sshFailureBody, sshFailureInfo } from "./failure";
import { MAX_COLS, MAX_ROWS } from "./constants";
import { sshPool } from "./pool";
import { authorizedRemoteDir } from "./remote-files";

/** 服务端暂停读取的水位:超过它就压住 channel;回落到 LOW 以下再放开。 */
const HIGH_WATER_MARK_BYTES = 1024 * 1024;
const LOW_WATER_MARK_BYTES = 256 * 1024;
/** 暂停期间的回落检查周期:没有新数据就没人再检查水位,不轮询会永久卡住。 */
const RESUME_CHECK_INTERVAL_MS = 100;

/** Bun 的 ServerWebSocket 的结构子集:测试替身只要 send/close 就能跑。 */
export interface TerminalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
}

export interface TerminalClientFrame {
  type: string;
  deviceId?: string;
  dirId?: string;
  cols?: number;
  rows?: number;
  data?: string;
}

function sendFrame(socket: TerminalSocket, frame: Record<string, unknown>): void {
  // socket 可能已经关了(浏览器切走标签):发送失败不算错,由 close 回调收尾。
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    /* 忽略:前端已经不在了 */
  }
}

/** 终端里的一行状态文本(与安卓端一样,它是「缓冲区内容」而不是弹窗)。 */
function sendTerminalText(socket: TerminalSocket, text: string): void {
  sendFrame(socket, { type: "output", data: Buffer.from(text, "utf8").toString("base64") });
}

/**
 * 退出行的三支(describeExit)。code 为 null = ssh2 没给出 exit-status:
 * 本地 close 掉、被信号带走、或掉线——靠 connectionLost 区分后两种。
 */
export function describeTerminalExit(code: number | null, connectionLost: boolean): string {
  if (code !== null) {
    const reason = code > 0 ? ` (code ${code})` : code < 0 ? ` (signal ${-code})` : "";
    return `Process completed${reason} - press Enter`;
  }
  return connectionLost ? "Connection lost" : "Session closed";
}

/** 尺寸夹取:浏览器给什么就发什么会造出荒谬的窗口(几百万列),远端按最大尺寸分配行缓冲。 */
function clampSize(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

class TerminalSession {
  private handle: SshTerminalHandle | null = null;
  private opening = false;
  /** 前端在 openTerminal 还没回来时就把关掉了:连接到手的第一件事是收掉它(安卓端同名标志)。 */
  private killed = false;
  private ended = false;
  private paused = false;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly socket: TerminalSocket) {}

  /**
   * 打开终端。dirPath 必须已由调用方过授权(见 handleTerminalFrame 里的 authorizedRemoteDir):
   * 判定在握手之前,连一条 TCP 都不发,与文件面 remote-files.ts 的边界同一条规则。
   */
  start(device: SshDevice, dirPath: string, cols: number, rows: number): void {
    if (this.opening || this.handle || this.ended) {
      // 带 type 才是一条前端能路由的帧:裸发 sshFailureBody() 会让「已忙」被静默丢掉,
      // 界面停在 running 却什么也连不上(handleTerminalFrame 的 busy 分支就是这么写的)。
      sendFrame(this.socket, { type: "error", ...terminalBusyBody() });
      return;
    }
    this.opening = true;
    sendTerminalText(this.socket, `[Connecting to ${addressOf(device)}...]\r\n`);
    sshPool.openTerminal(device, {
      cwd: dirPath,
      cols,
      rows,
      onData: (chunk) => this.onData(chunk),
      onExit: (code, connectionLost) => this.onExit(code, connectionLost),
    }).then((handle) => {
      this.opening = false;
      // 连接途中已被关掉:立刻收尾,不把这条终端交给一个已经不存在的标签页。
      if (this.killed || this.ended) {
        if (!this.ended) this.finish("Terminal closed", null, false);
        handle.close();
        return;
      }
      this.handle = handle;
    }, (error) => {
      this.opening = false;
      if (this.ended) return;
      this.ended = true;
      this.stopResumeTimer();
      sendFrame(this.socket, { type: "error", ...sshFailureBody(sshFailureInfo(error)) });
      this.closeSocket();
    });
  }

  write(data: string): void {
    // 还没连上就敲键:安卓端是「transport 没 start,写入被读取线程丢掉」,这里同样丢弃而不是排队,
    // 否则重连一次会把上一次会话的按键补发给新的 shell。
    this.handle?.write(data);
  }

  resize(cols: unknown, rows: unknown): void {
    // Termux 的契约:只在 start 成功之后通知尺寸;更早的 resize 没有接收方。
    // 参数走 clampSize:帧里的尺寸来自前端布局,可能是 undefined(只拖了窗口没重发的帧)或荒谬的大数。
    this.handle?.resize(clampSize(cols, 80, MAX_COLS), clampSize(rows, 24, MAX_ROWS));
  }

  /** 前端发的 close:关终端,退出行照常回到前端,然后由服务端关闭这条 WebSocket。 */
  requestClose(): void {
    this.killed = true;
    if (this.handle) {
      this.handle.close();
      return;
    }
    // 还在连接途中:openTerminal 的回调负责打这一行(见 start 的 killed 分支)。
    if (!this.ended && !this.opening) this.finish("Terminal closed", null, false);
  }

  /** WebSocket 没了(切页面、断网):没有可回报的前端,直接收掉终端。 */
  dispose(): void {
    this.killed = true;
    this.ended = true;
    this.stopResumeTimer();
    const handle = this.handle;
    this.handle = null;
    try {
      handle?.close();
    } catch {
      /* 忽略:channel 已经在关闭 */
    }
  }

  private onData(chunk: Buffer): void {
    sendFrame(this.socket, { type: "output", data: chunk.toString("base64") });
    this.checkWaterMark();
  }

  /**
   * 背压:Bun 的 ws 没有 drain 事件,只能自己按缓冲量压/放 channel 的 readable。
   * 暂停后由定时器找机会放开——远端安静下来时不会再有 onData,不轮询就会把终端冻住。
   */
  private checkWaterMark(): void {
    const buffered = this.socket.getBufferedAmount?.();
    if (buffered === undefined || !this.handle) return;
    if (!this.paused && buffered > HIGH_WATER_MARK_BYTES) {
      this.paused = true;
      this.handle.pauseOutput();
      this.startResumeTimer();
      return;
    }
    if (this.paused && buffered < LOW_WATER_MARK_BYTES) this.resumeOutput();
  }

  private startResumeTimer(): void {
    if (this.resumeTimer) return;
    this.resumeTimer = setInterval(() => {
      if (this.ended) {
        this.stopResumeTimer();
        return;
      }
      if ((this.socket.getBufferedAmount?.() ?? 0) < LOW_WATER_MARK_BYTES) this.resumeOutput();
    }, RESUME_CHECK_INTERVAL_MS);
    // 定时器不该把进程钉在退出流程里(与连接池的空闲扫描同一纪律)。
    if (typeof this.resumeTimer === "object" && "unref" in this.resumeTimer) this.resumeTimer.unref();
  }

  private resumeOutput(): void {
    if (!this.paused) return;
    this.paused = false;
    this.stopResumeTimer();
    this.handle?.resumeOutput();
  }

  private stopResumeTimer(): void {
    if (!this.resumeTimer) return;
    clearInterval(this.resumeTimer);
    this.resumeTimer = null;
  }

  private onExit(code: number | null, connectionLost: boolean): void {
    if (this.ended) return;
    this.finish(describeTerminalExit(code, connectionLost), code, connectionLost);
  }

  private finish(line: string, code: number | null, connectionLost: boolean): void {
    this.ended = true;
    this.stopResumeTimer();
    sendTerminalText(this.socket, `\r\n[${line}]`);
    sendFrame(this.socket, { type: "exit", code, connectionLost });
    this.closeSocket();
  }

  private closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      /* 忽略:已经关了 */
    }
  }
}

/** 每条 WebSocket 一个终端(与 media/asr.ts 的会话登记同一形态);socket 没了会话也就没了。 */
const terminalSessions = new WeakMap<object, TerminalSession>();

function frameOf(raw: string): TerminalClientFrame | null {
  // 裸 JSON.parse 会把恶意/损坏的文本帧抛进 uncaughtException 安全网(仓库里踩过,批次二 R5-6)。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") return null;
  return parsed as TerminalClientFrame;
}

/** 已保存的设备条目:终端不接收内联草稿,授权目录本来就跟着设备一起落库。 */
function savedDevice(deviceId: string): SshDevice | null {
  const items = Array.isArray(state.settings.sshDevices) ? state.settings.sshDevices : [];
  return items.find((item) => item.id === String(deviceId ?? "").trim()) ?? null;
}

function terminalBusyBody(): Record<string, unknown> {
  return sshFailureBody({ status: 400, message: "Terminal session is already running", errorCode: "ssh.terminal_busy" });
}

export function handleTerminalFrame(socket: TerminalSocket, raw: string): void {
  const frame = frameOf(raw);
  if (!frame) return;
  if (frame.type === "start") {
    if (terminalSessions.has(socket)) {
      sendFrame(socket, { type: "error", ...terminalBusyBody() });
      return;
    }
    const device = savedDevice(String(frame.deviceId ?? ""));
    if (!device) {
      sendFrame(socket, {
        type: "error",
        ...sshFailureBody({ status: 404, message: "SSH device not found", errorCode: "ssh.device_not_found" }),
      });
      return;
    }
    // 授权在登记会话之前:目录没登记就不该留下「这条 WebSocket 已经有一个终端」的痕迹,
    // 否则界面改一个目录再点连接只会收到 terminal_busy,而这条连接其实从没建过。
    let dirPath: string;
    try {
      dirPath = authorizedRemoteDir(device, String(frame.dirId ?? "")).path;
    } catch (error) {
      sendFrame(socket, { type: "error", ...sshFailureBody(sshFailureInfo(error)) });
      return;
    }
    const session = new TerminalSession(socket);
    terminalSessions.set(socket, session);
    session.start(device, dirPath, clampSize(frame.cols, 80, MAX_COLS), clampSize(frame.rows, 24, MAX_ROWS));
    return;
  }
  const session = terminalSessions.get(socket);
  if (!session) return;
  if (frame.type === "input") session.write(typeof frame.data === "string" ? frame.data : "");
  if (frame.type === "resize") session.resize(frame.cols, frame.rows);
  if (frame.type === "close") session.requestClose();
}

/** WebSocket 关闭(server.ts 的 websocket.close)→ 收掉它名下那条终端 channel。 */
export function disposeTerminalSession(socket: TerminalSocket): void {
  const session = terminalSessions.get(socket);
  if (!session) return;
  terminalSessions.delete(socket);
  session.dispose();
}
