// ssh/connection.ts — 一条已认证、已核对主机密钥的 SSH 连接(ssh2)。
//
// 与安卓端 workspace/ssh/SshConnection.kt 的分工一致,这一层负责:
// 1) 认证前核对主机密钥:未信任 / 与已信任不一致时握手直接被拒,凭据一个字节都不发出去
//    (JSch 用自定义 HostKeyRepository + StrictHostKeyChecking=yes;ssh2 用 hostVerifier,
//     把服务器出示的原始公钥 blob 交给我们,拒绝理由自己记账,连接失败时优先抛理由);
// 2) 密码认证同时支持 keyboard-interactive(部分 sshd 只开 challenge-response,只发
//     password 会认证失败——这是对齐前 rdp 连不上某些服务器的真实原因);
// 3) exec / SFTP / PTY 三类 channel 与超时、截断、取消语义;
// 4) 远端事实(shell 路径、主目录)按连接缓存,不再每一步都往返服务器。
//
// 纪律:device 只用于建连与比对,绝不进 message/日志;对外文案只出现 user@host:port。
// 与安卓端的不同之处一律写在「差异:」注释里,便于两端对表。

import { Client, type Channel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { SshDevice, SshHostKey } from "../foundation/types/settings";
import {
  CHANNEL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  EXEC_TIMEOUT_DEFAULT_MS,
  FALLBACK_SHELL,
  KEEPALIVE_COUNT_MAX,
  KEEPALIVE_INTERVAL_MS,
  MAX_OUTPUT_CHARS,
  SHELL_DETECT_TIMEOUT_MS,
  TERMINAL_TYPE,
} from "./constants";
import { buildExecCommand, buildShellCommand, pickShellPath, SHELL_PROBE_COMMAND } from "./command-wrap";
import {
  addressOf,
  SshAbortedError,
  SshChannelOpenError,
  SshHostKeyChangedError,
  SshHostKeyUnknownError,
  SshInputError,
  SshTransportError,
  transportError,
} from "./errors";
import { encodeHostKey, withFingerprint } from "./host-key";
import { normalizeRemotePath } from "./remote-path";

export interface SshExecOutcome {
  stdout: string;
  stderr: string;
  /** 远端退出码;null = 被信号终止或没拿到。 */
  code: number | null;
  signal: string;
  /** 任一输出流超过 MAX_OUTPUT_CHARS,已截断(仍继续读完,免得远端进程堵在管道上)。 */
  truncated: boolean;
  /** 超时被 kill:退出码不可信,与安卓端 timedOut 同义。 */
  timedOut: boolean;
}

export interface SshExecOptions {
  /** 远端工作目录(绝对路径)。给了就按安卓端那层外壳执行。 */
  cwd?: string;
  timeoutMs?: number;
  /** stdin 内容;不传则立即 EOF(否则 isatty 类工具会挂着等输入)。 */
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  /** 流式输出回调,用于界面「边跑边看」。 */
  onData?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface SshProbeResult {
  hostKey: SshHostKey;
  homeDir: string;
  shell: string;
  /** 归一后的目标目录;空串 = 本次探测没有目标目录(测试连接时目录还没填)。 */
  remoteDir: string;
  remoteDirExists: boolean;
  /** 握手 + 认证耗时;安卓端不测这个,rdp 控制台一直有,保留为附加信息。 */
  latencyMs: number;
}

export interface SshTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * 暂停/恢复读取远端输出。安卓端的终端读取线程在 UI 队列写满时直接停止读取
   * (ProcessOutputQueue.write 回 false 就 return),等价于这里暂停 channel 的 readable 侧;
   * 没有它,前端读得慢时远端 `yes` 这类刷屏会把输出无限堆进内存。
   */
  pauseOutput(): void;
  resumeOutput(): void;
  close(): void;
  readonly closed: boolean;
}

export interface SshTerminalOptions {
  cwd: string;
  cols: number;
  rows: number;
  onData: (chunk: Buffer) => void;
  /** 远端退出码;null 表示掉线或本地关闭,不是 shell 正常退出。 */
  onExit: (code: number | null, connectionLost: boolean) => void;
  signal?: AbortSignal;
}

/**
 * 开成功的 exec channel + 「早到的退出码」账本。
 *
 * 为什么要带账本:ssh2 在 CHANNEL_REQUEST(exit-status) 的报文解析里**同步** emit exit
 * (见 client.js 的 `channel.emit('exit', exit.code = data)`),而 await 之后的续体是微任务。
 * 远端秒退时「确认打开」和「exit-status」落在同一次 socket 读的连续报文里,等调用方挂上监听,
 * exit 早就发完了——退出码永远丢,近端只看到 close。测试里三条退出码断言全成 -1 就是这个坑。
 * 所以在 channel 到手的第一行就登记,后续再补一个监听覆盖常规时序。
 */
interface OpenedChannel {
  channel: Channel;
  exit: { code: number | null; signal: string; seen: boolean };
}

/**
 * PTY 的 IUTF8 模式:RFC 8160 把 TTY_OP_IUTF8 定为 opcode **42**(值 1),结尾 TTY_OP_END = 0。
 * 与安卓端 SshConnection.TERMINAL_MODES 逐字节一致——开了它,行编辑才按 UTF-8 字符退格,
 * 中文删一个字不会在远端留下半个字节。
 *
 * 只能按字节断言:ssh2 自己的 TERMINAL_MODE 表在 41(IMAXBEL)与 50(ISIG)之间漏了 42,
 * 实测它的服务端把任何 modes 都解成空对象(既看不到 IUTF8,也不会因此报错)。
 * 真实 OpenSSH/dropbear 认 42(RFC 8160 就是 OpenSSH 提出的),JSch 发的也是这六个字节。
 */
export const TERMINAL_MODES = Buffer.from([42, 0, 0, 0, 1, 0]);

/**
 * SSH_FX_NO_SUCH_FILE。@types/ssh2 的 `sftp` 常量只挂在模块命名空间上、运行时才存在,
 * 这里只声明用得到的那一个,免得为两个数字把 ssh2 的内部结构引进类型层。
 */
const SFTP_NO_SUCH_FILE = 2;

export class SshConnection {
  /** 握手 + 认证耗时,建连成功时写入。 */
  latencyMs = 0;
  private closed = false;
  /**
   * socket 是否在线。ssh2 的 Client 不暴露 `connected`,只能自己记账:
   * ready 置真,close/error 置假——池的「断了就重连」和终端的「Connection lost」判定都读它。
   */
  private socketUp = false;
  /** 远端 shell 路径:每条连接探测一次(exec 外壳与终端命令都要用它)。 */
  private shellPromise: Promise<string> | null = null;
  private homePromise: Promise<string> | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  /** 已确认存在的远端目录(安卓端 ensuredDirs):同一连接上不重复 mkdirs。 */
  private readonly ensuredDirs = new Set<string>();
  /** 正在建的目录 → 同一次 mkdirs 的共享 promise,并发请求只走一趟。 */
  private readonly ensurePromises = new Map<string, Promise<void>>();
  /** 挂着的终端数量:空闲回收不能拆正在用的连接(安卓端用引用计数表达同一件事)。 */
  private terminals = 0;

  private constructor(
    private readonly client: Client,
    /** 建连用的设备快照:池按它判断「配置变了就重连」,也用来出地址。 */
    readonly device: SshDevice,
    /** 本次连接实际核对通过的密钥。 */
    readonly hostKey: SshHostKey,
  ) {}

  get address(): string {
    return addressOf(this.device);
  }

  get isConnected(): boolean {
    return !this.closed && this.socketUp;
  }

  /** 仅建连流程调用:认证成功、socket 在线。 */
  markReady(): void {
    this.socketUp = true;
  }

  /** 仅建连流程注册的 close/error 监听调用:认证后掉线也走这里。 */
  markDown(): void {
    this.socketUp = false;
  }

  /** 空闲回收判据:有终端挂着就不算空闲。 */
  get busy(): boolean {
    return this.terminals > 0;
  }

  assertOpen(): void {
    if (this.closed) throw transportError(`SSH connection to ${this.address} is closed`);
  }

  /**
   * 建连并完成认证。signal 取消时:晚到的成功连接会被就地关掉,不进池
   * (对齐安卓端 awaitInterruptibly 的 onAbandoned 规则)。
   */
  static connect(device: SshDevice, options: { signal?: AbortSignal } = {}): Promise<SshConnection> {
    const startedAt = Date.now();
    const address = addressOf(device);
    return new Promise<SshConnection>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;
      /** 服务器实际出示过的密钥与拒绝理由(优先于 ssh2 的笼统报错)。 */
      let presented: SshHostKey | null = null;
      let rejection: Error | null = null;
      let connection: SshConnection | null = null;

      const detach = () => {
        if (timer !== null) clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      };
      const drop = () => {
        try {
          client.destroy();
        } catch {
          /* 忽略:socket 状态已不可靠 */
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        detach();
        drop();
        reject(error);
      };

      const trusted = withFingerprint(device.hostKey);
      const config = buildConnectConfig(device, (blob) => {
        const actual = encodeHostKey(blob);
        if (!actual) {
          rejection = transportError("SSH server sent a host key we cannot decode");
          return false;
        }
        presented = actual;
        if (!trusted) {
          rejection = new SshHostKeyUnknownError(actual);
          return false;
        }
        if (actual.key !== trusted.key) {
          rejection = new SshHostKeyChangedError(trusted, actual);
          return false;
        }
        return true;
      });

      if (config === null) {
        fail(new SshInputError(
          device.authType === "key" ? "SSH private key is required" : "SSH password is required",
          device.authType === "key" ? "ssh.missing_key" : "ssh.missing_password",
        ));
        return;
      }

      // 差异(也是这次对齐修掉的坑):JSch 拿到 UserInfo 就能自己应答 challenge-response,
      // ssh2 只会把提示 emit 成客户端的 'keyboard-interactive' 事件——不挂监听就等于不回答,
      // 服务器会一直等 USERAUTH_INFO_RESPONSE,连接卡到超时。光设 tryKeyboard 是不够的。
      // 应答策略与安卓端 PasswordUserInfo.promptKeyboardInteractive 一致:每个提示都回配置里的密码。
      if (device.authType === "password") {
        client.on(
          "keyboard-interactive",
          (_name, _instructions, _lang, prompts, finish) => {
            finish(prompts.map(() => device.password));
          },
        );
      }

      client.on("ready", () => {
        if (!presented) {
          fail(transportError(`SSH server did not present a host key for ${address}`));
          return;
        }
        if (settled) {
          // 取消后才 ready:关掉这条连接,不留残骸。
          if (abandoned) {
            try {
              client.end();
            } catch {
              drop();
            }
          }
          return;
        }
        settled = true;
        detach();
        connection = new SshConnection(client, device, presented);
        connection.latencyMs = Date.now() - startedAt;
        connection.markReady();
        resolve(connection);
      });
      client.on("error", (error: Error) => {
        // 密钥核对失败时 ssh2 只说 "Host denied (verification failed)";真实原因在我们这本账上。
        // 认证成功之后的错误只记掉线,不再reject(promise 已定);池靠 isConnected 决定重连。
        if (connection) connection.markDown();
        else fail(rejection ?? wrapConnectFailure(error, address));
      });
      client.on("close", () => {
        if (connection) connection.markDown();
        else fail(rejection ?? transportError(`SSH connection to ${address} closed before authentication completed`));
      });

      timer = setTimeout(() => {
        fail(transportError(`SSH connection to ${address} timed out after ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s`));
      }, CONNECT_TIMEOUT_MS + 1_000);

      if (options.signal) {
        onAbort = () => {
          abandoned = true;
          fail(new SshAbortedError());
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        client.connect(config);
      } catch (error) {
        fail(wrapConnectFailure(error, address));
      }
    });
  }

  /** 执行一条命令:给了 cwd 就套安卓端那层外壳(env + 登录 shell + 位置参数)。 */
  async exec(command: string, options: SshExecOptions = {}): Promise<SshExecOutcome> {
    const wrapped = options.cwd
      ? buildExecCommand(await this.detectShell(), normalizeRemotePath(options.cwd), command)
      : command;
    return this.execRaw(wrapped, options);
  }

  /** 原样送进远端 exec channel,不做包装(探测 shell 走这条,避免自我递归)。 */
  async execRaw(command: string, options: SshExecOptions = {}): Promise<SshExecOutcome> {
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_DEFAULT_MS;
    const opened = await this.openExecChannel(command, {}, options.signal);
    const channel = opened.channel;

    return new Promise<SshExecOutcome>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;

      const detach = () => {
        if (timer !== null) clearTimeout(timer);
        if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (result?: SshExecOutcome, error?: Error) => {
        if (settled) return;
        settled = true;
        detach();
        if (error) reject(error);
        else resolve(result!);
      };
      // 超限后继续读完丢弃:远端进程堵在满管道上会一直不退出(安卓端 StreamCollector 同款纪律)。
      const collect = (which: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        options.onData?.(text, which);
        const current = which === "stdout" ? stdout : stderr;
        if (current.length >= MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
        const next = current + text;
        if (next.length > MAX_OUTPUT_CHARS) {
          truncated = true;
          if (which === "stdout") stdout = next.slice(0, MAX_OUTPUT_CHARS);
          else stderr = next.slice(0, MAX_OUTPUT_CHARS);
          return;
        }
        if (which === "stdout") stdout = next;
        else stderr = next;
      };

      channel.on("data", collect("stdout"));
      channel.stderr.on("data", collect("stderr"));
      // exit 状态一律读 opened.exit:早到的退出码已在 channel 打开时同步登记,
      // 这里再挂监听只为覆盖「退出比挂监听晚」的常规路径。
      channel.on("exit", (code: number | null, signal?: string) => {
        opened.exit.code = code ?? null;
        opened.exit.signal = signal ?? "";
        opened.exit.seen = true;
      });
      const finishFromClose = () => finish({
        stdout,
        stderr,
        // 拿不到退出码时按安卓端约定记 -1(超时/异常终止),界面仍显示退出码徽标。
        code: opened.exit.seen ? opened.exit.code : -1,
        signal: opened.exit.signal,
        truncated,
        timedOut: false,
      });
      channel.on("close", finishFromClose);
      channel.on("error", (error: Error) =>
        finish(undefined, transportError(`SSH exec on ${this.address} failed: ${error.message}`, error)));
      // 挂监听前 channel 已经关闭(stream 的 close 是异步发的,但极端情况下仍可能错过):
      // 立刻补一次收口,绝不让调用方挂到超时。
      if (channel.closed || channel.readableEnded) finishFromClose();

      timer = setTimeout(() => {
        // 超时只杀这一条 channel,连接留下继续用(安卓端 commandTimeout 用例锁的就是这点)。
        try {
          channel.signal("KILL");
        } catch {
          /* 忽略:很多 sshd 不收 signal */
        }
        try {
          channel.close();
        } catch {
          /* 忽略 */
        }
        finish({ stdout, stderr, code: -1, signal: "KILL", truncated, timedOut: true });
      }, timeoutMs);

      if (options.signal) {
        onAbort = () => {
          try {
            channel.close();
          } catch {
            /* 忽略 */
          }
          finish(undefined, new SshAbortedError());
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // stdin 不给内容就立即 EOF:否则 isatty 类工具会挂着等输入(安卓端同款处理)。
      if (options.stdin === undefined || options.stdin === null) channel.end();
      else channel.end(options.stdin);
    });
  }

  /**
   * 探测远端事实:主机密钥、主目录、shell、目标目录是否存在(安卓端 probe 的四件套)。
   * remoteDir 允许留空——「测试连接」时目录还没填,这时只报前三项,remoteDir 回空串、
   * exists 回 false,而不是拿一个半成品表单去报路径错误。
   */
  async probe(remoteDir?: string | null): Promise<SshProbeResult> {
    const dir = String(remoteDir ?? "").trim() ? normalizeRemotePath(String(remoteDir)) : "";
    const [homeDir, shell, remoteDirExists] = await Promise.all([
      this.homeDir(),
      this.detectShell(),
      dir ? this.directoryExists(dir) : Promise.resolve(false),
    ]);
    return { hostKey: this.hostKey, homeDir, shell, remoteDir: dir, remoteDirExists, latencyMs: this.latencyMs };
  }

  /** 远端 shell 绝对路径:`command -v bash` 最后一行绝对路径,失败兜底 /bin/sh。 */
  detectShell(): Promise<string> {
    this.shellPromise ??= this.execRaw(SHELL_PROBE_COMMAND, { timeoutMs: SHELL_DETECT_TIMEOUT_MS })
      .then((result) => pickShellPath(result.stdout, result.timedOut ? null : result.code, FALLBACK_SHELL))
      // 探测失败不缓存坏结果:下一条命令还会再试(安卓端 lazy 同样不缓存抛错的初始化)。
      .catch((error) => {
        this.shellPromise = null;
        throw error;
      });
    return this.shellPromise;
  }

  /** 远端用户主目录:SFTP realpath(".")——不靠 echo $HOME,免得被 rc 输出污染。 */
  homeDir(): Promise<string> {
    this.homePromise ??= this.withSftp((sftp) => realpath(sftp, ".")).catch((error) => {
      this.homePromise = null;
      throw error;
    });
    return this.homePromise;
  }

  directoryExists(dir: string): Promise<boolean> {
    const path = normalizeRemotePath(dir);
    return this.withSftp(async (sftp) => {
      const stats = await statOrNull(sftp, path);
      return !!stats?.isDirectory();
    });
  }

  /**
   * 确保远端目录存在(安卓端 SshConnection.ensureDir):每条连接只走一次网络。
   * 授权目录被误删时不是报错而是重新长出来,与本地工作区一致;失败的目录不写缓存,
   * 下次操作还会重试(拿不到结果就不算「已经建过」)。
   */
  ensureDir(dir: string): Promise<void> {
    const path = normalizeRemotePath(dir);
    if (this.ensuredDirs.has(path)) return Promise.resolve();
    // 同一目录的并发请求共用一次 mkdirs(一次文件面板打开会同时来好几个请求)。
    const inFlight = this.ensurePromises.get(path);
    if (inFlight) return inFlight;
    const pending = this.withSftp((sftp) => mkdirs(sftp, path)).then(() => {
      this.ensuredDirs.add(path);
    }, (error) => {
      this.ensurePromises.delete(path);
      throw error;
    });
    this.ensurePromises.set(path, pending);
    return pending;
  }

  /** 取用 SFTP channel:首建后复用;失败时重置,下次重开。 */
  withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    this.assertOpen();
    // 差异:安卓端因为 JSch 的 SFTP channel 非线程安全,上了可中断的全局锁串行化;
    // ssh2 的 SFTPWrapper 允许在同一 channel 上并发多个请求,所以这里不加锁。
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error || !sftp) {
          this.sftpPromise = null;
          reject(transportError(`Failed to open SFTP on ${this.address}: ${error?.message ?? "no channel"}`, error));
          return;
        }
        resolve(sftp);
      });
    });
    return this.sftpPromise.then(fn);
  }

  /**
   * 打开交互式终端:带 PTY 的 exec channel 里先 cd 到远程目录,再 exec 用户自己的登录 shell。
   * 打开期间连接算「被占用」,空闲回收不拆它(安卓端 openShell 持引用计数)。
   */
  async openTerminal(options: SshTerminalOptions): Promise<SshTerminalHandle> {
    this.assertOpen();
    const shell = await this.detectShell();
    const command = buildShellCommand(shell, normalizeRemotePath(options.cwd));
    this.terminals += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.terminals = Math.max(0, this.terminals - 1);
    };

    let opened: OpenedChannel;
    try {
      opened = await this.openExecChannel(command, { pty: ptyOptions(options.cols, options.rows) }, options.signal);
    } catch (error) {
      release();
      throw error;
    }
    const channel = opened.channel;

    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      release();
      options.onExit(code, !this.isConnected);
    };
    channel.on("data", (chunk: Buffer) => options.onData(chunk));
    channel.stderr.on("data", (chunk: Buffer) => options.onData(chunk));
    // 秒退的 shell:exit 在 openExecChannel 返回前就发完了,先读账本,别等 close 报成掉线。
    if (opened.exit.seen) finish(opened.exit.code);
    else channel.on("exit", (code: number | null) => finish(code ?? null));
    channel.on("close", () => finish(null));
    channel.on("error", () => finish(null));

    return {
      write: (data) => {
        // 用本地 ended 判断而不是 channel.closed:远端 shell 退出后 channel 可能还挂着,
        // 但再往里写已经没有意义(且会触发 sshd 侧的错误)。
        if (!finished) channel.write(data);
      },
      resize: (cols, rows) => {
        // 差异:JSch 用 setPtySize,ssh2 用 setWindow(rows, cols, height, width)。
        // ssh2 只在 channel 是 session/exec 且两端都还开着时才真发包,否则会静默 no-op(实测:
        // exec+PTY 一打开就 resize 是能发出去的,已关闭的 channel 才吞掉),所以不需要补发队列;
        // 尺寸没变时靠 sshd 自己吞掉 WINCH,这里不做额外去重。
        try {
          channel.setWindow(rows, cols, 0, 0);
        } catch {
          /* 忽略:channel 正在关闭 */
        }
      },
      pauseOutput: () => {
        // PTY 下 stderr 通常是空的,但它是独立 readable:两个一起暂停才算真的止住。
        for (const stream of outputStreams(channel)) {
          try {
            stream.pause();
          } catch {
            /* 忽略:流已销毁 */
          }
        }
      },
      resumeOutput: () => {
        for (const stream of outputStreams(channel)) {
          try {
            stream.resume();
          } catch {
            /* 忽略:channel 正在关闭 */
          }
        }
      },
      close: () => {
        finish(null);
        try {
          channel.close();
        } catch {
          /* 忽略 */
        }
      },
      get closed() {
        return finished;
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socketUp = false;
    this.sftpPromise = null;
    try {
      this.client.end();
    } catch {
      try {
        this.client.destroy();
      } catch {
        /* 忽略:进程正在退出 */
      }
    }
  }

  /** 打开一条 exec channel:等待回应可取消,超时视为「请求可能已送到」→ 整条连接收掉,绝不重试。 */
  private openExecChannel(
    command: string,
    options: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OpenedChannel> {
    this.assertOpen();
    return new Promise<OpenedChannel>((resolve, reject) => {
      let settled = false;
      let handle: OpenedChannel | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onAbort: (() => void) | null = null;
      const detach = () => {
        if (timer !== null) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error, closeConnection: boolean) => {
        if (settled) return;
        settled = true;
        detach();
        if (handle) {
          try {
            handle.channel.close();
          } catch {
            /* 忽略 */
          }
        }
        if (closeConnection) this.close();
        reject(error);
      };

      timer = setTimeout(
        () => fail(new SshTransportError(`Timed out waiting for exec reply from ${this.address}`), true),
        CHANNEL_TIMEOUT_MS,
      );
      if (signal) {
        onAbort = () => fail(new SshAbortedError(), false);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      this.client.exec(command, options, (error, channel) => {
        if (settled) {
          // 取消/超时后才成功的 channel:立刻关掉,不留远端进程(安卓端 c3d816a9 的规则)。
          try {
            channel?.close();
          } catch {
            /* 忽略 */
          }
          return;
        }
        settled = true;
        detach();
        if (error || !channel) {
          // 「确定没送到」才归类成 channel open 失败(可重连重试一次);
          // 其它情况远端可能已经在跑,重试会把不可重复的命令执行两遍。
          if (isChannelOpenFailure(error)) {
            reject(new SshChannelOpenError(error));
          } else {
            this.close();
            reject(transportError(`SSH exec on ${this.address} failed: ${error?.message ?? "no channel"}`, error));
          }
          return;
        }
        // 退出码账本从 channel 到手的第一行开始记,别让 await 续体的微任务窗口吃掉 exit。
        const exit: OpenedChannel["exit"] = { code: null, signal: "", seen: false };
        handle = { channel, exit };
        channel.on("exit", (code: number | null, sig?: string) => {
          exit.code = code ?? null;
          exit.signal = sig ?? "";
          exit.seen = true;
        });
        resolve(handle);
      });
    });
  }
}

/** 建连参数;返回 null 表示凭据缺失(还没上网络就失败)。 */
function buildConnectConfig(device: SshDevice, onHostKey: (blob: Buffer) => boolean): ConnectConfig | null {
  const base: ConnectConfig = {
    host: device.host,
    port: device.port,
    username: device.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    // 不设 hostHash:默认拿到的是原始公钥 blob(设了会被换成 md5 hex,就存不回可比对的 blob)。
    hostVerifier: (key: unknown, verify: (permitted: boolean) => void) => {
      verify(Buffer.isBuffer(key) ? onHostKey(key) : false);
    },
  };
  if (device.authType === "key") {
    if (!device.privateKey.trim()) return null;
    base.privateKey = device.privateKey;
    if (device.passphrase) base.passphrase = device.passphrase;
    base.authHandler = ["publickey"];
    return base;
  }
  if (!device.password) return null;
  base.password = device.password;
  // 只发 password 的话,只开 challenge-response 的 sshd 会认证失败;同一份密码也用来回答它的问题。
  base.tryKeyboard = true;
  base.authHandler = ["password", "keyboard-interactive"];
  return base;
}

function ptyOptions(cols: number, rows: number) {
  return { term: TERMINAL_TYPE, cols, rows, width: 0, height: 0, modes: TERMINAL_MODES };
}

/** 能暂停/恢复的读侧最小形状(背压只需要这两个方法,不需要整条 Stream 类型)。 */
type PauseableStream = { pause(): unknown; resume(): unknown };

/**
 * 终端输出的两条可读流:stdout 是 channel 自己的读侧,stderr 是 ssh2 单独建的 readable
 * (client.js 用 channel.stderr.push 投递,见 node_modules/ssh2/lib/client.js:609)。
 * @types/ssh2 把 stderr 声明成 `Writable | Readable`(同一接口也用于服务端通道),
 * 所以取用前做函数存在性检查,而不是断言糊过去——真拿到没有 pause 的对象时跳过它,
 * 至少 stdout 侧的背压还生效。
 */
function outputStreams(channel: Channel): PauseableStream[] {
  const streams: PauseableStream[] = [channel];
  const stderr = channel.stderr as Partial<PauseableStream>;
  if (typeof stderr.pause === "function" && typeof stderr.resume === "function") {
    streams.push(stderr as PauseableStream);
  }
  return streams;
}

/** ssh2 的报错可能带用户名或远端原文,统一收成「到 user@host:port 的连接失败: 原文」。 */
function wrapConnectFailure(error: unknown, address: string): SshTransportError {
  const message = error instanceof Error ? error.message : String(error);
  if (/private key|passphrase/i.test(message)) {
    return transportError(`Invalid SSH private key or passphrase for ${address}: ${message}`, error);
  }
  return transportError(`SSH connection to ${address} failed: ${message}`, error);
}

/** 「channel 没开成 = 请求肯定没送到」,对应安卓端的 session is down / channel is not opened.。 */
function isChannelOpenFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not connected|channel is not open|session is down|no such channel|connection closed/i.test(message);
}

/** SFTP realpath 的 promise 化。 */
export function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (error, real) => {
      if (error) reject(sftpFailure(`realpath failed for ${path}`, error));
      else resolve(real);
    });
  });
}

/** stat 不到就当不存在(安卓端 statOrNull 的语义);其它错误照抛。 */
export async function statOrNull(sftp: SFTPWrapper, path: string): Promise<SftpStats | null> {
  try {
    return await new Promise<SftpStats>((resolve, reject) => {
      sftp.stat(path, (error, stats) => {
        if (error) reject(error);
        else if (stats) resolve(stats as SftpStats);
        else reject(sftpFailure(`stat failed for ${path}`, new Error("empty reply")));
      });
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw sftpFailure(`stat failed for ${path}`, error);
  }
}

/** lstat:不跟随符号链接,删链子而不是删目标要靠它(安卓端 deleteFile 的判据)。 */
export async function lstatOrNull(sftp: SFTPWrapper, path: string): Promise<SftpStats | null> {
  try {
    return await new Promise<SftpStats>((resolve, reject) => {
      sftp.lstat(path, (error, stats) => {
        if (error) reject(error);
        else if (stats) resolve(stats as SftpStats);
        else reject(sftpFailure(`lstat failed for ${path}`, new Error("empty reply")));
      });
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw sftpFailure(`lstat failed for ${path}`, error);
  }
}

/**
 * 逐级建目录(安卓端 ChannelSftp.mkdirs 的语义):已存在就跳过,撞见同名文件就报错——
 * 静默把 `foo/bar` 里的 `foo` 当文件穿过去,只会在更深处冒出一个没人看得懂的失败。
 * 路径按字面发送,不做通配转义(判据见 ssh/remote-files.ts 头部第 2 条差异)。
 */
export async function mkdirs(sftp: SFTPWrapper, path: string): Promise<void> {
  const target = normalizeRemotePath(path);
  if (target === "/") return;
  let current = "";
  for (const part of target.split("/").filter((item) => item !== "")) {
    current = `${current}/${part}`;
    const stats = await statOrNull(sftp, current);
    if (stats) {
      if (!stats.isDirectory()) throw new SshInputError(`Not a directory: ${current}`, "ssh.not_a_directory");
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (error) => {
        if (error) reject(sftpFailure(current, error));
        else resolve();
      });
    });
  }
}

export type SftpStats = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: number;
};

/**
 * 「不存在」的判据:ssh2 把服务器回的 status code 挂在 err.code 上(数字),
 * 只有走本地文件系统分支的失败才是字符串码。先认数字 2(SSH_FX_NO_SUCH_FILE),
 * 文案匹配只兜住旧版与非标准回包——把「权限拒绝」误读成「不存在」会让人以为文件没了。
 */
export function isNotFound(error: unknown): boolean {
  if (error instanceof Error && (error as { code?: unknown }).code === SFTP_NO_SUCH_FILE) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied/i.test(message)) return false;
  return /no such file|not found|ENOENT|does not exist/i.test(message);
}

export function isPermissionDenied(error: unknown): boolean {
  return /permission denied/i.test(error instanceof Error ? error.message : String(error));
}

/** SFTP 失败文案:带路径,不带凭据;权限被拒单独说清(安卓端 Permission denied: path)。 */
export function sftpFailure(action: string, error: unknown): SshTransportError {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied/i.test(message)) return transportError(message, error);
  return transportError(`SFTP error on ${action}: ${message}`, error);
}

// 路径词法处理见 ssh/remote-path.ts(纯字符串,不拉 ssh2 进启动路径);
// 这里 re-export,让「连接层的一切」仍是 handlers 的单一入口。
export { lexicalNormalize, normalizeRemotePath, resolveInsideRoot } from "./remote-path";
