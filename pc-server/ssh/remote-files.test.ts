// ssh/remote-files.test.ts — 授权目录文件面的行为契约(远端是内存 VFS,见 test-utils/fake-sftp-fs.ts)。
//
// 为什么值得为这一层写整包测试:文件面是「AI 工具与文件面板真正碰远端磁盘」的那一层,
// 它对错的不是我们脑补的 SFTP,而是两台机器上同一套可见行为——列目录的顺序与滤子、大小上限、
// 冲突改名、删链子还是删目标、路径越界。安卓端这些规则全在 SshWorkspaceBackend.kt 里,
// 断言逐条对着它写;凡是刻意不同的地方(头部差异清单)也都有一条测试把它钉在「不同」上。
//
// 纪律:每台假服务器只监听 127.0.0.1,路径与内容全是测试常量;每条用例结束把设备连接踢出池,
// 不让上一轮的连接带着上一轮的 VFS 活到下一轮。

import { afterEach, describe, expect, test } from "bun:test";
import type { FakeSshServer } from "../test-utils/fake-ssh-server";
import {
  TEST_PASSWORD as PASSWORD,
  fixtureDevice,
  trustedHostKey,
  withFakeServer as withServer,
} from "../test-utils/ssh-fixtures";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import { MAX_LIST_ENTRIES, MAX_READ_BYTES, MAX_WRITE_BYTES } from "./constants";
import { SshInputError } from "./errors";
import { sshPool } from "./pool";
import {
  authorizedRemoteDir,
  deleteRemoteEntry,
  listRemoteDir,
  previewRemoteFile,
  readRemoteBytes,
  readRemoteText,
  remoteFileSize,
  uploadRemoteFile,
  writeRemoteText,
} from "./remote-files";

const APP: SshRemoteDir = { id: "app", name: "应用目录", path: "/srv/app" };

/** 已信任 + 指向假服务器 + 带授权目录的设备条目(文件面的入参形态)。 */
function appDevice(server: FakeSshServer, dirs: SshRemoteDir[] = [APP]): SshDevice {
  return { ...fixtureDevice({ dirs }, server.port), hostKey: trustedHostKey(server) };
}

/**
 * 断言「这一步就是拒了」,并把错误对象交出来比对文案与 errorCode。
 * 收函数而不是收 Promise:授权判断与路径归一是在建连之前**同步**抛的,
 * 传现成的 Promise 会让那个同步异常绕过 try,测试反而看不到拒。
 */
async function expectRejected(run: () => Promise<unknown>): Promise<SshInputError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SshInputError) return error;
    throw new Error(`预期 SshInputError,实际是 ${String(error)}`);
  }
  throw new Error("预期抛错,但调用成功了");
}

/** 远端条目被 SFTP 层写进内存后,测试侧看它的时间戳(SFTP 秒 ×1000)。 */
function remoteMtimeMs(server: FakeSshServer, path: string): number {
  const node = server.fs.nodes.get(path);
  if (!node) throw new Error(`种子里没有 ${path}`);
  return Math.floor(node.mtime / 1000) * 1000;
}

afterEach(() => {
  // 池是进程级单例:上一轮的连接会连着上一轮那台已经关掉的服务器。
  sshPool.close("dev");
});

describe("授权目录就是边界", () => {
  test("没登记或还没填完的目录:连一条 TCP 都不发", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const draft: SshRemoteDir = { id: "draft", name: "半成品", path: "" };
      const deviceItem = appDevice(server, [APP, draft]);
      for (const dirId of ["nope", "draft", ""]) {
        const error = await expectRejected(() => listRemoteDir(deviceItem, dirId, ""));
        expect(error.errorCode).toBe("ssh.dir_unauthorized");
        // 文案只报地址,不报目录路径,更不含凭据。
        expect(error.message).toBe(`Remote directory is not authorized for tester@127.0.0.1:${server.port}`);
      }
      expect(server.connections).toBe(0);
    });
  });

  test("越出授权目录在本地就拒:符号链接跳板也过不去", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/etc/passwd": "root:x:0:0" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const escaping = await expectRejected(() => listRemoteDir(deviceItem, "app", "../etc"));
      expect(escaping.errorCode).toBe("ssh.path_escape");
      expect(escaping.message).toBe("Path escapes workspace root: ../etc");

      // 词法归一不跟随符号链接:`link/../../etc` 归一后是 /srv,同样在根外。
      const viaLink = await expectRejected(() => listRemoteDir(deviceItem, "app", "link/../../etc"));
      expect(viaLink.errorCode).toBe("ssh.path_escape");
      expect(server.connections).toBe(0);
    });
  });

  test("dirId 也认逐字登记的旧路径(兼容只有路径的旧数据)", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/a.txt": "A" },
    }, async (server) => {
      expect(authorizedRemoteDir(appDevice(server), "/srv/app").path).toBe("/srv/app");
      const entries = await listRemoteDir(appDevice(server), "/srv/app", "");
      expect(entries.map((item) => item.name)).toEqual(["a.txt"]);
    });
  });

  test("相对路径的授权目录不可用:归一阶段就拦下,不带去连", async () => {
    await withServer({ password: PASSWORD }, async (server) => {
      const loose: SshRemoteDir = { id: "loose", name: "相对", path: "srv/app" };
      const error = await expectRejected(() => listRemoteDir(appDevice(server, [loose]), "loose", ""));
      expect(error.errorCode).toBe("ssh.path_relative");
      expect(server.connections).toBe(0);
    });
  });
});

describe("列目录与安卓端同形", () => {
  test("目录在前、名字不区分大小写、路径相对授权目录", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: {
        "/srv/app": true,
        "/srv/app/archive": true,
        "/srv/app/Beta": true,
        "/srv/app/alpha.txt": "小写在前",
        "/srv/app/Zeta.txt": "大写在后",
      },
    }, async (server) => {
      const entries = await listRemoteDir(appDevice(server), "app", "");
      expect(entries.map((item) => [item.name, item.type])).toEqual([
        ["archive", "dir"],
        ["Beta", "dir"],
        ["alpha.txt", "file"],
        ["Zeta.txt", "file"],
      ]);
      // 目录 size 记 0;文件记真实字节数;path 是相对授权目录的名字(面板据此再发请求)。
      expect(entries.map((item) => item.path)).toEqual(["archive", "Beta", "alpha.txt", "Zeta.txt"]);
      expect(entries[0]!.size).toBe(0);
      expect(entries[2]!.size).toBe(Buffer.byteLength("小写在前", "utf8"));
      // mtime 是 SFTP v3 的无符号 32 位秒数 ×1000,不是毫秒原值。
      expect(entries[2]!.modifiedAt).toBe(remoteMtimeMs(server, "/srv/app/alpha.txt"));
      expect(entries[2]!.modifiedAt % 1000).toBe(0);
    });
  });

  test("子目录按相对路径进入,上级用 .. 走回根内", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/deep/inner.txt": "内容" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const deep = await listRemoteDir(deviceItem, "app", "deep");
      // path 恒相对**授权目录**,不是相对当前所在目录(安卓端 relativePath(area, child) 的同一条规则):
      // 面板拿它再发 read/delete 请求,自己拼目录前缀就会双标。
      expect(deep.map((item) => item.path)).toEqual(["deep/inner.txt"]);
      // 前端把当前目录记成 "deep",再用 "deep/../" 这类路径回来:归一后仍是授权目录内。
      expect(await listRemoteDir(deviceItem, "app", "deep/../")).toMatchObject([
        { name: "deep", path: "deep", type: "dir" },
      ]);
    });
  });

  test("指向目录的软链按目录展示,指向文件的软链仍是文件且 size 记 0", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: {
        "/srv/app": true,
        "/srv/target": true,
        "/srv/target/inside.txt": "在目标里",
        "/srv/app/file.txt": "x",
        "/srv/app/link": { link: "/srv/target" },
        "/srv/app/file-link": { link: "/srv/app/file.txt" },
      },
    }, async (server) => {
      const entries = await listRemoteDir(appDevice(server), "app", "");
      const byName = Object.fromEntries(entries.map((item) => [item.name, item]));
      // lstat 只说是链接,要多一次 stat 才知道它是目录(与安卓端同一判据)。
      expect(byName.link).toMatchObject({ type: "dir", path: "link", size: 0 });
      expect(byName["file-link"]).toMatchObject({ type: "file", path: "file-link", size: 0 });
      expect(byName["file.txt"]).toMatchObject({ type: "file", size: 1 });
      // 链接指向根外的目录也不影响:列的是名字,不是目标内容。
      expect(server.fs.exists("/srv/target/inside.txt")).toBe(true);
    });
  });

  test("一次最多 500 条(安卓端 maxListEntries),截的是排序后的前 500", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      for (let i = 0; i < MAX_LIST_ENTRIES + 100; i += 1) {
        server.fs.write(`/srv/app/f${String(i).padStart(4, "0")}.txt`, "x");
      }
      const entries = await listRemoteDir(appDevice(server), "app", "");
      expect(entries).toHaveLength(MAX_LIST_ENTRIES);
      expect(entries[0]!.name).toBe("f0000.txt");
      expect(entries[MAX_LIST_ENTRIES - 1]!.name).toBe("f0499.txt");
    });
  });

  test("目录不存在与拿文件当目录:两条不同的错误,都带相对路径", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/plain.txt": "x" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const missing = await expectRejected(() => listRemoteDir(deviceItem, "app", "nope"));
      expect(missing.errorCode).toBe("ssh.path_missing");
      expect(missing.message).toBe("Path does not exist: nope");

      const notDir = await expectRejected(() => listRemoteDir(deviceItem, "app", "plain.txt"));
      expect(notDir.errorCode).toBe("ssh.not_a_directory");
      expect(notDir.message).toBe("Path is not a directory: plain.txt");
    });
  });

  test("授权目录被删掉后先长回来再列,不把「目录没了」报成路径错误", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/orphan.txt": "旧内容" },
    }, async (server) => {
      // 用户在远端把整个工作目录 rm 掉了(安卓端 ensureDir 就是在防这个)。
      server.fs.nodes.delete("/srv/app");
      server.fs.nodes.delete("/srv/app/orphan.txt");
      const entries = await listRemoteDir(appDevice(server), "app", "");
      expect(entries).toEqual([]);
      expect(server.fs.exists("/srv/app")).toBe(true);
    });
  });
});

describe("读:上限、类型、编码", () => {
  test("文本按 UTF-8 原样读出,大小与 remoteFileSize 一致", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/notes/中文.txt": "第一行\n第二行\n" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      expect(await readRemoteText(deviceItem, "app", "notes/中文.txt")).toBe("第一行\n第二行\n");
      expect(await remoteFileSize(deviceItem, "app", "notes/中文.txt"))
        .toBe(Buffer.byteLength("第一行\n第二行\n", "utf8"));
    });
  });

  test("预览读超过 512 KiB 报错,同一文件按下载上限读得动", async () => {
    const payload = "x".repeat(MAX_READ_BYTES + 1);
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/big.txt": payload },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const error = await expectRejected(() => readRemoteText(deviceItem, "app", "big.txt"));
      expect(error.errorCode).toBe("ssh.file_too_large");
      // 前缀与安卓端逐字一致,只在后面补了本次生效的上限(差异第 3 条)。
      expect(error.message).toBe(
        `File is too large to read: ${payload.length} bytes (limit ${MAX_READ_BYTES})`,
      );
      // 上限在 stat 之后、读之前判定:此刻一个 OPEN 都没发出去。
      expect(server.fs.ops.filter((op) => op.startsWith("open:"))).toEqual([]);

      const bytes = await readRemoteBytes(deviceItem, "app", "big.txt", payload.length);
      expect(bytes.toString("utf8")).toBe(payload);
    });
  });

  test("读目录与读不存在的文件分别报错(与安卓端 requireFile 同文案)", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/sub": true },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const missing = await expectRejected(() => readRemoteText(deviceItem, "app", "nope.txt"));
      expect(missing.errorCode).toBe("ssh.path_missing");
      expect(missing.message).toBe("File does not exist: nope.txt");

      const isDir = await expectRejected(() => readRemoteText(deviceItem, "app", "sub"));
      expect(isDir.errorCode).toBe("ssh.not_a_file");
      expect(isDir.message).toBe("Path is not a file: sub");
    });
  });
});

describe("写与上传", () => {
  test("写文件自动补齐父目录,内容落远端,回的是相对路径条目", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const entry = await writeRemoteText(appDevice(server), "app", "notes/2026/log.md", "# 今天", false);
      expect(entry).toMatchObject({ path: "notes/2026/log.md", name: "log.md", type: "file", size: 8 });
      expect(server.fs.read("/srv/app/notes/2026/log.md")).toBe("# 今天");
      expect(server.fs.exists("/srv/app/notes/2026")).toBe(true);
    });
  });

  test("overwrite=false 撞到已有文件就拒,同名目录也拒;overwrite=true 才替换", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/a.txt": "旧", "/srv/app/sub": true },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const exists = await expectRejected(() => writeRemoteText(deviceItem, "app", "a.txt", "新", false));
      expect(exists.errorCode).toBe("ssh.already_exists");
      expect(exists.message).toBe("File already exists: a.txt");
      expect(server.fs.read("/srv/app/a.txt")).toBe("旧");

      // 安卓端先判 overwrite 再判目录,所以拿目录当文件写报的是「不是文件」。
      const ontoDir = await expectRejected(() => writeRemoteText(deviceItem, "app", "sub", "x", true));
      expect(ontoDir.errorCode).toBe("ssh.not_a_file");
      expect(ontoDir.message).toBe("Path is not a file: sub");

      await writeRemoteText(deviceItem, "app", "a.txt", "新", true);
      expect(server.fs.read("/srv/app/a.txt")).toBe("新");
    });
  });

  test("内容超过 2 MiB 在建连之前就拒", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const error = await expectRejected(() => writeRemoteText(
        appDevice(server), "app", "big.txt", "y".repeat(MAX_WRITE_BYTES + 1), true,
      ));
      expect(error.errorCode).toBe("ssh.content_too_large");
      expect(error.message).toBe(`Content is too large to write: ${MAX_WRITE_BYTES + 1} bytes`);
      expect(server.connections).toBe(0);
    });
  });

  test("上传撞名自动改名 a (1).txt,再撞 a (2).txt,原始内容谁也不覆盖", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/notes/a.txt": "远端已有" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const first = await uploadRemoteFile(deviceItem, "app", "notes", "a.txt", new TextEncoder().encode("新上传"));
      expect(first.path).toBe("notes/a (1).txt");
      expect(server.fs.read("/srv/app/notes/a (1).txt")).toBe("新上传");
      expect(server.fs.read("/srv/app/notes/a.txt")).toBe("远端已有");

      const second = await uploadRemoteFile(deviceItem, "app", "notes", "a.txt", new TextEncoder().encode("第三份"));
      expect(second.path).toBe("notes/a (2).txt");
      // 无扩展名的名字整个当词干(与安卓端只在「有点」时才切)。
      const third = await uploadRemoteFile(deviceItem, "app", "notes", "README", new TextEncoder().encode("r"));
      expect(third.path).toBe("notes/README");
      const fourth = await uploadRemoteFile(deviceItem, "app", "notes", "README", new TextEncoder().encode("r2"));
      expect(fourth.path).toBe("notes/README (1)");
      // 点文件:安卓端会得到「 (1).env」这种带前导空格的名字,这里按无扩展名处理(差异第 4 条)。
      await uploadRemoteFile(deviceItem, "app", "notes", ".env", new TextEncoder().encode("A=1"));
      const dot = await uploadRemoteFile(deviceItem, "app", "notes", ".env", new TextEncoder().encode("A=2"));
      expect(dot.path).toBe("notes/.env (1)");
    });
  });

  test("上传不带目录时落在授权目录根,空文件名报错且不建连", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const deviceItem = appDevice(server);
      const atRoot = await uploadRemoteFile(deviceItem, "app", "", "top.txt", new TextEncoder().encode("t"));
      expect(atRoot.path).toBe("top.txt");
      expect(server.fs.read("/srv/app/top.txt")).toBe("t");

      const error = await expectRejected(() => uploadRemoteFile(deviceItem, "app", "", "  ", new Uint8Array(1)));
      expect(error.errorCode).toBe("ssh.name_required");
      expect(error.message).toBe("File name is required");
    });
  });

  test("上传的目录段拼在授权目录内:../ 越界照样拒", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const error = await expectRejected(() => uploadRemoteFile(appDevice(server), "app", "../escape", "x.txt", new Uint8Array(1)));
      expect(error.errorCode).toBe("ssh.path_escape");
      expect(server.connections).toBe(0);
    });
  });
});

describe("删除", () => {
  test("授权目录本身永远删不掉:三种写法都在本地拦下", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const deviceItem = appDevice(server);
      for (const relPath of ["", ".", "sub/.."]) {
        const error = await expectRejected(() => deleteRemoteEntry(deviceItem, "app", relPath, true));
        expect(error.errorCode).toBe("ssh.root_delete");
        expect(error.message).toBe("Refusing to delete workspace root");
      }
      expect(server.fs.exists("/srv/app")).toBe(true);
      expect(server.connections).toBe(0);
    });
  });

  test("目录必须 recursive;删文件与不存在的条目不啰嗦", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: {
        "/srv/app": true,
        "/srv/app/keep.txt": "k",
        "/srv/app/tree/leaf.txt": "l",
        "/srv/app/tree/branch/deep.txt": "d",
      },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const dir = await expectRejected(() => deleteRemoteEntry(deviceItem, "app", "tree", false));
      expect(dir.errorCode).toBe("ssh.recursive_required");
      expect(dir.message).toBe("Directory delete requires recursive = true");
      expect(server.fs.exists("/srv/app/tree")).toBe(true);

      expect(await deleteRemoteEntry(deviceItem, "app", "keep.txt", false)).toBe(true);
      expect(server.fs.exists("/srv/app/keep.txt")).toBe(false);
      // 不存在回 false 而不是抛错:界面按「已经没了」处理。
      expect(await deleteRemoteEntry(deviceItem, "app", "keep.txt", false)).toBe(false);

      expect(await deleteRemoteEntry(deviceItem, "app", "tree", true)).toBe(true);
      expect(server.fs.exists("/srv/app/tree")).toBe(false);
      expect(server.fs.list("/srv/app/tree")).toEqual([]);
    });
  });

  test("指向目录的软链只删链接,目标目录与内容一根毛都不动", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: {
        "/srv/app": true,
        "/srv/data": true,
        "/srv/data/important.txt": "别删我",
        "/srv/app/data-link": { link: "/srv/data" },
      },
    }, async (server) => {
      const deviceItem = appDevice(server);
      // lstat 看到 isDir 但 isLink 也成立 → 走 rm 而不是递归删目标目录(安卓端同判据)。
      expect(await deleteRemoteEntry(deviceItem, "app", "data-link", true)).toBe(true);
      expect(server.fs.exists("/srv/app/data-link")).toBe(false);
      expect(server.fs.exists("/srv/data")).toBe(true);
      expect(server.fs.read("/srv/data/important.txt")).toBe("别删我");
    });
  });

  test("递归删目录时链接指向的目录不跟着删,链子本身删掉", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: {
        "/srv/app": true,
        "/srv/app/tree": true,
        "/srv/data": true,
        "/srv/data/important.txt": "别删我",
        "/srv/app/tree/link": { link: "/srv/data" },
      },
    }, async (server) => {
      expect(await deleteRemoteEntry(appDevice(server), "app", "tree", true)).toBe(true);
      expect(server.fs.exists("/srv/app/tree")).toBe(false);
      expect(server.fs.exists("/srv/data/important.txt")).toBe(true);
    });
  });
});

describe("通配符是普通字符(安卓端 sftpQuote 不跟过来)", () => {
  test("名字里的 * 与 ? 逐字匹配,列得出、读得回、也不转义", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const deviceItem = appDevice(server);
      await writeRemoteText(deviceItem, "app", "a*b.txt", "星号", true);
      await writeRemoteText(deviceItem, "app", "q?.txt", "问号", true);

      const names = (await listRemoteDir(deviceItem, "app", "")).map((item) => item.name);
      expect(names).toEqual(["a*b.txt", "q?.txt"]);
      expect(await readRemoteText(deviceItem, "app", "a*b.txt")).toBe("星号");
      expect(await readRemoteText(deviceItem, "app", "q?.txt")).toBe("问号");

      // 发到服务器的路径就是字面路径:JSch 那套反斜杠转义在这里会把文件找没。
      expect(server.fs.ops.some((op) => op.includes("\\"))).toBe(false);
      expect(server.fs.ops.filter((op) => op.includes("a*b.txt")).length).toBeGreaterThan(0);
    });
  });

  test("空格、引号、变音字母都当普通路径字符;反斜杠按归一规则折成正斜杠", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const deviceItem = appDevice(server);
      const odd = "weird name 'with\" quotes ümlaut";
      await writeRemoteText(deviceItem, "app", odd, "内容", false);
      expect(server.fs.read(`/srv/app/${odd}`)).toBe("内容");
      expect(await readRemoteText(deviceItem, "app", odd)).toBe("内容");
      expect((await listRemoteDir(deviceItem, "app", "")).map((item) => item.name)).toEqual([odd]);

      // 反斜杠在归一阶段折成正斜杠(安卓端 resolve 的同一条规则):界面传来 Windows 风格的相对路径
      // 落的是子目录,而不是一个叫 "notes\x.txt" 的文件。
      const winLike = await writeRemoteText(deviceItem, "app", "notes\\win.txt", "w", false);
      expect(winLike.path).toBe("notes/win.txt");
      expect(server.fs.read("/srv/app/notes/win.txt")).toBe("w");
    });
  });
});

describe("面板预览(与本地面板同一套判定)", () => {
  /** 最小可嗅探的 PNG:8 字节签名 + 块长 13 + "IHDR"(workspace/tools/mime.ts 的 isPng 要求)。 */
  function pngBytes(extra = 0): Buffer {
    const head = Buffer.alloc(33 + extra);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write("IHDR", 12, "ascii");
    return head;
  }

  test("小文本:整份回文、不截断,size 按 UTF-8 字节数", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/hi.txt": "你好\n" },
    }, async (server) => {
      const preview = await previewRemoteFile(appDevice(server), "app", "hi.txt");
      expect(preview).toEqual({ kind: "text", text: "你好\n", truncated: false, size: 7 });
    });
  });

  test("前缀按 32KB 分次读:非整倍数的长度也读全,且只 open 一次", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      // 100KB = 3 个满块 + 1 个 3KB 尾巴:只发一次 READ 的写法在这里会少读 60 多 KB。
      server.fs.write("/srv/app/log.txt", Buffer.alloc(100 * 1024, 0x61));
      const preview = await previewRemoteFile(appDevice(server), "app", "log.txt");
      if (preview.kind !== "text") throw new Error(`预期 text,实际 ${preview.kind}`);
      expect(preview.text).toHaveLength(100 * 1024);
      expect(preview.truncated).toBe(false);
      expect(preview.size).toBe(100 * 1024);
      // 走的是「一次打开、按偏移续读」,不是整读再切;读 512KB 上限之外才需要更多轮。
      expect(server.fs.ops.filter((op) => op.startsWith("open:"))).toEqual(["open:/srv/app/log.txt"]);
    });
  });

  test("超过读取上限只回前半截:边界上的半个字符不留替换符", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      // 首字节用 "a" 占位,让第 MAX_READ_BYTES 字节正好切进后面某个 "é"(2 字节)的中间:
      // 尾巴那半个字符会被解码成 ,预览把它削掉而不是显示成乱码残片。
      const source = Buffer.from(`a${"é".repeat(MAX_READ_BYTES / 2)}`, "utf8");
      server.fs.write("/srv/app/big.txt", source);
      const preview = await previewRemoteFile(appDevice(server), "app", "big.txt");
      if (preview.kind !== "text") throw new Error(`预期 text,实际 ${preview.kind}`);
      expect(preview.truncated).toBe(true);
      expect(preview.size).toBe(source.byteLength);
      expect(preview.text).toHaveLength(MAX_READ_BYTES / 2);
      expect(preview.text.endsWith("é")).toBe(true);
      // 边界上的半个多字节字符解码成 (U+FFFD),预览把它削掉而不是留在尾巴上。
      const replacementCharacter = String.fromCharCode(0xfffd);
      expect(preview.text).not.toContain(replacementCharacter);
    });
  });

  test("首 8KB 含 NUL 按二进制处理,不返回乱码正文", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true },
    }, async (server) => {
      const payload = Buffer.concat([Buffer.from("prefix"), Buffer.from([0]), Buffer.alloc(200, 0x41)]);
      server.fs.write("/srv/app/blob.bin", payload);
      const preview = await previewRemoteFile(appDevice(server), "app", "blob.bin");
      expect(preview).toEqual({ kind: "binary", size: payload.byteLength });
      // 只有面板这条路判二进制;安卓端的 readText(AI 工具与编辑器用)同一份内容照回,界面不必特判。
      expect(await readRemoteText(appDevice(server), "app", "blob.bin")).toContain("prefix");
    });
  });

  test("图片按魔数判定而不是扩展名:名字骗不过嗅探", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const deviceItem = appDevice(server);
      // shot.png 是真 PNG 字节(经上传落远端),notes.png 只是恰好叫这个名字的文本。
      await uploadRemoteFile(deviceItem, "app", "", "shot.png", pngBytes());
      await writeRemoteText(deviceItem, "app", "notes.png", "just text", false);

      const image = await previewRemoteFile(deviceItem, "app", "shot.png");
      expect(image.kind).toBe("image");
      if (image.kind !== "image") throw new Error("unreachable");
      expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      // 解码回来的字节与种进去的一模一样(data URL 的 base64 不吞字节,也不补零)。
      expect(Buffer.from(image.dataUrl.split(",")[1] ?? "", "base64").toString("base64")).toBe(pngBytes().toString("base64"));
      expect(image.size).toBe(pngBytes().byteLength);

      const impostor = await previewRemoteFile(deviceItem, "app", "notes.png");
      expect(impostor.kind).toBe("text");
    });
  });

  test("图片超过预览上限只报二进制:不把 10MB 以上整份转成 data URL", async () => {
    await withServer({ password: PASSWORD, fsSeed: { "/srv/app": true } }, async (server) => {
      const huge = Buffer.concat([pngBytes(), Buffer.alloc(10 * 1024 * 1024, 0x41)]);
      server.fs.write("/srv/app/huge.png", huge);
      const preview = await previewRemoteFile(appDevice(server), "app", "huge.png");
      expect(preview).toEqual({ kind: "binary", size: huge.byteLength });
      // 判定用的是 stat 的大小,读请求只发了嗅探那一小段(整读会走完 10MB 的 SFTP 往返)。
      expect(server.fs.ops.filter((op) => op.startsWith("open:"))).toEqual(["open:/srv/app/huge.png"]);
    });
  });

  test("预览同样吃授权边界:越界与未登记目录都不建连接", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/etc/passwd": "root:x:0:0" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const escape = await expectRejected(() => previewRemoteFile(deviceItem, "app", "../etc/passwd"));
      expect(escape.errorCode).toBe("ssh.path_escape");
      const unauthorized = await expectRejected(() => previewRemoteFile(deviceItem, "elsewhere", "a.txt"));
      expect(unauthorized.errorCode).toBe("ssh.dir_unauthorized");
      expect(server.connections).toBe(0);
    });
  });

  test("不存在回 path_missing,目录回 not_a_file:文案与读文本同一条路径", async () => {
    await withServer({
      password: PASSWORD,
      fsSeed: { "/srv/app": true, "/srv/app/sub/inner.txt": "i" },
    }, async (server) => {
      const deviceItem = appDevice(server);
      const missing = await expectRejected(() => previewRemoteFile(deviceItem, "app", "ghost.txt"));
      expect(missing.errorCode).toBe("ssh.path_missing");
      expect(missing.message).toBe("File does not exist: ghost.txt");
      const directory = await expectRejected(() => previewRemoteFile(deviceItem, "app", "sub"));
      expect(directory.errorCode).toBe("ssh.not_a_file");
      expect(directory.message).toBe("Path is not a file: sub");
    });
  });
});
