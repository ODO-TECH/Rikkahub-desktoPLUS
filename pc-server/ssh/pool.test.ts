// ssh/pool.test.ts — 连接池的复用、回收、重连与不重放语义(对照安卓端 SshConnectionPool.kt)。
//
// 这一层的价值全在「什么时候不重新握手」:对齐前 rdp 每条命令都重连,一次交互十几次握手,
// 服务器端还会把连续密码认证当爆破。用回环假服务器的 authenticated 计数直接数握手次数,
// 比读日志可靠;重放类断言数 execs 的条数,确保「不确定有没有送到」时绝不跑第二遍。

import { describe, expect, test } from "bun:test";
import {
  delay,
  fixtureDevice,
  trustedDevice,
  withFakeServer,
} from "../test-utils/ssh-fixtures";
import { SshAbortedError, SshChannelOpenError, transportError } from "./errors";
import { buildShellCommand, SHELL_PROBE_COMMAND } from "./command-wrap";
import { TERMINAL_MODES } from "./connection";
import { SshConnectionPool } from "./pool";

/** 每个用例自建短时限的池并保证关掉:空闲扫描的 setInterval 不该漏给下一个用例。 */
async function withPool<T>(
  run: (pool: SshConnectionPool) => Promise<T>,
  idleTimeoutMs = 40,
  sweepIntervalMs = 15,
): Promise<T> {
  const pool = new SshConnectionPool(idleTimeoutMs, sweepIntervalMs);
  try {
    return await run(pool);
  } finally {
    pool.closeAll();
  }
}

describe("按设备复用连接", () => {
  test("三条命令一次握手;close(deviceId) 之后才重连", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        for (const command of ["uname", "id", "uptime"]) {
          const result = await pool.use(device, (connection) => connection.exec(command));
          expect(result.code).toBe(0);
        }
        expect(server.authenticated).toBe(1);
        expect(server.connections).toBe(1);
        expect(server.execs.map((item) => item.command)).toEqual(["uname", "id", "uptime"]);
        expect(pool.isConnected(device.id)).toBe(true);

        pool.close(device.id);
        expect(pool.isConnected(device.id)).toBe(false);
        await pool.use(device, (connection) => connection.exec("hostname"));
        expect(server.authenticated).toBe(2);
      });
    });
  });

  test("空闲到点自动断开,下次再用才重连(回收不产生握手)", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        await pool.use(device, (connection) => connection.exec("uname"));
        expect(pool.connectedDevices()).toEqual([device.id]);
        // 空闲时限 40ms + 扫描 15ms:等一等到点,连接应已被拆掉。
        await delay(200);
        expect(pool.isConnected(device.id)).toBe(false);
        expect(pool.connectedDevices()).toEqual([]);
        expect(server.connections).toBe(1);

        await pool.use(device, (connection) => connection.exec("uname"));
        expect(server.connections).toBe(2);
      });
    });
  });

  test("只有连接要素变化才重连:改名与加目录复用原连接,改密码/端口/密钥重连", async () => {
    await withFakeServer({ acceptAnyPassword: true }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        await pool.use(device, (connection) => connection.exec("one"));
        expect(server.authenticated).toBe(1);

        // 名称与授权目录属于界面数据,不参与连接指纹。
        await pool.use({ ...device, name: "换个名字", dirs: [{ id: "d1", name: "应用", path: "/srv/app" }] },
          (connection) => connection.exec("two"));
        expect(server.authenticated).toBe(1);

        // 凭据变了必须重连:旧连接是用另一份密码认证出来的,留着就是拿错身份跑命令。
        await pool.use({ ...device, password: "another-password" }, (connection) => connection.exec("three"));
        expect(server.authenticated).toBe(2);

        // 取消信任主机密钥同样算变化。
        await pool.use({ ...device, hostKey: null }, (connection) => connection.exec("four")).catch(() => undefined);
        expect(server.connections).toBe(3);
      });
    });
  });

  test("并发使用同一设备只建一条连接:建连按设备排队", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        await Promise.all([
          pool.use(device, (connection) => connection.exec("a")),
          pool.use(device, (connection) => connection.exec("b")),
          pool.use(device, (connection) => connection.exec("c")),
        ]);
        expect(server.connections).toBe(1);
        expect(server.execs).toHaveLength(3);
      });
    });
  });
});

describe("失败之后重不重连、重不重放", () => {
  test("channel 没开成:踢掉旧连接、换新的重试一次(retry:false 也重试)", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        await pool.use(device, (connection) => connection.exec("warm-up"));
        expect(server.authenticated).toBe(1);

        let attempts = 0;
        const connections: unknown[] = [];
        const result = await pool.use(
          device,
          async (connection) => {
            attempts += 1;
            connections.push(connection);
            if (attempts === 1) throw new SshChannelOpenError("channel is not opened.");
            return connection.exec("after-reconnect");
          },
          { retry: false },
        );
        expect(attempts).toBe(2);
        expect(result.code).toBe(0);
        // 重试发生在另一条连接上,旧连接已被踢出池。
        expect(connections[0]).not.toBe(connections[1]);
        expect(server.authenticated).toBe(2);
        // 远端只跑了 warm-up 与 after-reconnect:第一次是「没送到」,不算重放。
        expect(server.execs.map((item) => item.command)).toEqual(["warm-up", "after-reconnect"]);
      });
    });
  });

  test("连接仍在线的失败绝不重放:命令只跑到远端一次", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        for (const retry of [true, false]) {
          let attempts = 0;
          await expect(
            pool.use(device, async () => {
              attempts += 1;
              throw transportError("remote command failed: exit 1");
            }, { retry }),
          ).rejects.toThrow("exit 1");
          expect(attempts).toBe(1);
        }
        // 一次握手,零条远端命令(block 里根本没 exec)。
        expect(server.authenticated).toBe(1);
        expect(server.execs).toEqual([]);
      });
    });
  });

  test("调用方取消:错误原样抛出,不重连也不重试", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        let attempts = 0;
        await expect(
          pool.use(device, async () => {
            attempts += 1;
            throw new SshAbortedError();
          }),
        ).rejects.toBeInstanceOf(SshAbortedError);
        expect(attempts).toBe(1);
        expect(server.authenticated).toBe(1);
      });
    });
  });

  test("排队前就已取消:一条 TCP 都不发", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const controller = new AbortController();
        controller.abort();
        await expect(
          pool.use(trustedDevice(server), (connection) => connection.exec("never"), { signal: controller.signal }),
        ).rejects.toBeInstanceOf(SshAbortedError);
        expect(server.connections).toBe(0);
      });
    });
  });

  test("掉线由 socket 状态判定:断开后下一次 use 直接重连,不需要 block 报错", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        await pool.use(device, (connection) => connection.exec("before-drop"));
        expect(pool.isConnected(device.id)).toBe(true);

        server.dropConnections();
        await delay(50);
        expect(pool.isConnected(device.id)).toBe(false);

        const after = await pool.use(device, (connection) => connection.exec("after-drop"));
        expect(after.code).toBe(0);
        expect(server.connections).toBe(2);
        expect(server.execs.map((item) => item.command)).toEqual(["before-drop", "after-drop"]);
      });
    });
  });
});

describe("终端与探测对连接池的影响", () => {
  test("终端挂着的连接不被空闲回收;关掉之后照常回收", async () => {
    await withFakeServer({
      password: "test-password",
      onExec: (record, channel) => {
        if (record.command === SHELL_PROBE_COMMAND) {
          channel.write("/usr/bin/bash\n");
          channel.exit(0);
          channel.close();
          return;
        }
        // 交互式 shell:回一行提示后挂着不退出,直到客户端关掉 channel。
        channel.write("$ ");
      },
    }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        let exitCode: number | null | undefined;
        const handle = await pool.openTerminal(device, {
          cwd: "/home/tester",
          cols: 80,
          rows: 24,
          onData: () => undefined,
          onExit: (code) => { exitCode = code; },
        });
        expect(server.ptys).toHaveLength(1);
        // 终端是「带 PTY 的 exec」而不是 SSH 的 shell 请求:安卓端 SshShell 用的就是 ChannelExec,
        // shell 计数必须保持 0,否则等于偷偷换了一种远端形态。
        expect(server.shells).toBe(0);
        // 安卓端外壳:cd 到目录后 exec 登录 shell,而不是我们替它拼命令。
        expect(server.execs[1]!.command).toBe(buildShellCommand("/usr/bin/bash", "/home/tester"));
        expect(server.ptys[0]!.term).toBe("xterm-256color");
        expect(server.ptys[0]!.cols).toBe(80);
        expect(server.ptys[0]!.rows).toBe(24);
        // IUTF8 只能按字节验:ssh2 的服务端把 modes 一律解成空对象(它的 opcode 表没有 42),
        // 真实 OpenSSH 与 JSch 都吃这六个字节,所以对齐点是客户端发出去的原文。
        expect([...TERMINAL_MODES]).toEqual([42, 0, 0, 0, 1, 0]);

        handle.resize(100, 40);
        // window-change 是一条真实的 CHANNEL_REQUEST:等它落到服务器那侧再断言,
        // 同步读计数只会读到还没发出的包。
        await delay(50);
        expect(server.windowChanges).toEqual([{ rows: 40, cols: 100 }]);

        // 空闲时限 40ms 远小于这里的等待:终端没关掉之前不许拆连接。
        await delay(250);
        expect(pool.isConnected(device.id)).toBe(true);
        expect(server.connections).toBe(1);

        handle.close();
        expect(handle.closed).toBe(true);
        // 本地关终端不报退出码:远端 shell 是被 PTY 挂断带走的,这个码不可信。
        // 安卓端同一取向——SshShell.waitFor 只在拿得到 exit-status 时回数值,被 close 掉就回 null。
        expect(exitCode).toBeNull();
        await delay(250);
        // 引用计数一放,空闲扫描就把这条连接收掉了(下一个用例得重新握手)。
        expect(pool.isConnected(device.id)).toBe(false);
      });
    });
  });

  test("远端 shell 自己退出:回真实退出码并释放连接", async () => {
    await withFakeServer({
      password: "test-password",
      onExec: (record, channel) => {
        if (record.command === SHELL_PROBE_COMMAND) {
          channel.write("/usr/bin/bash\n");
          channel.exit(0);
          channel.close();
          return;
        }
        channel.write("$ ");
        // 远端先 exit 再 close:客户端要在 close 之前把退出码读到(早到的已记在账本上)。
        channel.exit(7);
        channel.close();
      },
    }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        let exitCode: number | null | undefined;
        let lost: boolean | undefined;
        const handle = await pool.openTerminal(device, {
          cwd: "/home/tester",
          cols: 80,
          rows: 24,
          onData: () => undefined,
          onExit: (code, connectionLost) => { exitCode = code; lost = connectionLost; },
        });
        await delay(80);
        expect(exitCode).toBe(7);
        // 连接还活着:这不是掉线,界面不该显示「连接已断开」。
        expect(lost).toBe(false);
        expect(handle.closed).toBe(true);
        await delay(250);
        expect(pool.isConnected(device.id)).toBe(false);
      });
    });
  });

  test("探测用临时连接:测完就关,不把未确认过的服务器留在池里", async () => {
    await withFakeServer({ password: "test-password", remoteHome: "/home/deploy" }, async (server) => {
      await withPool(async (pool) => {
        const device = trustedDevice(server);
        const result = await pool.probe(device, "/srv/app");
        expect(result.homeDir).toBe("/home/deploy");
        expect(result.remoteDirExists).toBe(false);
        expect(pool.connectedDevices()).toEqual([]);
        expect(pool.isConnected(device.id)).toBe(false);
        expect(server.authenticated).toBe(1);
      });
    });
  });

  test("closeAll 之后池不可再用:报错而不是悄悄新建连接", async () => {
    await withFakeServer({ password: "test-password" }, async (server) => {
      const pool = new SshConnectionPool(40, 15);
      const device = fixtureDevice({}, server.port);
      pool.closeAll();
      await expect(pool.use(device, (connection) => connection.exec("late"))).rejects.toThrow(/pool is closed/);
      expect(server.connections).toBe(0);
    });
  });
});
