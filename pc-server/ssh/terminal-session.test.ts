// ssh/terminal-session.test.ts — WebSocket 终端会话的帧协议与状态行。
//
// 对照的是安卓端 SshTerminalTransport + Termux TerminalSession:这一层对外只有「前端发的帧」和
// 「用户在屏幕上看到的那几行字」,所以断言全落在帧上——状态行的措辞与位置、输出是字节而不是字符串、
// 连上之前的按键不排队、授权不成立时一条 TCP 都不发。这些地方一旦与移动端分叉,
// 同一台服务器、同一通操作在两端会看到不一样的画面,而那是这一层唯一值得测的东西。
//
// 纪律:假服务器只听 127.0.0.1,凭据是测试常量;用例结束把设备踢出连接池并还原 state.settings,
// 终端会话不留定时器(背压那个是 unref 的,但也照样在 afterEach 里关掉)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerChannel } from "ssh2";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import type { State } from "../foundation/types";
import { flushSaveState, setState, state } from "../persistence/json-store";
import { startFakeSshServer, type FakeSshServer } from "../test-utils/fake-ssh-server";
import {
  TEST_PASSWORD as PASSWORD,
  fixtureDevice,
  trustedHostKey,
  delay,
} from "../test-utils/ssh-fixtures";
import { buildShellCommand, SHELL_PROBE_COMMAND } from "./command-wrap";
import { MAX_COLS, MAX_ROWS, TERMINAL_TYPE } from "./constants";
import { sshPool } from "./pool";
import {
  describeTerminalExit,
  disposeTerminalSession,
  handleTerminalFrame,
  type TerminalSocket,
} from "./terminal-session";

const APP: SshRemoteDir = { id: "app", name: "应用目录", path: "/srv/app" };

// 测试进程没跑 loadState,按 api/auth.test.ts 的惯例注入最小 state:终端只认 settings.sshDevices
// 里已保存的设备条目(不接收内联草稿),state 不存在时连「有没有这台设备」都判不了。
const priorState = state;
beforeAll(() => setState({ settings: { sshDevices: [] } } as unknown as State));
afterAll(async () => {
  // 复位前 drain 在途落盘:与 auth.test 同一理由,尾随写会读到已复位的 state 而抛 TypeError。
  await flushSaveState();
  setState(priorState);
});

/** 记录每一帧的假 WebSocket:对外契约只有帧,测试不去摸私有状态。 */
class FakeSocket implements TerminalSocket {
  readonly frames: Array<Record<string, unknown>> = [];
  /** 背压水位由用例直接控制(getBufferedAmount 的回值)。 */
  buffered = 0;
  closedCount = 0;

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closedCount += 1;
  }

  getBufferedAmount(): number {
    return this.buffered;
  }

  /** 已收到的终端文本:把每个 output 帧按字节拼起来再解 UTF-8——PTY 分包切不开多字节字符。 */
  get text(): string {
    const chunks: Buffer[] = [];
    for (const frame of this.frames) {
      if (frame.type === "output" && typeof frame.data === "string") chunks.push(Buffer.from(frame.data, "base64"));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.type === type);
  }

  last(type: string): Record<string, unknown> {
    const found = this.ofType(type);
    if (found.length === 0) throw new Error(`没有 ${type} 帧,已收到 ${JSON.stringify(this.frames)}`);
    return found[found.length - 1]!;
  }
}

interface TerminalHarness {
  server: FakeSshServer;
  socket: FakeSocket;
  /** 远端那条 shell 通道(连上之后才存在)。 */
  shell(): ServerChannel;
  /** 服务器在 shell 通道上收到的客户端输入。 */
  inputs: string[];
}

/**
 * 起一台假服务器并把它登记进 settings:第二条 exec(登录 shell)保持打开,
 * 句柄与收到的输入交给用例。`echo` 打开时假 PTY 把写进去的字节原样回吐,与真终端的回显一致。
 */
async function withTerminal<T>(
  run: (h: TerminalHarness) => Promise<T>,
  options: { echo?: boolean; devicePatch?: Partial<SshDevice> } = {},
): Promise<T> {
  let shellChannel: ServerChannel | null = null;
  const inputs: string[] = [];
  const server = await startFakeSshServer({
    password: PASSWORD,
    fsSeed: { "/srv/app": true },
    onExec: (record, channel) => {
      if (record.command === SHELL_PROBE_COMMAND) {
        channel.write("/usr/bin/bash\n");
        channel.exit(0);
        channel.close();
        return;
      }
      shellChannel = channel;
      channel.write("$ ");
      channel.on("data", (chunk: Buffer) => {
        inputs.push(chunk.toString("utf8"));
        if (options.echo) channel.write(chunk);
      });
    },
  });
  const device: SshDevice = {
    ...fixtureDevice({ dirs: [APP], ...options.devicePatch }, server.port),
    hostKey: trustedHostKey(server),
  };
  const previousDevices = state.settings.sshDevices;
  state.settings = { ...state.settings, sshDevices: [device] };
  const socket = new FakeSocket();
  try {
    return await run({
      server,
      socket,
      shell: () => {
        if (!shellChannel) throw new Error("终端还没打开");
        return shellChannel;
      },
      inputs,
    });
  } finally {
    disposeTerminalSession(socket);
    sshPool.close(device.id);
    state.settings = { ...state.settings, sshDevices: previousDevices ?? [] };
    await server.close();
  }
}

function send(socket: FakeSocket, frame: Record<string, unknown>): void {
  handleTerminalFrame(socket, JSON.stringify(frame));
}

/** 打开终端的默认帧:用例只改自己关心的那个字段。 */
function startFrame(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "start", deviceId: "dev", dirId: "app", cols: 80, rows: 24, ...patch };
}

/** 等到屏幕上有指定内容:终端是事件驱动的,同步读计数只会读到还没发出去的包。 */
async function waitForText(socket: FakeSocket, needle: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!socket.text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`等不到终端输出里的 ${JSON.stringify(needle)},已收到 ${JSON.stringify(socket.text)}`);
    await delay(10);
  }
}

/** 连上并等到首个提示符:之后 handle 已经在会话手里,resize/input 才有接收方。 */
async function openTerminal(socket: FakeSocket, patch: Record<string, unknown> = {}): Promise<void> {
  send(socket, startFrame(patch));
  await waitForText(socket, "$ ");
}

describe("打开终端", () => {
  test("握手前先写状态行,PTY 落在授权目录里", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame({ cols: 120, rows: 30 }));
      // 安卓端 initializeEmulator 打印 describeStart:还没连上就得有这一行,界面不会看着空白转圈。
      expect(socket.text).toBe(`[Connecting to tester@127.0.0.1:${server.port}...]\r\n`);
      await waitForText(socket, "$ ");

      // 探测 shell 与实际终端是两条 exec;终端是「带 PTY 的 exec」,不是 SSH 的 shell 请求。
      expect(server.execs.map((item) => item.command)).toEqual([
        SHELL_PROBE_COMMAND,
        buildShellCommand("/usr/bin/bash", "/srv/app"),
      ]);
      expect(server.shells).toBe(0);
      // PseudoTtyInfo 还带 width/height(我们发的是 0),按字段断言免得被无关字段绊住。
      expect(server.ptys[0]?.term).toBe(TERMINAL_TYPE);
      expect(server.ptys[0]?.cols).toBe(120);
      expect(server.ptys[0]?.rows).toBe(30);
      expect(server.connections).toBe(1);
    });
  });

  test("目录没登记:一条 TCP 都不发,换对了还能再来", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame({ dirId: "nope" }));
      const failure = socket.last("error");
      expect(failure.code).toBe(403);
      expect(failure.errorCode).toBe("ssh.dir_unauthorized");
      // 授权不成立时连状态行都不该有:那时我们连「要连哪台」都没确认。
      expect(socket.ofType("output")).toEqual([]);
      expect(server.connections).toBe(0);

      // 失败的 start 不该把这条 WebSocket 记成「已有终端」,否则改对目录再点连接只会拿到 terminal_busy。
      send(socket, startFrame());
      await waitForText(socket, "$ ");
      expect(server.connections).toBe(1);
    });
  });

  test("设备不在 settings 里:404 + ssh.device_not_found", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame({ deviceId: "ghost" }));
      const failure = socket.last("error");
      expect(failure.code).toBe(404);
      expect(failure.errorCode).toBe("ssh.device_not_found");
      expect(server.connections).toBe(0);
    });
  });

  test("认证被拒:错误帧回 502,载荷里不含密码", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame());
      const failure = await (async (): Promise<Record<string, unknown>> => {
        const deadline = Date.now() + 3000;
        while (socket.ofType("error").length === 0) {
          if (Date.now() > deadline) throw new Error("认证失败没回错误帧");
          await delay(10);
        }
        return socket.last("error");
      })();
      expect(failure.code).toBe(502);
      expect(String(failure.error)).not.toContain("wrong-password");
      // 连不上的终端把 socket 一起关掉:前端不需要自己判断「错误帧之后还要不要发按键」。
      expect(socket.closedCount).toBe(1);
      expect(server.connections).toBe(1);
    }, { devicePatch: { password: "wrong-password" } });
  });

  test("重复 start 只有一台终端:回 ssh.terminal_busy", async () => {
    await withTerminal(async ({ server, socket }) => {
      await openTerminal(socket);
      send(socket, startFrame({ cols: 100 }));
      const failure = socket.last("error");
      expect(failure.errorCode).toBe("ssh.terminal_busy");
      // 第二条终端没有开出去:PT 申请还是一次,握手也还是一次。
      expect(server.ptys).toHaveLength(1);
      expect(server.connections).toBe(1);
    });
  });
});

describe("按键、尺寸与状态行", () => {
  test("连上之前的按键丢掉,连上之后的原样进 shell", async () => {
    await withTerminal(async ({ server, socket, inputs }) => {
      send(socket, startFrame());
      send(socket, { type: "input", data: "early\r" });
      await waitForText(socket, "$ ");
      // 安卓端的读取线程在 transport 没 start 时同样丢弃:排队会把上一次会话的按键补发给新的 shell。
      expect(inputs).toEqual([]);
      expect(socket.text).not.toContain("early");

      send(socket, { type: "input", data: "ls\r" });
      await waitForText(socket, "ls");
      expect(inputs.join("")).toBe("ls\r");
      expect(server.connections).toBe(1);
    }, { echo: true });
  });

  test("resize 只在连上之后发,尺寸按上限夹住", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame());
      send(socket, { type: "resize", cols: 999999, rows: 5000 });
      await waitForText(socket, "$ ");
      expect(server.windowChanges).toEqual([]);

      send(socket, { type: "resize", cols: 100, rows: 40 });
      const deadline = Date.now() + 3000;
      while (server.windowChanges.length === 0) {
        if (Date.now() > deadline) throw new Error("没收到 window-change");
        await delay(10);
      }
      expect(server.windowChanges).toEqual([{ rows: 40, cols: 100 }]);

      // 浏览器给什么就发什么会造出荒谬的窗口(sshd 按尺寸分配行缓冲),所以按 MAX_* 夹。
      send(socket, { type: "resize", cols: 999999, rows: 5000 });
      await delay(60);
      expect(server.windowChanges[1]).toEqual({ rows: MAX_ROWS, cols: MAX_COLS });
    });
  });

  test("远端 shell 退出:状态行、exit 帧、关 socket 三步齐全", async () => {
    await withTerminal(async ({ socket, shell }) => {
      await openTerminal(socket);
      shell().exit(3);
      shell().close();
      await waitForText(socket, "Process completed (code 3) - press Enter");
      // 安卓端连排版一起照抄:状态行是缓冲区里的一行字,不是弹窗。
      expect(socket.text.endsWith("\r\n[Process completed (code 3) - press Enter]")).toBe(true);
      expect(socket.last("exit")).toEqual({ type: "exit", code: 3, connectionLost: false });
      expect(socket.closedCount).toBe(1);
    });
  });

  test("前端点关闭:回 Session closed,不带退出码", async () => {
    await withTerminal(async ({ socket }) => {
      await openTerminal(socket);
      send(socket, { type: "close" });
      await waitForText(socket, "[Session closed]");
      // 本地挂断拿到的退出码不可信(远端 shell 是被 PTY 挂断带走的),与安卓端同一取向。
      expect(socket.last("exit")).toEqual({ type: "exit", code: null, connectionLost: false });
      expect(socket.closedCount).toBe(1);
      // 关掉之后再按键不报错,也不会有新帧。
      const frames = socket.frames.length;
      send(socket, { type: "input", data: "echo\r" });
      expect(socket.frames).toHaveLength(frames);
      expect(socket.text).not.toContain("echo");
    });
  });

  test("连接途中就被关掉:Terminal closed,不把终端交给已经不存在的页面", async () => {
    await withTerminal(async ({ server, socket }) => {
      send(socket, startFrame());
      send(socket, { type: "close" });
      await waitForText(socket, "[Terminal closed]");
      expect(socket.last("exit")).toEqual({ type: "exit", code: null, connectionLost: false });
      expect(socket.closedCount).toBe(1);
      // 连接照样开出去过(取消发生在握手之前,我们无从知道),但终端立刻被收掉。
      expect(server.connections).toBe(1);
    });
  });

  test("WebSocket 没了:会话收掉,之后的帧不再产生任何输出", async () => {
    await withTerminal(async ({ socket }) => {
      await openTerminal(socket);
      disposeTerminalSession(socket);
      const frames = socket.frames.length;
      send(socket, { type: "input", data: "ls\r" });
      send(socket, { type: "resize", cols: 90, rows: 30 });
      await delay(60);
      expect(socket.frames).toHaveLength(frames);
      // dispose 之后再 start 允许重来一条:旧的登记已经跟着 WebSocket 一起没了。
      send(socket, startFrame());
      await waitForText(socket, "$ ");
      expect(socket.frames).toHaveLength(frames + 1);
    });
  });
});

describe("帧的鲁棒性", () => {
  test("坏 JSON、缺字段、没头没尾的帧一律静默丢弃", async () => {
    await withTerminal(async ({ server, socket }) => {
      handleTerminalFrame(socket, "not json at all");
      handleTerminalFrame(socket, "");
      handleTerminalFrame(socket, "[1,2,3]");
      handleTerminalFrame(socket, JSON.stringify({ type: 42 }));
      handleTerminalFrame(socket, JSON.stringify({ type: "input", data: "ls\r" }));
      handleTerminalFrame(socket, JSON.stringify({ type: "resize" }));
      await delay(60);
      expect(socket.frames).toEqual([]);
      expect(server.connections).toBe(0);
    });
  });

  test("状态行三支:退出码、掉线、本地关闭各有各的措辞", () => {
    expect(describeTerminalExit(0, false)).toBe("Process completed - press Enter");
    expect(describeTerminalExit(7, false)).toBe("Process completed (code 7) - press Enter");
    expect(describeTerminalExit(-9, false)).toBe("Process completed (signal 9) - press Enter");
    expect(describeTerminalExit(null, true)).toBe("Connection lost");
    expect(describeTerminalExit(null, false)).toBe("Session closed");
  });
});

describe("背压", () => {
  test("前端读不过来就暂停输出,缓冲回落再放开", async () => {
    await withTerminal(async ({ socket, shell }) => {
      await openTerminal(socket);
      // 连上之后才把水位顶到暂停线以上:下一条到达的输出在发出帧之后就把 channel 的读侧压住。
      socket.buffered = 2 * 1024 * 1024;
      shell().write("first\r\n");
      await waitForText(socket, "first");

      // 暂停期间到达的内容不该往前端送:远端继续写,字节堆在本地可读缓冲里。
      // 第二笔写在 waitForText 之后,必定落在 pauseOutput 生效之后(否则会和第一笔并成同一个包)。
      shell().write("held-back\r\n");
      // 160ms 跨过两轮回落检查,缓冲量仍是 2MB,所以还不该放开。
      await delay(160);
      expect(socket.text).not.toContain("held-back");

      // 缓冲排空后由回落检查放开:没有这个定时器,远端安静下来时终端就永远冻在这里。
      socket.buffered = 0;
      await waitForText(socket, "held-back");
    });
  });
});
