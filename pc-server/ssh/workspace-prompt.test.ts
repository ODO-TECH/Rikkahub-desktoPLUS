// ssh/workspace-prompt.test.ts — 远程工作区提示词与远端环境缓存(对齐安卓端 WorkspaceReminderTransformer)。
//
// 为什么用真假服务器而不是 mock:这段提示词的内容(shell 路径、发行版名)只能从远端读出来,
// mock 掉连接层就等于"断言我自己编的回话"。test-utils/fake-ssh-server 只监听 127.0.0.1,
// 凭据全是测试常量。
//
// 三条最值钱的断言:
// 1) 探测只发生一次(成功结果长期沿用):每轮都探等于每轮多付网络往返。
// 2) 连不上时错误按 60s TTL 缓存:第二次调用不再发 TCP 连接——否则一个死掉的远端会让每轮
//    请求都重付一次连接超时,提示词还每轮换一句新话术(appendSystemPrompt 的字节稳定性)。
// 3) 提示词里绝不出现凭据:它进模型上下文,也进请求日志。

import { afterEach, describe, expect, test } from "bun:test";
import type { ServerChannel } from "ssh2";
import type { SshDevice } from "../foundation/types/settings";
import { SHELL_PROBE_COMMAND } from "./command-wrap";
import { fixtureDevice, TEST_PASSWORD as PASSWORD, trustedHostKey, withFakeServer } from "../test-utils/ssh-fixtures";
import type { FakeSshServer } from "../test-utils/fake-ssh-server";
import { sshPool } from "./pool";
import {
  buildSshWorkspacePrompt,
  buildUnreachablePrompt,
  cachedRemoteEnvironment,
  clearRemoteEnvironmentCache,
  parseOsReleaseName,
  sshWorkspacePrompt,
  type RemoteEnvironment,
} from "./workspace-prompt";
import type { SshWorkspaceTarget } from "./workspace-binding";

const OS_RELEASE = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\n`;
const TARGET_ROOT = "/srv/app";

/** 指向假服务器的可用绑定(target 是纯配置对象,构造它不需要建连)。 */
function targetFor(server: FakeSshServer, patch: Partial<SshDevice> = {}): SshWorkspaceTarget {
  const device = { ...fixtureDevice(patch, server.port), hostKey: trustedHostKey(server) };
  return {
    device,
    dir: { id: "app", name: "", path: TARGET_ROOT },
    root: TARGET_ROOT,
    label: `${device.username}@${device.host}:${device.port}`,
  };
}

/** 探测应答:shell 探针回 /bin/bash,os-release 回发行版内容,其余回 ok。 */
function answering(record: { command: string }, channel: ServerChannel): void {
  if (record.command === SHELL_PROBE_COMMAND) channel.write("/bin/bash\n");
  else if (record.command.includes("/etc/os-release")) channel.write(OS_RELEASE);
  else channel.write("ok\n");
  channel.exit(0);
  channel.close();
}

afterEach(() => {
  // 池与缓存都是进程级单例:不让上一轮的连接/缓存活到下一轮。
  // 用 close(deviceId) 而不是 closeAll():后者是给进程退出用的,一旦调用这个单例
  // 就永久不可再建连,后面的用例会全变成"SSH connection pool is closed"。
  sshPool.close("dev");
  clearRemoteEnvironmentCache();
});

describe("parseOsReleaseName", () => {
  test("优先 PRETTY_NAME,引号剥掉", () => {
    expect(parseOsReleaseName(OS_RELEASE)).toBe("Debian GNU/Linux 12 (bookworm)");
  });

  test("没有 PRETTY_NAME 时 NAME + VERSION_ID 拼出来", () => {
    expect(parseOsReleaseName('NAME="Ubuntu"\nVERSION_ID="24.04"\n')).toBe("Ubuntu 24.04");
  });

  test("注释、空行与没有键的行都不算;同名键取第一次出现", () => {
    expect(parseOsReleaseName('# PRETTY_NAME="注释里的"\n\nBAD LINE\nPRETTY_NAME=Arch\nPRETTY_NAME=Other\n')).toBe("Arch");
  });

  test("控制字符清掉、限长 80:远端可写文件不能借 os-release 改写系统提示", () => {
    expect(parseOsReleaseName('PRETTY_NAME="Debian\u0000\u001b[31mOVERRIDE\u0007"')).toBe("Debian[31mOVERRIDE");
    expect(parseOsReleaseName(`PRETTY_NAME="${"x".repeat(200)}"`)).toHaveLength(80);
  });

  test("全空/只有空白值 → null(提示词省略发行版那一行,而不是编一个)", () => {
    expect(parseOsReleaseName("")).toBeNull();
    expect(parseOsReleaseName('PRETTY_NAME=""\nNAME=""\n')).toBeNull();
  });
});

describe("远端环境探测与缓存", () => {
  test("成功:shell 与发行版都读出来,第二轮直接吃缓存(不再发一条 exec、也不再握手)", async () => {
    await withFakeServer({ password: PASSWORD, onExec: answering }, async (server) => {
      const target = targetFor(server);
      const first = await cachedRemoteEnvironment("ws-1", target);
      expect(first.error).toBeNull();
      expect(first.environment).toEqual({ shell: "/bin/bash", distro: "Debian GNU/Linux 12 (bookworm)" });
      const execs = server.execs.length;
      const connections = server.connections;

      const second = await cachedRemoteEnvironment("ws-1", target);
      expect(second.environment).toEqual(first.environment);
      expect(server.execs).toHaveLength(execs);
      expect(server.connections).toBe(connections);

      // 另一个工作区(同一台机器):缓存按工作区存,连接按设备复用。
      const other = await cachedRemoteEnvironment("ws-2", target);
      expect(other.environment?.shell).toBe("/bin/bash");
      const execsAfterNewWorkspace = server.execs.length;
      expect(await cachedRemoteEnvironment("ws-2", target)).toEqual(other);
      expect(server.execs).toHaveLength(execsAfterNewWorkspace);
    });
  });

  test("失败按 TTL 抑制重连;显式清空后才会再试一次", async () => {
    // 假服务器不接任何密码:认证必失败,而 TCP 握手次数是能数到的。
    await withFakeServer({ password: null, onExec: answering }, async (server) => {
      const target = targetFor(server);
      const first = await cachedRemoteEnvironment("ws", target);
      expect(first.environment).toBeNull();
      expect(first.error).toBeTruthy();
      expect(server.connections).toBe(1);

      const second = await cachedRemoteEnvironment("ws", target);
      expect(second.error).toBe(first.error);
      expect(server.connections).toBe(1);

      clearRemoteEnvironmentCache("ws");
      await cachedRemoteEnvironment("ws", target);
      expect(server.connections).toBe(2);
    });
  });

  test("凭据变了等于换了台机器:成功的缓存不沿用,自动重新探测", async () => {
    // acceptAnyPassword 让换完密码仍连得上:证明「重探」是指纹变了导致的,不是连接失败。
    await withFakeServer({ password: PASSWORD, acceptAnyPassword: true, onExec: answering }, async (server) => {
      const target = targetFor(server);
      await cachedRemoteEnvironment("ws", target);
      const probesAfterFirst = server.execs.length;

      const changed = { ...target, device: { ...target.device, password: "another-password" } };
      const result = await cachedRemoteEnvironment("ws", changed);
      expect(result.environment?.shell).toBe("/bin/bash");
      expect(server.execs.length).toBeGreaterThan(probesAfterFirst);
    });
  });

  test("取消(signal 已 abort)不当成连不上缓存", async () => {
    await withFakeServer({ password: PASSWORD, onExec: answering }, async (server) => {
      const controller = new AbortController();
      controller.abort();
      let thrown: unknown = null;
      try {
        await cachedRemoteEnvironment("ws", targetFor(server), controller.signal);
      } catch (err) {
        thrown = err;
      }
      // 抛出来(而不是返回 environment:null + error:…),下一轮照常尝试。
      expect(thrown).not.toBeNull();
      expect(server.connections).toBeLessThanOrEqual(1);
    });
  });
});

describe("提示词文本", () => {
  const environment: RemoteEnvironment = { shell: "/bin/bash", distro: "Debian GNU/Linux 12 (bookworm)" };

  function localTarget(root = "/srv/app"): SshWorkspaceTarget {
    const device = fixtureDevice();
    return { device, dir: { id: "d", name: "", path: root }, root, label: `${device.username}@${device.host}:${device.port}` };
  }

  test("安卓端那几句要紧的话都在:非沙箱、只有 read 受边界约束、没有写入/编辑工具", () => {
    const prompt = buildSshWorkspacePrompt({ name: "生产服务器" }, localTarget(), environment, null);
    expect(prompt.startsWith("<workspace>")).toBe(true);
    expect(prompt.endsWith("</workspace>")).toBe(true);
    expect(prompt).toContain("This is not a sandbox");
    expect(prompt).toContain("Only the read tool is confined");
    expect(prompt).toContain("There are no file write or edit tools");
    expect(prompt).toContain("`read`");
    expect(prompt).toContain("`bash`");
    expect(prompt).toContain("Debian GNU/Linux 12 (bookworm)");
    expect(prompt).toContain("/bin/bash");
    expect(prompt).toContain("`/srv/app`");
    // 凭据不进提示词:它进模型上下文,也进请求日志。
    expect(prompt).not.toContain(PASSWORD);
  });

  test("非 bash 的 shell 要明说别用 bash 语法(dropbear/BusyBox 那类机器)", () => {
    const prompt = buildSshWorkspacePrompt({ name: "router" }, localTarget("/home/deploy"), { shell: "/bin/sh", distro: null }, null);
    expect(prompt).toContain("a POSIX shell");
    expect(prompt).toContain("avoid bash-only syntax");
    // 读不到发行版时那一行整个省略,而不是写成 unknown。
    expect(prompt).not.toContain("The remote operating system is");
  });

  test("cwd 只在真的不同于边界根时出现", () => {
    const target = localTarget();
    expect(buildSshWorkspacePrompt({ name: "ws" }, target, environment, "/srv/app")).not.toContain("Current working directory");
    expect(buildSshWorkspacePrompt({ name: "ws" }, target, environment, "/srv/app/api")).toContain("Current working directory: `/srv/app/api`");
  });

  test("连不上:说明工具会失败,并劝模型别连试命令", () => {
    const prompt = buildUnreachablePrompt({ name: "ws" }, localTarget(), "read ECONNRESET");
    expect(prompt).toContain("currently unreachable: read ECONNRESET");
    expect(prompt).toContain("Workspace tools will fail");
    expect(prompt).not.toContain(PASSWORD);
  });

  test("单一入口永不抛:连不上也是一段措辞稳定的 unreachable 说明", async () => {
    const device = { ...fixtureDevice({}, 1), hostKey: { type: "ssh-ed25519", key: "AAAAB3Nj", fingerprint: "SHA256:test" } };
    const orphan: SshWorkspaceTarget = { device, dir: { id: "d", name: "", path: "/srv/app" }, root: "/srv/app", label: "tester@127.0.0.1:1" };
    const prompt = await sshWorkspacePrompt({ workspace: { id: "ws", name: "ws" }, target: orphan, cwd: null });
    expect(prompt).toContain("currently unreachable");
    expect(prompt).not.toContain(PASSWORD);
    // 同一会话连续几轮措辞一致(靠失败缓存,不是碰运气快失败)。
    expect(await sshWorkspacePrompt({ workspace: { id: "ws", name: "ws" }, target: orphan, cwd: null })).toBe(prompt);
  });
});
