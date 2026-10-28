// api/handlers/workspaces-ssh.test.ts — 工作区 HTTP 层的 ssh 面(界面唯一的入口)
//
// 单元层(workspace/*.test.ts)验的是领域函数;这一层验的是"路由把领域结果变成什么给界面":
// 1) 绑定只吃两个 id(sshDeviceId/sshDirId),root 由设置派生后回显;响应里绝不带凭据——
//    DTO 是从工作区行直接展开的,一旦有人把设备条目塞进去,这条就是最后一道闸。
// 2) 列表页/详情页不探网络:整份测试不起假服务器也能过,等价于"任何一次 GET/POST 都没发过 TCP"。
//    远程连通性是工具与提示词层的事,列个表格不该把一次握手算进渲染时间。
// 3) 本机文件面板与 AGENTS.md 路由对 ssh 型按码拒绝(ssh.use_remote_file_routes /
//    ssh.agents_file_unsupported):它们的 root 在那台机器上,拿本机 fs 去走只会报"目录不存在",
//    那是把两台机器混为一谈的误导错误。界面按码引导到 SSH 文件面板。
// 4) 领域层的带码错误经 workspaceError 落到 400 + errorCode(界面按 errors.<code> 查文案)。

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../../foundation/types";
import type { SshDevice, SshRemoteDir } from "../../foundation/types/settings";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ws-ssh-http-"));

const conversations = await import("../../conversations");
const ws = await import("../../workspace/index");
// state 用命名空间取(store.state):json-store 的 `export let state` 在解构导入时只是
// 装载前的快照,读不到 setState 之后的值。
const store = await import("../../persistence/json-store");
const { setState } = store;
const { handleWorkspaceRoutes } = await import("./workspaces");
const { TEST_PASSWORD, fixtureDevice } = await import("../../test-utils/ssh-fixtures");

conversations.openConversationsDb();

const APP: SshRemoteDir = { id: "app", name: "应用目录", path: "/srv/app" };
const WEB: SshRemoteDir = { id: "web", name: "站点目录", path: "/srv/web" };
const HOST_KEY = { type: "ssh-ed25519", key: "AAAAB3NzaC1yc2", fingerprint: "SHA256:test" };
type Body = Record<string, unknown>;

/** 已确认主机密钥、授权两条远程目录的设备;端口 22 是装的——本文件从不建连。 */
function device(patch: Partial<SshDevice> = {}): SshDevice {
  return fixtureDevice({ hostKey: HOST_KEY, dirs: [APP, WEB], port: 22, ...patch });
}

function withDevices(devices: SshDevice[]): SshDevice[] {
  setState({ settings: { sshDevices: devices } } as unknown as State);
  return devices;
}

/** 打一次工作区路由(带不带 body 都走这条),拆成 {status, body} 便于断言。 */
async function api(
  method: string,
  path = "workspaces",
  opts: { query?: string; body?: Body } = {},
): Promise<{ status: number; body: Body }> {
  const url = new URL(`http://127.0.0.1/api/${path}${opts.query ? `?${opts.query}` : ""}`);
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  const response = await handleWorkspaceRoutes(new Request(url, init), url, path);
  if (!response) return { status: 404, body: { error: "route not handled" } };
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Body) : {} };
}

const get = (id: string) => api("GET", `workspaces/${id}`);
const workspacesOf = (body: Body) => body.workspaces as Body[];
const idOf = (response: { body: Body }) => (response.body.workspace as { id: string }).id;

/** POST /api/workspaces 的 ssh 形态;前置:设备已注入设置。 */
async function createSsh(sshDeviceId: string, sshDirId = "app", extra: Body = {}) {
  const created = await api("POST", "workspaces", { body: { type: "ssh", sshDeviceId, sshDirId, ...extra } });
  expect(created.status).toBe(200);
  return created;
}

describe("创建与读取 ssh 工作区", () => {
  test("只传两个 id:root 由设置派生,创建即信任,status=ready,sshTarget 是 user@host:port", async () => {
    const dev = withDevices([device({ id: "http-dev-1" })])[0];
    const created = await createSsh(dev.id);
    const workspace = created.body.workspace as Body;
    expect(workspace.type).toBe("ssh");
    expect(workspace.root).toBe("/srv/app");
    expect(workspace.sshDeviceId).toBe(dev.id);
    expect(workspace.sshDirId).toBe("app");
    expect(workspace.trustedAt).not.toBeNull();
    expect(workspace.status).toBe("ready");
    expect(workspace.unavailableReason).toBeNull();
    expect(workspace.sshTarget).toBe("tester@127.0.0.1:22");
    // 凭据纪律:响应体是界面直接渲染的 JSON,密码/私钥/passphrase 连字段名都不该出现。
    const payload = JSON.stringify(created.body);
    expect(payload).not.toContain(TEST_PASSWORD);
    expect(payload).not.toMatch(/"(password|privateKey|passphrase)"/);
  });

  test("列表页每行都带绑定解释,且整份列表不探网络(设备端口写 22 也没连过一次)", async () => {
    const dev = withDevices([device({ id: "http-dev-2", port: 22 })])[0];
    await createSsh(dev.id, "web");
    const listed = await api("GET");
    expect(listed.status).toBe(200);
    const sshRow = workspacesOf(listed.body).find((row) => row.type === "ssh");
    expect(sshRow?.root).toBe("/srv/web");
    expect(sshRow?.status).toBe("ready");
    expect(sshRow?.sshTarget).toBe("tester@127.0.0.1:22");
    expect(JSON.stringify(listed.body)).not.toContain(TEST_PASSWORD);
  });

  test("设备不存在 / 目录没授权:400 + 精确 errorCode(界面按码查文案,不靠中文)", async () => {
    const dev = withDevices([device({ id: "http-dev-3", dirs: [APP, { id: "draft", name: "", path: "  " }] })])[0];
    const cases: Array<{ patch: Body; code: string }> = [
      { patch: { sshDeviceId: "nope" }, code: "ssh.binding_device_missing" },
      { patch: { sshDirId: "gone" }, code: "ssh.binding_dir_unauthorized" },
      { patch: { sshDirId: "draft" }, code: "ssh.binding_path_invalid" },
      { patch: { sshDeviceId: "", sshDirId: "" }, code: "ssh.binding_dir_unauthorized" },
    ];
    for (const item of cases) {
      const response = await api("POST", "workspaces", {
        body: { type: "ssh", sshDeviceId: dev.id, sshDirId: "app", ...item.patch },
      });
      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe(item.code);
      expect(String(response.body.error)).not.toContain(TEST_PASSWORD);
    }
  });

  test("主机密钥没确认:创建被拒;建好后取消确认 → 记录留着、状态 missing、同一枚码", async () => {
    const untrusted = { ...device({ id: "http-dev-4" }), hostKey: null };
    withDevices([untrusted]);
    const refused = await api("POST", "workspaces", { body: { type: "ssh", sshDeviceId: untrusted.id, sshDirId: "app" } });
    expect(refused.status).toBe(400);
    expect(refused.body.errorCode).toBe("ssh.binding_host_key_unconfirmed");

    withDevices([{ ...untrusted, hostKey: HOST_KEY }]);
    const id = idOf(await createSsh(untrusted.id));

    // 用户撤销确认(换了台机器):工作区不可用,但记录不静默删,root 仍是设置派生出来的那份。
    withDevices([untrusted]);
    const workspace = (await get(id)).body.workspace as Body;
    expect(workspace.status).toBe("missing");
    expect(workspace.unavailableErrorCode).toBe("ssh.binding_host_key_unconfirmed");
    expect(workspace.root).toBe("/srv/app");
  });
});

describe("ssh 工作区拒绝本机文件路由", () => {
  test("files* 与 agents-file 一律 400 + 各自码,不给「目录不存在」那种误导文案", async () => {
    const dev = withDevices([device({ id: "http-dev-5" })])[0];
    const id = idOf(await createSsh(dev.id));
    const cases: Array<{ method: string; sub?: string; query?: string; code: string }> = [
      { method: "GET", sub: "files", code: "ssh.use_remote_file_routes" },
      { method: "DELETE", sub: "files", query: "path=notes.md", code: "ssh.use_remote_file_routes" },
      { method: "GET", sub: "files/content", query: "path=notes.md", code: "ssh.use_remote_file_routes" },
      { method: "PUT", sub: "files/content", query: "path=notes.md", code: "ssh.use_remote_file_routes" },
      { method: "GET", sub: "files/raw", query: "path=a.pdf", code: "ssh.use_remote_file_routes" },
      { method: "POST", sub: "files/rename", code: "ssh.use_remote_file_routes" },
      { method: "POST", sub: "files/reveal", code: "ssh.use_remote_file_routes" },
      { method: "GET", sub: "agents-file", code: "ssh.agents_file_unsupported" },
      { method: "PUT", sub: "agents-file", code: "ssh.agents_file_unsupported" },
    ];
    for (const item of cases) {
      // 写类路由一个 body 都不给:拒绝发生在读 body 之前,越界的路径根本不进本机 fs。
      const response = await api(item.method, `workspaces/${id}${item.sub ? `/${item.sub}` : ""}`, { query: item.query });
      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe(item.code);
      // 本机 fs 的报错("不存在")不该出现:这台机器上确实没有 /srv/app,但那不是要告诉用户的理由。
      expect(String(response.body.error)).not.toMatch(/no such file|does not exist|不存在/i);
    }
  });

  test("删除走同一条 DELETE 路由:204 后记录消失,目录授权仍留在设置里", async () => {
    const dev = withDevices([device({ id: "http-dev-6" })])[0];
    const id = idOf(await createSsh(dev.id));
    expect((await api("DELETE", `workspaces/${id}`)).status).toBe(204);
    expect(ws.getWorkspace(id)).toBeNull();
    expect((await get(id)).status).toBe(404);
    // 撤销授权是「拓展 › SSH」的事,删工作区不动它。
    expect(store.state.settings?.sshDevices).toHaveLength(1);
    expect(store.state.settings?.sshDevices?.[0]?.dirs).toHaveLength(2);
  });

  test("换绑:被占用的目录由领域层拒(带中文原因给界面);腾开之后 root 同步且信任门不重置", async () => {
    const dev = withDevices([device({ id: "http-dev-7" })])[0];
    const appWorkspace = await createSsh(dev.id, "app");
    const appId = idOf(appWorkspace);
    const webId = idOf(await createSsh(dev.id, "web"));

    const conflict = await api("PATCH", `workspaces/${webId}`, { body: { sshDeviceId: dev.id, sshDirId: "app" } });
    expect(conflict.status).toBe(400);
    expect(String(conflict.body.error)).toContain("已绑定");
    expect((await get(appId)).body.workspace).toBeTruthy();

    // 腾开 app(删掉占着它的工作区)后换绑成功:root 跟着同步,trustedAt 不被重置。
    expect((await api("DELETE", `workspaces/${appId}`)).status).toBe(204);
    const before = (await get(webId)).body.workspace as Body;
    const moved = await api("PATCH", `workspaces/${webId}`, { body: { sshDeviceId: dev.id, sshDirId: "app" } });
    const workspace = moved.body.workspace as Body;
    expect(moved.status).toBe(200);
    expect(workspace.root).toBe("/srv/app");
    expect(workspace.sshDirId).toBe("app");
    expect(workspace.trustedAt).toBe(before.trustedAt);
    // 空 body 的 PATCH 不改绑定(界面只改名字时也走这条路由)。
    const renamed = await api("PATCH", `workspaces/${webId}`, { body: { name: "改个名" } });
    expect((renamed.body.workspace as Body).root).toBe("/srv/app");
    expect((renamed.body.workspace as Body).name).toBe("改个名");
  });
});
