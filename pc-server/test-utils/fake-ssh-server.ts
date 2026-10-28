// test-utils/fake-ssh-server.ts — 本地回环假 SSH 服务器(SSH 层单测共用)。
//
// 为什么自己起服务器而不是 mock ssh2:这一层要验的正是「我们传给 ssh2 的参数它到底怎么表现」
// ——hostVerifier 拿到的 blob、authHandler/tryKeyboard 的实际请求顺序、exec 外壳的字节原文、
// channel 超时后连接是否还在。mock 会把这些全测成假绿(与安卓端用真实 sshd 容器同一取向)。
//
// 纪律:只监听 127.0.0.1,凭据是测试常量,不含任何真实主机信息。

import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Server, utils, type ExecInfo, type PseudoTtyInfo, type ServerChannel, type Session } from "ssh2";
import { FakeRemoteFs, attachFakeSftp, type FakeFsSeed } from "./fake-sftp-fs";

export interface FakeSshExecRecord {
  command: string;
  /** 该 session 上先到的 pty 请求(没有则为 null),用于验证终端确实申请了 PTY。 */
  pty: PseudoTtyInfo | null;
}

export interface FakeSshServerOptions {
  /** 默认 "tester"。 */
  username?: string;
  /** 允许密码认证时填;不填则 password 一律拒绝。 */
  password?: string | null;
  /**
   * 任何密码都接受(不看内容)。池的「配置变了就重连」用例要换一份密码再连一次,
   * 又不想让认证结果干扰断言,用它把认证和握手次数解耦。
   */
  acceptAnyPassword?: boolean;
  /**
   * 允许 keyboard-interactive(challenge-response)认证,值就是期望的答案。
   * 与 password **分开**配置:只填它就是不接 password 方法,客户端必须走 challenge-response
   * 才连得上——安卓端 PreferredAuthentications=password,keyboard-interactive 的降级路径要能单独验。
   */
  keyboardAnswer?: string;
  /** 允许 publickey 认证时填公钥原文(OpenSSH 格式)。 */
  authorizedPublicKey?: string | null;
  /**
   * exec 处理:入参是客户端送来的命令原文与通道,自行写 stdout/stderr 后 exit。
   * 缺省行为:回一行 "ok"、退出码 0。
   */
  onExec?: (record: FakeSshExecRecord, channel: ServerChannel) => void;
  /** 远端家目录(默认 /home/tester),realpath(".") 的回值。 */
  remoteHome?: string;
  /** 远端文件系统的初始内容,见 test-utils/fake-sftp-fs.ts。 */
  fsSeed?: FakeFsSeed;
}

export interface FakeSshServer {
  port: number;
  /** 服务器主机公钥的 wire blob(base64)与算法名:测试用它构造「已信任」条目。 */
  hostKeyBase64: string;
  hostKeyType: string;
  /** TCP 连接次数(每次握手一条)。 */
  connections: number;
  /** 认证通过次数——用来证明「复用连接」没有重复握手。 */
  authenticated: number;
  /** 客户端按顺序请求过的认证方法。 */
  authMethods: string[];
  /** 发出过 challenge-response 提示的次数(证明 kbd 路径真走到了)。 */
  prompts: number;
  /** 收到的 exec 命令原文,按顺序。 */
  execs: FakeSshExecRecord[];
  /** 打开过的交互式 shell 请求数。 */
  shells: number;
  /** 收到的 pty 请求(尺寸与 term);undefined 解不出来时记 null。 */
  ptys: PseudoTtyInfo[];
  /** 收到的窗口尺寸变更(终端 resize 的真实落点)。 */
  windowChanges: Array<{ rows: number; cols: number }>;
  /** 远端内存文件系统:SFTP 断言与「写入是否真落盘」的观察点。 */
  fs: FakeRemoteFs;
  /** 服务器主动断掉所有客户端连接(模拟掉线,验证池的重连判定)。 */
  dropConnections(): void;
  close(): Promise<void>;
}

export async function startFakeSshServer(options: FakeSshServerOptions = {}): Promise<FakeSshServer> {
  const username = options.username ?? "tester";
  // 2048 位 RSA 够快(几十毫秒)又是 ssh2 服务端最稳的 hostKey 形态。
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const parsed = utils.parseKey(privateKey) as unknown as { getPublicSSH(): Buffer; type: string };
  const hostKeyBase64 = parsed.getPublicSSH().toString("base64");

  const server = new Server({ hostKeys: [privateKey] });
  const remote = new FakeRemoteFs(options.remoteHome ?? "/home/tester", options.fsSeed ?? {});
  const sockets: Set<import("node:net").Socket> = new Set();
  const fake: FakeSshServer = {
    port: 0,
    hostKeyBase64,
    hostKeyType: parsed.type,
    connections: 0,
    authenticated: 0,
    authMethods: [],
    prompts: 0,
    execs: [],
    shells: 0,
    ptys: [],
    windowChanges: [],
    fs: remote,
    dropConnections() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      fake.dropConnections();
      server.close();
      await once(server, "close");
    },
  };

  server.on("connection", (client) => {
    fake.connections += 1;
    const socket = (client as unknown as { _sock?: import("node:net").Socket })._sock;
    if (socket) sockets.add(socket);
    let ptyRequested: PseudoTtyInfo | null = null;

    client.on("authentication", (ctx) => {
      fake.authMethods.push(ctx.method);
      if (ctx.username !== username) return ctx.reject();
      if (ctx.method === "password") {
        if (options.acceptAnyPassword) return ctx.accept();
        if (options.password != null && ctx.password === options.password) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === "keyboard-interactive" && options.keyboardAnswer !== undefined) {
        // challenge-response:发一个提示,答案正确才 accept(客户端侧 tryKeyboard 的真实路径)。
        // 不挂 'keyboard-interactive' 事件监听的客户端会卡在这里——ssh2 不会自动回答。
        ctx.prompt("Password: ", (responses: string[]) => {
          fake.prompts += 1;
          if (responses[0] === options.keyboardAnswer) ctx.accept();
          else ctx.reject();
        });
        return;
      }
      if (ctx.method === "publickey" && options.authorizedPublicKey && ctx.key) {
        const wanted = normalizePublicKey(options.authorizedPublicKey);
        const offered = `${ctx.key.algo} ${ctx.key.data.toString("base64")}`;
        // 无签名的第一次询问与带签名的正式认证都走这条:accept() 自己分两阶段回包。
        if (offered === wanted) return ctx.accept();
        return ctx.reject();
      }
      return ctx.reject();
    });

    client.on("ready", () => {
      fake.authenticated += 1;
      client.on("session", (accept: () => Session) => {
        const session = accept();
        attachFakeSftp(session, remote);
        session.on("pty", (acceptPty, _reject, info: PseudoTtyInfo) => {
          ptyRequested = info;
          fake.ptys.push(info);
          acceptPty();
        });
        session.on("shell", (acceptShell) => {
          fake.shells += 1;
          const channel = acceptShell();
          channel.on("data", (chunk: Buffer) => {
            // 交互式终端:原样回显,让测试能验证「写进去的字节回来了」。
            channel.write(chunk);
          });
          channel.stderr.on("data", () => { /* 忽略 */ });
        });
        // window-change 按 RFC 4254 不要回应,ssh2 客户端也确实以 wantReply=false 发出:
        // 服务端这时给下来的 accept 是 undefined,拿它当函数调会在协议解析里抛异常,
        // 整条连接直接被判成协议错误断开(resize 测试最初就是这样「连接莫名掉线」的)。
        session.on("window-change", (acceptChange: (() => void) | undefined, _reject, info) => {
          fake.windowChanges.push({ rows: info.rows, cols: info.cols });
          acceptChange?.();
        });
        session.on("exec", (acceptExec, reject, info: ExecInfo) => {
          const record: FakeSshExecRecord = { command: info.command, pty: ptyRequested };
          ptyRequested = null;
          fake.execs.push(record);
          const channel = acceptExec();
          if (options.onExec) {
            options.onExec(record, channel);
            return;
          }
          channel.write("ok\n");
          channel.exit(0);
          channel.close();
        });
        session.on("error", () => { /* 客户端没请求的 session 事件:忽略 */ });
      });
    });

    client.on("error", () => { /* 认证失败与断线都会走这里,测试从计数与错误码判断 */ });
    client.on("close", () => {
      for (const socket of sockets) {
        if ((socket as unknown as { destroyed?: boolean }).destroyed) sockets.delete(socket);
      }
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake.port = (server.address() as AddressInfo).port;
  return fake;
}

/** OpenSSH 公钥行 → "算法名 base64blob",与 ctx.key 的字段对齐比较。 */
function normalizePublicKey(line: string): string {
  const parts = line.trim().split(/\s+/);
  const type = parts[0] ?? "";
  const blob = parts[1] ?? "";
  return `${type} ${Buffer.from(blob, "base64").toString("base64")}`;
}
