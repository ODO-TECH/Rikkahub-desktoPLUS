// ssh/workspace-tools.test.ts — 远程工作区的 AI 工具内核(read + bash)。
//
// 这一层是"模型真正碰到远端磁盘/远端 shell"的唯一通道,值得逐条钉住:
// 1) 边界是词法的、且在建连之前就拒——逃逸的路径不该先付一次网络往返再报错
//    (安卓端 SshWorkspaceBackend 的 read 同规则:授权目录外不去 realpath、不跟随符号链接)。
// 2) 送进远端的命令逐字节等于 command-wrap 的外壳:模型给的命令与远端 cwd 只能是位置参数,
//    不能被外层 shell 二次展开——这条一旦破,带空格目录的用户目录就是注入点。
// 3) 超长输出落**本地** tmp/:落盘的是给模型续读用的文本,与命令在哪台机器上跑无关。
// 4) 能力面对齐安卓端 WorkspaceCapabilities(SSH)= fileWriteTools=false:远程工作区没有
//    write/edit,历史残留调用也只能拿到一句"这里只有 read 与 bash"。
//
// 纪律:假服务器只监听 127.0.0.1,路径与内容全是测试常量;每条用例结束把设备踢出池,
// 断言里凡出现凭据即视为失败(错误文案会回灌模型,也会进请求日志)。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerChannel } from "ssh2";
import type { SshRemoteDir } from "../foundation/types/settings";
import { TEST_PASSWORD as PASSWORD, fixtureDevice, trustedHostKey, withFakeServer } from "../test-utils/ssh-fixtures";
import type { FakeSshServer, FakeSshServerOptions } from "../test-utils/fake-ssh-server";
import { DEFAULT_MAX_LINES, formatSize } from "../workspace/tools/truncate";
import { SHELL_PROBE_COMMAND, buildExecCommand } from "./command-wrap";
import { EXEC_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS } from "./constants";
import { agentTimeout } from "./client";
import { SshInputError } from "./errors";
import { sshPool } from "./pool";
import { sshDeviceLabel, type SshWorkspaceTarget } from "./workspace-binding";
import {
  buildRemoteWorkspaceTool,
  createRemoteBashTool,
  createRemoteReadTool,
  REMOTE_WORKSPACE_TOOL_NAMES,
} from "./workspace-tools";

const ROOT = "/srv/app";
const APP_DIR: SshRemoteDir = { id: "app", name: "应用目录", path: ROOT };

/** 超长输出落盘目录(测试专用,不碰应用数据目录)。 */
const TMP = mkdtempSync(join(tmpdir(), "rkh-tools-test-"));

function targetFor(server: FakeSshServer, root = ROOT): SshWorkspaceTarget {
  const device = { ...fixtureDevice({ dirs: [APP_DIR] }, server.port), hostKey: trustedHostKey(server) };
  return { device, dir: APP_DIR, root, label: sshDeviceLabel(device) };
}

/** 不建连也能构造的 target:纯配置对象,用于断言工具面与 schema。 */
function localTarget(root = ROOT): SshWorkspaceTarget {
  const device = fixtureDevice({ dirs: [APP_DIR] });
  return { device, dir: APP_DIR, root, label: sshDeviceLabel(device) };
}

/** 文本工具的输出合成一条串(图片项没有 text,按空串跳过)。 */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

/** 断言"这一步就是拒了",并把错误对象交出来比对文案与 errorCode。 */
async function expectRejected(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("预期抛错,但调用成功了");
}

/**
 * 探测应答:shell 探针回 /bin/bash(于是外壳里的 shell 路径是确定的),其余命令原样回显
 * 到 stdout 并退出 0——bash 用例要断言"远端收到的到底是哪串字节",回显是最直接的证据。
 */
function echoShell(record: { command: string }, channel: ServerChannel): void {
  if (record.command === SHELL_PROBE_COMMAND) channel.write("/bin/bash\n");
  else channel.write(record.command);
  channel.exit(0);
  channel.close();
}

async function withEcho<T>(run: (server: FakeSshServer) => Promise<T>): Promise<T> {
  return withFakeServer({ password: PASSWORD, onExec: echoShell }, run);
}

/** 需要远端文件系统种子的用例。 */
async function withSeededFs<T>(seed: NonNullable<FakeSshServerOptions["fsSeed"]>, run: (server: FakeSshServer) => Promise<T>): Promise<T> {
  return withFakeServer({ password: PASSWORD, fsSeed: { [ROOT]: true, ...seed }, onExec: echoShell }, run);
}

afterEach(() => {
  // 进程级单例:上一轮的连接会连着上一轮那台已经关掉的假服务器(用 close 而不是 closeAll,
  // 后者是给进程退出的,会把单例永久关掉)。
  sshPool.close("dev");
});

describe("远程工作区的工具面", () => {
  test("只有 read 与 bash(安卓端 fileWriteTools=false)", () => {
    expect([...REMOTE_WORKSPACE_TOOL_NAMES]).toEqual(["read", "bash"]);
  });

  test("write/edit 的名字进来只能拿到一句「这里只有 read 与 bash」", () => {
    const target = localTarget();
    for (const name of ["write", "edit", "grep", "find", "ls"]) {
      expect(() => buildRemoteWorkspaceTool(name, target, ROOT)).toThrow(
        new RegExp(`Tool '${name}' is not available in an SSH workspace[\\s\\S]*only provide read and bash`),
      );
    }
  });

  test("read 的 schema 与描述和本地内核同形(模型与前端渲染无感)", () => {
    const tool = createRemoteReadTool(localTarget(), ROOT);
    expect(tool.name).toBe("read");
    expect((tool.parameters as { required: string[] }).required).toEqual(["path"]);
    expect(tool.description).toContain("Read the contents of a file");
    expect(tool.description).toContain(`${DEFAULT_MAX_LINES} lines`);
    expect(tool.description).not.toContain(PASSWORD);
  });
});

describe("read 的边界:授权目录就是边界", () => {
  test("区内绝对路径与相对 cwd 的路径都读到内容,相对路径按 cwd 解析", async () => {
    await withSeededFs(
      { "/srv/app/notes.md": "根目录的那份\n", "/srv/app/sub/notes.md": "子目录的那份\n" },
      async (server) => {
        const absolute = await createRemoteReadTool(targetFor(server), ROOT).execute({ path: "/srv/app/notes.md" });
        expect(textOf(absolute)).toContain("根目录的那份");
        // 同一个相对名字在两个 cwd 下指向两个文件——与本地工具"relative or absolute"的同一心智。
        const fromRoot = await createRemoteReadTool(targetFor(server), ROOT).execute({ path: "notes.md" });
        expect(textOf(fromRoot)).toContain("根目录的那份");
        const fromSub = await createRemoteReadTool(targetFor(server), `${ROOT}/sub`).execute({ path: "notes.md" });
        expect(textOf(fromSub)).toContain("子目录的那份");
      },
    );
  });

  test("越界在读之前就拒:一条 TCP 都不发", async () => {
    await withSeededFs({ "/srv/app/notes.md": "x\n" }, async (server) => {
      const target = targetFor(server);
      const tool = createRemoteReadTool(target, ROOT);
      for (const path of ["../etc/passwd", "/etc/passwd", `${ROOT}/../secrets.txt`, `${ROOT}/../../x`]) {
        const error = await expectRejected(() => tool.execute({ path }));
        expect(error).toBeInstanceOf(SshInputError);
        expect((error as SshInputError).errorCode).toBe("ssh.path_escape");
      }
      expect(server.connections).toBe(0);
    });
  });

  test("`~` 明确拒绝:静默改写成工作区根会让模型读错文件", async () => {
    await withSeededFs({ "/srv/app/notes.md": "x\n" }, async (server) => {
      const tool = createRemoteReadTool(targetFor(server), ROOT);
      const error = await expectRejected(() => tool.execute({ path: "~/.ssh/id_rsa" }));
      expect((error as SshInputError).errorCode).toBe("ssh.path_invalid");
      expect(error.message).toContain("~ is not expanded");
      expect(error.message).toContain(ROOT);
      // 空路径同样当场拒,而不是拿去拼一个 "/srv/app/" 读目录。
      expect((await expectRejected(() => tool.execute({ path: "   " })) as SshInputError).errorCode).toBe("ssh.path_missing");
    });
  });

  test("不存在与不是文件各自报错(安卓端 requireFile 的两种文案)", async () => {
    await withSeededFs({ "/srv/app/notes.md": "x\n" }, async (server) => {
      const tool = createRemoteReadTool(targetFor(server), ROOT);
      const missing = await expectRejected(() => tool.execute({ path: "gone.md" }));
      expect(missing.message).toContain("File does not exist");
      const notAFile = await expectRejected(() => tool.execute({ path: "." }));
      expect(notAFile.message).toContain("not a file");
      expect((notAFile as SshInputError).errorCode).toBe("ssh.not_a_file");
    });
  });

  test("8MB 闸门在 stat 之后、读之前生效(不把大文件整份吸过来)", async () => {
    await withSeededFs({ "/srv/app/big.log": "x\n" }, async (server) => {
      server.fs.write("/srv/app/big.log", Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
      const error = await expectRejected(() => createRemoteReadTool(targetFor(server), ROOT).execute({ path: "big.log" }));
      expect((error as SshInputError).errorCode).toBe("ssh.file_too_large");
      expect(error.message).toContain("too large");
      // 只 stat 过,没开过句柄:闸门真的挡在读取前面。
      expect(server.fs.ops.some((op) => op.startsWith(`open:/srv/app/big.log`))).toBe(false);
    });
  });

  test("截断与续读文案和本地内核同一套", async () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `line ${index + 1}`);
    await withSeededFs({ "/srv/app/long.txt": `${lines.join("\n")}\n` }, async (server) => {
      const tool = createRemoteReadTool(targetFor(server), ROOT);
      const first = textOf(await tool.execute({ path: "long.txt" }));
      expect(first).toContain("line 1\n");
      expect(first).toContain(`[Showing lines 1-${DEFAULT_MAX_LINES} of`);
      expect(first).toContain(`Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`);
      const tail = textOf(await tool.execute({ path: "long.txt", offset: DEFAULT_MAX_LINES + 1 }));
      expect(tail).toContain(`line ${DEFAULT_MAX_LINES + 1}`);
      // limit 只给一部分时,提示还有多少行没看(与本地内核同一句)。
      expect(textOf(await tool.execute({ path: "long.txt", limit: 2 }))).toMatch(/more lines in file\. Use offset=3/);
      // offset 越过文件尾:报错而不是回空串骗模型"文件是空的"。
      expect((await expectRejected(() => tool.execute({ path: "long.txt", offset: 99_999 }))).message).toContain("beyond end of file");
    });
  });

  test("单行超长给出可直接照抄的 bash 续读建议(含 50KB 上限)", async () => {
    await withSeededFs({ "/srv/app/one-liner.txt": `${"y".repeat(60 * 1024)}\n` }, async (server) => {
      const text = textOf(await createRemoteReadTool(targetFor(server), ROOT).execute({ path: "one-liner.txt" }));
      expect(text).toContain("exceeds");
      expect(text).toContain(formatSize(50 * 1024));
      expect(text).toContain("sed -n '1p'");
    });
  });
});

describe("bash 的执行手在远端,落盘在本地", () => {
  test("远端收到的命令逐字节等于外壳:带空格与引号的 cwd 与命令都不被二次展开", async () => {
    await withEcho(async (server) => {
      const cwd = "/srv/app/our dir";
      const command = "echo 'it works' && echo $HOME";
      const tool = createRemoteBashTool(targetFor(server), cwd, { tempFileDir: TMP });
      const result = await tool.execute({ command });
      // 内核对非零退出与输出文本的处理不变,这里回显的就是远端实际收到的字符串。
      expect(textOf(result)).toBe(buildExecCommand("/bin/bash", cwd, command));
      expect(textOf(result)).toContain(`'${cwd}'`);
      expect(textOf(result)).toContain("cd -- \"$1\" && eval \"$2\"");
      // 凭据绝不进命令串(它进远端进程列表,也进本地日志)。
      expect(textOf(result)).not.toContain(PASSWORD);
    });
  });

  test("非零退出报 Command exited with code N,已产出的输出仍然回给模型", async () => {
    await withFakeServer({ password: PASSWORD, onExec: (record, channel) => {
      if (record.command === SHELL_PROBE_COMMAND) channel.write("/bin/bash\n");
      else channel.write("partial output");
      channel.exit(record.command === SHELL_PROBE_COMMAND ? 0 : 3);
      channel.close();
    } }, async (server) => {
      const error = await expectRejected(() =>
        createRemoteBashTool(targetFor(server), ROOT, { tempFileDir: TMP }).execute({ command: "false" }),
      );
      expect(error.message).toContain("partial output");
      expect(error.message).toContain("Command exited with code 3");
    });
  });

  test("超长输出落本地 tmp,远端文件系统里不多出东西", async () => {
    // 这台假服务器真的"产出" 3000 行(回显型服务器只会把命令串本身写回来,量不够触发截断)。
    const noisy: FakeSshServerOptions = {
      password: PASSWORD,
      fsSeed: { [ROOT]: true },
      onExec: (record, channel) => {
        if (record.command === SHELL_PROBE_COMMAND) {
          channel.write("/bin/bash\n");
        } else {
          channel.write(Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n"));
        }
        channel.exit(0);
        channel.close();
      },
    };
    await withFakeServer(noisy, async (server) => {
      const before = server.fs.list(ROOT).join(",");
      const tool = createRemoteBashTool(targetFor(server), ROOT, { tempFileDir: TMP });
      const result = await tool.execute({ command: "yes line | head -3000" });
      const fullPath = String((result.details as { fullOutputPath?: string }).fullOutputPath ?? "");
      expect(fullPath.startsWith(TMP)).toBe(true);
      expect(existsSync(fullPath)).toBe(true);
      expect(readFileSync(fullPath, "utf8").split("\n").filter(Boolean).length).toBe(3000);
      // 回给模型的只是最后一窗 + 一句"完整输出在…"的路径。
      expect(textOf(result)).toContain("Full output:");
      expect(textOf(result)).not.toContain("line 0\n");
      // 远端一个文件都没多:落盘发生在读输出的一侧,不是在命令的那台机器上写文件。
      expect(server.fs.list(ROOT).join(",")).toBe(before);
      rmSync(TMP, { recursive: true, force: true });
      mkdirSync(TMP, { recursive: true });
    });
  });

  test("两条命令共用一条连接(池生效),握手只付一次", async () => {
    await withEcho(async (server) => {
      const target = targetFor(server);
      const tool = () => createRemoteBashTool(target, ROOT, { tempFileDir: TMP });
      await tool().execute({ command: "echo one" });
      await tool().execute({ command: "echo two" });
      expect(server.connections).toBe(1);
      expect(server.authenticated).toBe(1);
      // shell 探测也只在连接生命周期里做一次:三次 exec(1 次探测 + 2 次命令)。
      expect(server.execs).toHaveLength(3);
      expect(server.execs.filter((record) => record.command === SHELL_PROBE_COMMAND)).toHaveLength(1);
    });
  });

  test("取消即止:已 abort 的信号连一条连接都不发起", async () => {
    await withEcho(async (server) => {
      const controller = new AbortController();
      controller.abort();
      const error = await expectRejected(() =>
        createRemoteBashTool(targetFor(server), ROOT, { tempFileDir: TMP }).execute({ command: "echo hi" }, controller.signal),
      );
      expect(error.message).toContain("Command aborted");
      expect(server.connections).toBe(0);
    });
  });

  test("超时夹取:界面默认 30s,AI 工具的上限是安卓端那 600s", () => {
    // runtime 先把模型给的超时夹到 30min,这里再夹到 600s——两道闸的交集才是远端的实际上限。
    expect(agentTimeout(30 * 60 * 1000)).toBe(SHELL_TIMEOUT_MAX_MS);
    expect(agentTimeout(SHELL_TIMEOUT_MAX_MS)).toBe(SHELL_TIMEOUT_MAX_MS);
    expect(agentTimeout(5_000)).toBe(5_000);
    expect(EXEC_TIMEOUT_DEFAULT_MS).toBe(30_000);
    // 没给超时的远程命令不走这个 30s 默认值:workspace-tools 里显式按 SHELL_TIMEOUT_MAX_MS 跑。
    expect(SHELL_TIMEOUT_MAX_MS).toBeGreaterThan(EXEC_TIMEOUT_DEFAULT_MS);
  });

  test("远端命令挂死:按模型给的秒数报 timed out,不陪它挂到 600s", async () => {
    await withFakeServer({
      password: PASSWORD,
      onExec: (record, channel) => {
        if (record.command === SHELL_PROBE_COMMAND) {
          channel.write("/bin/bash\n");
          channel.exit(0);
          channel.close();
        }
        // 其余命令永不退出:只由超时收场。
      },
    }, async (server) => {
      const started = Date.now();
      const error = await expectRejected(() =>
        createRemoteBashTool(targetFor(server), ROOT, { tempFileDir: TMP }).execute({ command: "sleep 999", timeout: 1 }),
      );
      expect(error.message).toContain("Command timed out after 1 seconds");
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });
});
