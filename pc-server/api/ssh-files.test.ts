// api/ssh-files.test.ts — 远程文件面板的 HTTP 面(参数来路、状态码、响应头、载荷形状)。
//
// 域层规则(排序、大小上限、冲突改名、删链子不删目标)已经在 ssh/remote-files.test.ts 逐条钉过,
// 这里只测「套上路由之后有没有变形」:三种参数来路落到同一组字段、授权类错误在 HTTP 上也是 403、
// raw 只允许 PDF 内联、远端文件名进响应头前先洗掉引号与换行,以及多次请求只握一次手(连接池
// 在路由这一侧确实被复用)。另一条单独钉死的边界:文件路由不接受内联草稿设备——
// 能浏览哪些目录,以用户确认过并落库的那份 dirs 为准。
//
// 纪律:假服务器只听 127.0.0.1,路径与内容全是测试常量;每条用例结束把设备踢出池并还原 settings。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ssh-files-test-"));

import type { State } from "../foundation/types";
import type { SshDevice, SshRemoteDir } from "../foundation/types/settings";
import { flushSaveState, setState, state } from "../persistence/json-store";
import type { FakeSshServer } from "../test-utils/fake-ssh-server";
import type { FakeFsSeed } from "../test-utils/fake-sftp-fs";
import {
  TEST_PASSWORD as PASSWORD,
  fixtureDevice,
  trustedHostKey,
  withFakeServer,
} from "../test-utils/ssh-fixtures";
import { sshPool } from "../ssh/pool";
import { JsonBodyError } from "./request";
import type { SshFileEntry } from "../ssh/remote-files";
import { handleSshRoutes } from "./handlers/ssh";

const APP: SshRemoteDir = { id: "app", name: "应用目录", path: "/srv/app" };

/** 直接喂 handleSshRoutes:路由表本身在 server.ts,鉴权闸另有 api/auth.test.ts 覆盖。 */
async function call(method: string, pathWithQuery: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1/api/${pathWithQuery}`);
  const request = new Request(url, { method, ...init });
  return handleSshRoutes(request, url, url.pathname.slice("/api/".length));
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function jsonBody(body: Record<string, unknown>): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 面板查询串:用例只改自己要试的字段。 */
function panelQuery(patch: Record<string, string> = {}): string {
  return query({ deviceId: "dev", dirId: "app", path: "", ...patch });
}

async function bodyOf(res: Response | null): Promise<Record<string, unknown>> {
  if (!res) throw new Error("路由交回了 null(不该发生)");
  return (await res.json()) as Record<string, unknown>;
}

/** 一条文件路径的查询串 + 断言状态码,回载荷:拒类用例写起来短一半。 */
async function expectStatus(method: string, path: string, status: number): Promise<Record<string, unknown>> {
  const res = await call(method, path);
  expect(res?.status).toBe(status);
  return await bodyOf(res);
}

const SEED: FakeFsSeed = {
  "/srv/app/a.txt": "hello",
  "/srv/app/doc.pdf": "%PDF-1.4 远程报告",
  "/srv/app/REPORT.PDF": "%PDF-1.4 大写后缀",
  "/srv/app/sub/keep.txt": "在子目录里",
};

/** 起假服务器 + 把带授权目录的设备条目放进 settings(文件路由只认这一份)。 */
async function withPanel<T>(run: (server: FakeSshServer, device: SshDevice) => Promise<T>): Promise<T> {
  return withFakeServer({ password: PASSWORD, fsSeed: SEED }, async (server) => {
    const device: SshDevice = { ...fixtureDevice({ dirs: [APP] }, server.port), hostKey: trustedHostKey(server) };
    const previous = state.settings.sshDevices;
    state.settings = { ...state.settings, sshDevices: [device] };
    try {
      return await run(server, device);
    } finally {
      sshPool.close(device.id);
      state.settings = { ...state.settings, sshDevices: previous ?? [] };
    }
  });
}

// 测试进程没跑 loadState,按 api/auth.test.ts 的惯例注入最小 state(路由第一行就读 settings)。
const priorState = state;
beforeAll(() => setState({ settings: { sshDevices: [] } } as unknown as State));
afterAll(async () => {
  await flushSaveState();
  setState(priorState);
});

describe("参数来路与设备边界", () => {
  test("GET 走查询串、PUT 走 JSON 体、upload 走 multipart:三处字段名一致", async () => {
    await withPanel(async (server) => {
      const listed = await expectStatus("GET", `ssh/files?${panelQuery()}`, 200);
      // 目录在前、名字按小写排(与安卓端 compareBy{!isDirectory}.thenBy 同序)。
      expect((listed.entries as SshFileEntry[]).map((item) => item.name)).toEqual(["sub", "a.txt", "doc.pdf", "REPORT.PDF"]);

      // PUT 的 path/content 只从体里取:内容里带 & 与 # 时查询串会把它们吃掉。
      const written = await call("PUT", "ssh/files/content", jsonBody({
        deviceId: "dev",
        dirId: "app",
        path: "from-body.txt",
        content: "a&b#c",
      }));
      expect(written?.status).toBe(200);
      expect((await bodyOf(written)).entry).toMatchObject({ path: "from-body.txt", size: 5 });
      expect(server.fs.read("/srv/app/from-body.txt")).toBe("a&b#c");

      const form = new FormData();
      form.set("deviceId", "dev");
      form.set("dirId", "app");
      form.set("path", "sub");
      form.set("file", new File([new Uint8Array([1, 2, 3])], "three.bin"));
      const uploaded = await call("POST", "ssh/files/upload", { method: "POST", body: form });
      expect(uploaded?.status).toBe(200);
      expect((await bodyOf(uploaded)).entry).toMatchObject({ path: "sub/three.bin", type: "file", size: 3 });

      // 三条来路打在同一个设备上只握一次手(池在路由这一侧生效)。
      expect(server.connections).toBe(1);
      expect(server.authenticated).toBe(1);
    });
  });

  test("表单不是 multipart、JSON 体是坏的:都算用户可改的输入,不是 502", async () => {
    await withPanel(async (server) => {
      const wrongType = await call("POST", "ssh/files/upload", jsonBody({ deviceId: "dev", dirId: "app" }));
      expect(wrongType?.status).toBe(400);
      expect((await bodyOf(wrongType)).errorCode).toBe("ssh.file_required");

      // 坏 JSON 交回 router 的统一映射(400):在 handler 里被 sshFailure 吞掉就成了 502「远端失败」。
      await expect(call("PUT", "ssh/files/content", {
        headers: { "Content-Type": "application/json" },
        body: "{不是 JSON",
      })).rejects.toBeInstanceOf(JsonBodyError);
      // 两条都停在取参阶段:一个字节都没往网络上发。
      expect(server.connections).toBe(0);
    });
  });

  test("文件路由不接受内联草稿: deviceId 不在 settings 里就 404，body 里带 device 也一样", async () => {
    await withPanel(async (server) => {
      const draft = { id: "dev", host: "127.0.0.1", username: "tester", password: PASSWORD, dirs: [APP] };
      const byBody = await call("PUT", "ssh/files/content", jsonBody({
        device: draft,
        deviceId: "ghost",
        dirId: "app",
        path: "x.txt",
        content: "x",
      }));
      expect(byBody?.status).toBe(404);
      expect((await bodyOf(byBody)).errorCode).toBe("ssh.device_not_found");
      // 查询串那两条同样只认已保存条目。
      expect((await call("GET", `ssh/files?${panelQuery({ deviceId: "ghost" })}`))?.status).toBe(404);
      expect(server.connections).toBe(0);
    });
  });

  test("授权边界在连网之前:未登记目录 403、越界路径 403，且都不产生连接", async () => {
    await withPanel(async (server) => {
      expect((await expectStatus("GET", `ssh/files?${panelQuery({ dirId: "nope" })}`, 403)).errorCode).toBe("ssh.dir_unauthorized");
      expect((await expectStatus("GET", `ssh/files?${panelQuery({ path: "../etc/passwd" })}`, 403)).errorCode).toBe("ssh.path_escape");
      expect((await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "../etc/passwd" })}`, 403)).errorCode).toBe("ssh.path_escape");
      expect(server.connections).toBe(0);
    });
  });

  test("没认领的 ssh/files/* 交回路由层", async () => {
    await withPanel(async () => {
      expect(await call("GET", `ssh/files/whatever?${panelQuery()}`)).toBeNull();
    });
  });
});

describe("列表与预览", () => {
  test("GET ssh/files 回条目 + 命中的授权目录条目本身", async () => {
    await withPanel(async (server) => {
      const body = await expectStatus("GET", `ssh/files?${panelQuery({ path: "sub" })}`, 200);
      // 回的是登记条目(id 而不是路径),前端之后所有请求都拿这个 id。
      expect(body.dir).toEqual(APP);
      expect(body.path).toBe("sub");
      const entries = body.entries as SshFileEntry[];
      // path 是相对「授权目录」而不是相对当前浏览目录:前端把两者拼起来就是下次请求的 path 参数。
      expect(entries.map((item) => item.path)).toEqual(["sub/keep.txt"]);
      expect(entries[0]).toMatchObject({ name: "keep.txt", type: "file", size: Buffer.from("在子目录里", "utf8").byteLength });
      expect(entries[0]!.modifiedAt % 1000).toBe(0);
      expect(server.connections).toBe(1);
    });
  });

  test("GET ssh/files/content 回 WorkspaceFilePreview 同形载荷", async () => {
    await withPanel(async () => {
      const body = await expectStatus("GET", `ssh/files/content?${panelQuery({ path: "a.txt" })}`, 200);
      expect(body.preview).toEqual({ kind: "text", text: "hello", truncated: false, size: 5 });
    });
  });

  test("读不存在回 400 path_missing，读目录回 400 not_a_file:与本地面板一样是「可改的输入」", async () => {
    await withPanel(async () => {
      expect((await expectStatus("GET", `ssh/files/content?${panelQuery({ path: "ghost.txt" })}`, 400)).errorCode).toBe("ssh.path_missing");
      expect((await expectStatus("GET", `ssh/files?${panelQuery({ path: "a.txt" })}`, 400)).errorCode).toBe("ssh.not_a_directory");
    });
  });
});

describe("raw 下载", () => {
  test("只有 PDF 允许 inline，大小写后缀都算；其余一律 attachment", async () => {
    await withPanel(async () => {
      const pdf = await call("GET", `ssh/files/raw?${panelQuery({ path: "doc.pdf" })}`);
      expect(pdf?.headers.get("Content-Type")).toBe("application/pdf");
      expect(pdf?.headers.get("Content-Disposition")).toBe('inline; filename="doc.pdf"');
      expect(pdf?.headers.get("Cache-Control")).toBe("no-store");
      expect(await pdf?.text()).toContain("远程报告");

      const upper = await call("GET", `ssh/files/raw?${panelQuery({ path: "REPORT.PDF" })}`);
      expect(upper?.headers.get("Content-Disposition")).toBe('inline; filename="REPORT.PDF"');

      const text = await call("GET", `ssh/files/raw?${panelQuery({ path: "sub/keep.txt" })}`);
      // 文本类要带 charset:否则界面按本地编码(Windows 上是 GBK)解,中文变问号。
      expect(text?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(text?.headers.get("Content-Disposition")).toBe('attachment; filename="keep.txt"');
    });
  });

  test("download=1 把 PDF 也压成附件", async () => {
    await withPanel(async () => {
      const res = await call("GET", `ssh/files/raw?${panelQuery({ path: "doc.pdf", download: "1" })}`);
      expect(res?.headers.get("Content-Disposition")).toBe('attachment; filename="doc.pdf"');
    });
  });

  test("远端文件名进响应头前先洗掉引号、反斜杠与换行", async () => {
    await withPanel(async () => {
      // 远端可以有这种名字(Windows 主机尤其常见);不洗的话就是响应头注入面。
      const dirty = 'we"ird\\na\rme.txt';
      const written = await call("PUT", "ssh/files/content", jsonBody({
        deviceId: "dev",
        dirId: "app",
        path: dirty,
        content: "x",
      }));
      expect(written?.status).toBe(200);
      const res = await call("GET", `ssh/files/raw?${panelQuery({ path: dirty })}`);
      expect(res?.headers.get("Content-Disposition")).toBe('attachment; filename="weirdname.txt"');
    });
  });

  test("目录与不存在的目标都是 400，不是 500", async () => {
    await withPanel(async () => {
      expect((await expectStatus("GET", `ssh/files/raw?${panelQuery({ path: "sub" })}`, 400)).errorCode).toBe("ssh.not_a_file");
      expect((await expectStatus("GET", `ssh/files/raw?${panelQuery({ path: "ghost.bin" })}`, 400)).errorCode).toBe("ssh.path_missing");
    });
  });
});

describe("写入、上传与删除", () => {
  test("PUT 写文本：落盘、回条目，父目录自动长出来", async () => {
    await withPanel(async (server) => {
      const body = await call("PUT", "ssh/files/content", jsonBody({
        deviceId: "dev",
        dirId: "app",
        path: "deep/note.md",
        content: "# 标题\n正文",
      }));
      expect(body?.status).toBe(200);
      expect((await bodyOf(body)).entry).toMatchObject({ path: "deep/note.md", name: "note.md", type: "file" });
      expect(server.fs.read("/srv/app/deep/note.md")).toBe("# 标题\n正文");
    });
  });

  test("overwrite 默认 true(编辑器保存就是有意覆盖)，显式 false 撞车才拒", async () => {
    await withPanel(async (server) => {
      const over = await call("PUT", "ssh/files/content", jsonBody({
        deviceId: "dev",
        dirId: "app",
        path: "a.txt",
        content: "换过了",
      }));
      expect(over?.status).toBe(200);
      expect(server.fs.read("/srv/app/a.txt")).toBe("换过了");

      const clash = await call("PUT", "ssh/files/content", jsonBody({
        deviceId: "dev",
        dirId: "app",
        path: "a.txt",
        content: "不该覆盖",
        overwrite: false,
      }));
      expect(clash?.status).toBe(400);
      expect((await bodyOf(clash)).errorCode).toBe("ssh.already_exists");
      expect(server.fs.read("/srv/app/a.txt")).toBe("换过了");
    });
  });

  test("缺 content 是 400 而不是把空串写下去", async () => {
    await withPanel(async (server) => {
      const res = await call("PUT", "ssh/files/content", jsonBody({ deviceId: "dev", dirId: "app", path: "empty.txt" }));
      expect(res?.status).toBe(400);
      expect(server.fs.exists("/srv/app/empty.txt")).toBe(false);
    });
  });

  test("upload 同名不覆盖：按安卓端格式改名 (1)", async () => {
    await withPanel(async (server) => {
      const form = new FormData();
      form.set("deviceId", "dev");
      form.set("dirId", "app");
      form.set("path", "");
      form.set("file", new File(["第二份"], "a.txt"));
      const res = await call("POST", "ssh/files/upload", { method: "POST", body: form });
      expect((await bodyOf(res)).entry).toMatchObject({ path: "a (1).txt", size: Buffer.from("第二份", "utf8").byteLength });
      expect(server.fs.read("/srv/app/a (1).txt")).toBe("第二份");
      // 原来那份没被动过。
      expect(server.fs.read("/srv/app/a.txt")).toBe("hello");
    });
  });

  test("表单里 file 字段缺失或不是文件 → 400 ssh.file_required", async () => {
    await withPanel(async (server) => {
      const form = new FormData();
      form.set("deviceId", "dev");
      form.set("dirId", "app");
      form.set("file", "只是个字符串");
      const res = await call("POST", "ssh/files/upload", { method: "POST", body: form });
      expect(res?.status).toBe(400);
      expect((await bodyOf(res)).errorCode).toBe("ssh.file_required");
      expect(server.connections).toBe(0);
    });
  });

  test("DELETE 回 boolean 而不是 204：目标本就不存在也算删成功", async () => {
    await withPanel(async (server) => {
      expect(await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "a.txt" })}`, 200)).toEqual({ deleted: true });
      expect(server.fs.exists("/srv/app/a.txt")).toBe(false);
      expect(await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "ghost.txt" })}`, 200)).toEqual({ deleted: false });
    });
  });

  test("删目录要 recursive，删授权目录本身永远拒", async () => {
    await withPanel(async (server) => {
      expect((await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "sub" })}`, 400)).errorCode).toBe("ssh.recursive_required");
      expect((await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "sub", recursive: "1" })}`, 200)).deleted).toBe(true);
      expect(server.fs.exists("/srv/app/sub")).toBe(false);
      for (const path of ["", "."]) {
        expect((await expectStatus("DELETE", `ssh/files?${panelQuery({ path })}`, 400)).errorCode).toBe("ssh.root_delete");
      }
    });
  });
});

describe("连接复用", () => {
  test("面板上一轮操作(列目录→预览→读原文→写→删)只握一次手", async () => {
    await withPanel(async (server) => {
      await expectStatus("GET", `ssh/files?${panelQuery()}`, 200);
      await expectStatus("GET", `ssh/files/content?${panelQuery({ path: "a.txt" })}`, 200);
      // raw 回的是字节,不能当 JSON 读:这里只看状态码。
      expect((await call("GET", `ssh/files/raw?${panelQuery({ path: "doc.pdf" })}`))?.status).toBe(200);
      await call("PUT", "ssh/files/content", jsonBody({ deviceId: "dev", dirId: "app", path: "b.txt", content: "b" }));
      await expectStatus("DELETE", `ssh/files?${panelQuery({ path: "b.txt" })}`, 200);
      // 对齐前 rdp 每条请求都重连:一次浏览十几次握手,服务器还会把它当爆破。
      expect(server.connections).toBe(1);
      expect(server.authenticated).toBe(1);
    });
  });
});
