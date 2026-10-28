// ssh/connection.test.ts — 连接层对真实 SSH 服务器的行为契约(回环假服务器,见 test-utils/fake-ssh-server.ts)。
//
// 这一层要验的不是「我们以为 ssh2 会怎样」,而是它实际怎样:hostVerifier 拿到的 blob、
// 未信任时凭据到底有没有发出去、keyboard-interactive 的真实请求顺序、exec 外壳的字节原文、
// 超时/取消/超限的行为。所以只在本地起服务器,绝不 mock ssh2。

import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { utils } from "ssh2";
import type { FakeSshExecRecord } from "../test-utils/fake-ssh-server";
import {
  TEST_PASSWORD as PASSWORD,
  fixtureDevice as device,
  trustedHostKey as trustedFrom,
  withFakeServer as withServer,
} from "../test-utils/ssh-fixtures";
import { SshConnection } from "./connection";
import { buildExecCommand, SHELL_PROBE_COMMAND } from "./command-wrap";
import { MAX_OUTPUT_CHARS } from "./constants";
import { encodeHostKey, fingerprintOf } from "./host-key";
import {
  SshAbortedError,
  SshHostKeyChangedError,
  SshHostKeyUnknownError,
  SshInputError,
  SshTransportError,
} from "./errors";

describe("主机密钥在认证前核对", () => {
  test("未信任:拒绝并带回服务器出示的密钥,凭据一个字节都没发出", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      let caught: unknown = null;
      try {
        await SshConnection.connect(device({}, server.port));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SshHostKeyUnknownError);
      const presented = (caught as SshHostKeyUnknownError).presented;
      expect(presented.key).toBe(server.hostKeyBase64);
      expect(presented.type).toBe(server.hostKeyType);
      // 关键:认证阶段从未开始——服务器一个认证方法都没收到。
      expect(server.authMethods).toEqual([]);
      expect(server.authenticated).toBe(0);
    });
  });

  test("指纹与 ssh2 自己导出的公钥 blob 对得上(不是我们自说自话)", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      const trusted = trustedFrom(server)!;
      // 独立算法:直接对 ssh2 parseKey().getPublicSSH() 的原始 blob 取 sha256。
      const expected = `SHA256:${createHash("sha256")
        .update(Buffer.from(server.hostKeyBase64, "base64"))
        .digest("base64")
        .replace(/=+$/, "")}`;
      expect(trusted.fingerprint).toBe(expected);
      expect(fingerprintOf(server.hostKeyBase64)).toBe(expected);

      const connection = await SshConnection.connect(device({ hostKey: trusted }, server.port));
      expect(connection.isConnected).toBe(true);
      expect(connection.hostKey.key).toBe(server.hostKeyBase64);
      expect(server.authenticated).toBe(1);
      expect(server.authMethods).toContain("password");
      connection.close();
    });
  });

  test("密钥变更:报出期望与实际,同样不发凭据", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      // 另一把完全不同的密钥当作「已信任」:典型的服务器重装/中间人场景。
      const other = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      });
      const otherBlob = (utils.parseKey(other.privateKey) as unknown as { getPublicSSH(): Buffer }).getPublicSSH();
      const stale = encodeHostKey(otherBlob)!;

      let caught: unknown = null;
      try {
        await SshConnection.connect(device({ hostKey: stale }, server.port));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SshHostKeyChangedError);
      const changed = caught as SshHostKeyChangedError;
      expect(changed.expected.key).toBe(stale.key);
      expect(changed.presented.key).toBe(server.hostKeyBase64);
      expect(changed.message).toContain("changed");
      expect(server.authMethods).toEqual([]);
    });
  });
});

describe("认证方式与安卓端对齐", () => {
  test("密码认证:服务器只认 keyboard-interactive 也要能连上(rdp 旧版连不上某些服务器的真因)", async () => {
    await withServer({ keyboardAnswer: PASSWORD }, async (server) => {
      // 服务器端不接 password 方法,只在 keyboard-interactive 提示里给答案。
      const connection = await SshConnection.connect({
        ...device({ password: PASSWORD }, server.port),
        hostKey: trustedFrom(server),
      });
      expect(connection.isConnected).toBe(true);
      // 与安卓端同一个顺序:先 password,被拒才降到 keyboard-interactive。
      expect(server.authMethods).toEqual(["password", "keyboard-interactive"]);
      expect(server.prompts).toBe(1);
      connection.close();
    });
  });

  test("口令错误:传输层失败,文案只有地址不含密码", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      let caught: unknown = null;
      try {
        await SshConnection.connect({
          ...device({ password: "wrong" }, server.port),
          hostKey: trustedFrom(server),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SshTransportError);
      const message = (caught as Error).message;
      expect(message).toContain("127.0.0.1");
      expect(message).not.toContain("wrong");
      expect(message).not.toContain(PASSWORD);
    });
  });

  test("私钥认证:publickey 被接受", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const parsed = utils.parseKey(privateKey) as unknown as { getPublicSSH(): Buffer; type: string };
    const publicLine = `${parsed.type} ${Buffer.from(parsed.getPublicSSH()).toString("base64")}`;
    await withServer({ authorizedPublicKey: publicLine }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({ authType: "key", privateKey, password: "" }, server.port),
        hostKey: trustedFrom(server),
      });
      expect(connection.isConnected).toBe(true);
      expect(server.authMethods).toContain("publickey");
      connection.close();
    });
  });

  test("缺凭据在建连前就拒绝:连一条 TCP 都不发", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      let caught: unknown = null;
      try {
        await SshConnection.connect({ ...device({ password: "" }, server.port), hostKey: trustedFrom(server) });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SshInputError);
      expect((caught as SshInputError).errorCode).toBe("ssh.missing_password");
      expect(server.connections).toBe(0);
    });
  });
});

describe("exec 的安卓端纪律", () => {
  /** 记录命令原文并按命令内容给回应:探测 shell 时回两个绝对路径,其余回固定文本。 */
  const shellAware = (record: FakeSshExecRecord, channel: import("ssh2").ServerChannel) => {
    if (record.command === SHELL_PROBE_COMMAND) {
      channel.write("/usr/local/bin/bash\n/bin/bash\n");
    } else {
      channel.write("hello\n");
      channel.stderr.write("oops\n");
    }
    channel.exit(0);
    channel.close();
  };

  test("给了 cwd 就套登录 shell 外壳,命令原文与安卓端逐字节一致", async () => {
    await withServer({ onExec: shellAware, password: PASSWORD }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const result = await connection.exec("ls -la '/tmp/a b'", { cwd: "/srv/app" });
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("oops\n");
      expect(result.code).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.timedOut).toBe(false);

      // 第一条是 shell 探测,第二条才是带外壳的业务命令。
      const business = server.execs[1]!;
      expect(business.command).toBe(buildExecCommand("/bin/bash", "/srv/app", "ls -la '/tmp/a b'"));
      // 每个 token 都单独引用(安卓端 joinToString { shellQuote() } 的同款形状,不是只引路径)。
      expect(business.command).toContain(`'env' 'CI=true' 'NO_COLOR=1' 'PAGER=cat' '/bin/bash' '-l' '-c'`);
      expect(business.command).toContain(`'cd -- "$1" && eval "$2"' 'rikkahub' '/srv/app'`);
      // 单引号命令按 关引号→双引号里的单引号→开引号 规则逐字引用,绝不裸插。
      expect(business.command).toContain("'\"'\"'");
      connection.close();
    });
  });

  test("不给 cwd 时原样发送(控制台的裸命令形态),且不做 shell 探测", async () => {
    await withServer({ onExec: shellAware, password: PASSWORD }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      await connection.exec("uptime");
      expect(server.execs.map((item) => item.command)).toEqual(["uptime"]);
      connection.close();
    });
  });

  test("shell 探测按连接缓存:第二条命令不再重复探测", async () => {
    await withServer({ onExec: shellAware, password: PASSWORD }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      await connection.exec("uname", { cwd: "/tmp" });
      await connection.exec("id", { cwd: "/tmp" });
      const probes = server.execs.filter((item) => item.command === SHELL_PROBE_COMMAND);
      expect(probes).toHaveLength(1);
      expect(server.execs).toHaveLength(3);
      connection.close();
    });
  });

  test("退出码与非零码原样上报,超时只杀 channel 不杀连接", async () => {
    await withServer({
      password: PASSWORD,
      onExec: (record, channel) => {
        if (record.command === "sleepy") {
          // 永不退出:到点由客户端侧 kill。
          channel.write("partial");
          return;
        }
        if (record.command === "killed") {
          // exit-signal:没有退出码,只有信号名(客户端应报 code=null / signal=SIGTERM)。
          channel.exit("TERM", false, "bye");
          channel.close();
          return;
        }
        channel.write("bad\n");
        channel.exit(3);
        channel.close();
      },
    }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const failed = await connection.exec("nonexistent", { timeoutMs: 5_000 });
      expect(failed.code).toBe(3);
      expect(failed.stdout).toBe("bad\n");

      const signalled = await connection.exec("killed", { timeoutMs: 2_000 });
      expect(signalled.code).toBeNull();
      expect(signalled.signal).toBe("SIGTERM");

      const timedOut = await connection.exec("sleepy", { timeoutMs: 400 });
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.code).toBe(-1);
      expect(timedOut.stdout).toBe("partial");
      // 连接留着继续用——这是安卓端 commandTimeout 用例锁死的语义。
      expect(connection.isConnected).toBe(true);
      const after = await connection.exec("uptime", { timeoutMs: 2_000 });
      expect(after.code).toBe(3);
      connection.close();
    });
  });

  test("单流超过 128K 字符截断,但仍然读完(远端不会堵在满管道上)", async () => {
    await withServer({
      password: PASSWORD,
      onExec: (record, channel) => {
        if (record.command === "big") channel.write("x".repeat(MAX_OUTPUT_CHARS + 8_192));
        channel.exit(0);
        channel.close();
      },
    }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const result = await connection.exec("big", { timeoutMs: 10_000 });
      expect(result.stdout).toHaveLength(MAX_OUTPUT_CHARS);
      expect(result.truncated).toBe(true);
      expect(result.timedOut).toBe(false);
      connection.close();
    });
  });

  test("取消:channel 收掉、连接留着、错误是 aborted", async () => {
    await withServer({
      password: PASSWORD,
      onExec: (_record, channel) => { channel.write("start"); },
    }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      let caught: unknown = null;
      try {
        await connection.exec("hang", { signal: controller.signal });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SshAbortedError);
      expect(connection.isConnected).toBe(true);
      connection.close();
    });
  });

  test("stdin 送得进去;不给 stdin 时立即 EOF(isatty 类工具不会挂住)", async () => {
    await withServer({
      password: PASSWORD,
      onExec: (_record, channel) => {
        let received = "";
        let answered = false;
        channel.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
        });
        // 客户端的 stdin 关闭(EOF)后回声:给了内容就有内容,没给就是空串。
        const answer = () => {
          if (answered) return;
          answered = true;
          channel.write(`got:${received}`);
          channel.exit(0);
          channel.close();
        };
        channel.on("end", answer);
        channel.on("close", answer);
      },
    }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const withStdin = await connection.exec("cat", { stdin: "payload" });
      expect(withStdin.stdout).toBe("got:payload");
      const withoutStdin = await connection.exec("cat");
      expect(withoutStdin.stdout).toBe("got:");
      connection.close();
    });
  });
});

describe("探测远端事实(安卓端 probe 四件套)", () => {
  const answering = (_record: FakeSshExecRecord, channel: import("ssh2").ServerChannel) => {
    channel.write("ok\n");
    channel.exit(0);
    channel.close();
  };

  test("主机密钥、homeDir、shell、目录存在性一起回;目录不存在只标记不报错", async () => {
    await withServer({
      password: PASSWORD,
      onExec: answering,
      remoteHome: "/home/deploy",
      fsSeed: { "/srv/app": true },
    }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const granted = await connection.probe("/srv/app");
      expect(granted.hostKey.key).toBe(server.hostKeyBase64);
      // homeDir 走 SFTP realpath("."),不是 echo $HOME——rc 文件里的 echo 污染不了它。
      expect(granted.homeDir).toBe("/home/deploy");
      // 假服务器默认把 command -v bash 答成 "ok"(没有绝对路径行)→ 兜底 /bin/sh。
      expect(granted.shell).toBe("/bin/sh");
      expect(granted.remoteDir).toBe("/srv/app");
      expect(granted.remoteDirExists).toBe(true);
      expect(granted.latencyMs).toBeGreaterThanOrEqual(0);

      const missing = await connection.probe("/srv/nope");
      expect(missing.remoteDir).toBe("/srv/nope");
      expect(missing.remoteDirExists).toBe(false);
      // 目录不存在绝不能把整次探测判失败:界面要的是「连上了,但这个目录没有」。
      connection.close();
    });
  });

  test("目录留空时只报前三项,不把半成品表单变成路径错误", async () => {
    await withServer({ password: PASSWORD, onExec: answering }, async (server) => {
      const connection = await SshConnection.connect({
        ...device({}, server.port),
        hostKey: trustedFrom(server),
      });
      const result = await connection.probe();
      expect(result.remoteDir).toBe("");
      expect(result.remoteDirExists).toBe(false);
      expect(result.homeDir).toBe("/home/tester");
      expect(result.shell).toBe("/bin/sh");
      connection.close();
    });
  });
});
