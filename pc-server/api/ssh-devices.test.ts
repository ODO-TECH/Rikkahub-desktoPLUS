// api/ssh-devices.test.ts — 拓展›SSH 的设备归一、凭据校验与路由写边界。
// 只测纯函数与不触网的路径(400/404/CRUD/排序);连接测试与命令执行需要真 SSH 服务,
// 由人工验证,单元层不 mock ssh2(避免把连接语义测成假绿)。
//
// 语义分两层:保存是自动保存的写边界,允许半成品草稿(逐键落库);测试/执行是连接边界,
// 才要求 host / username / 凭据齐全。二者混同会让"输入到一半"变成一条失败 toast。

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-ssh-devices-test-"));

import type { State } from "../foundation/types";
import type { SshDevice } from "../foundation/types/settings";
import { setState, state } from "../persistence/json-store";
import { normalizeSshDevices, parseSshDevice, sshCredentialError } from "../ssh/devices";
import { handleSshRoutes } from "./handlers/ssh";

async function call(method: string, path: string, body?: unknown): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1/api/${path}`);
  const request = new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleSshRoutes(request, url, path);
}

function saved(): SshDevice[] {
  return state.settings.sshDevices;
}

let nextId = 0;
const fixedId = () => `generated-${++nextId}`;

beforeAll(() => {
  setState({ settings: { sshDevices: [] } } as unknown as State);
});

describe("parseSshDevice", () => {
  test("非对象丢弃;host / username 允许为空(半成品草稿要能逐键落库)", () => {
    expect(parseSshDevice(null)).toBeNull();
    expect(parseSshDevice("x")).toBeNull();
    expect(parseSshDevice({ username: "root" }, fixedId)).toMatchObject({ host: "", username: "root" });
    expect(parseSshDevice({ host: "10.0.0.2" }, fixedId)).toMatchObject({ host: "10.0.0.2", username: "" });
    expect(parseSshDevice({ host: "   ", username: "  " }, fixedId)).toMatchObject({ host: "", username: "" });
  });

  test("缺省与非法字段收敛:name 原样(空则空)、端口回退 22、认证回退 password", () => {
    const device = parseSshDevice(
      { host: " 10.0.0.2 ", username: " root ", port: 70000, authType: "agent" },
      fixedId,
    )!;
    expect(device.id).toMatch(/^generated-\d+$/);
    expect(device.host).toBe("10.0.0.2");
    expect(device.username).toBe("root");
    expect(device.name).toBe("");
    expect(device.port).toBe(22);
    expect(device.authType).toBe("password");
    expect(device.password).toBe("");
    expect(device.privateKey).toBe("");
    expect(device.passphrase).toBe("");
  });

  test("合法端口保留;凭据原文本不修剪(私钥首尾空白与口令空格有语义)", () => {
    const device = parseSshDevice(
      {
        host: "example.com",
        username: "deploy",
        name: "  生产机 ",
        port: "2222",
        authType: "key",
        password: " spaced ",
        privateKey: "\n-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
        passphrase: " pa ss ",
      },
      fixedId,
    )!;
    expect(device.name).toBe("生产机");
    expect(device.port).toBe(2222);
    expect(device.authType).toBe("key");
    expect(device.password).toBe(" spaced ");
    expect(device.privateKey).toContain("\n-----BEGIN KEY-----");
    expect(device.privateKey.endsWith("\n")).toBe(true);
    expect(device.passphrase).toBe(" pa ss ");
  });
});

describe("sshCredentialError", () => {
  const base: SshDevice = {
    id: "a",
    name: "a",
    host: "h",
    port: 22,
    username: "u",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
  };

  test("密码认证要非空密码(空格算内容)", () => {
    expect(sshCredentialError(base)).toBe("password");
    expect(sshCredentialError({ ...base, password: " " })).toBeNull();
  });

  test("密钥认证要非空私钥(纯空白不算)", () => {
    const keyAuth = { ...base, authType: "key" as const };
    expect(sshCredentialError(keyAuth)).toBe("key");
    expect(sshCredentialError({ ...keyAuth, privateKey: "  \n " })).toBe("key");
    expect(sshCredentialError({ ...keyAuth, privateKey: "-----BEGIN" })).toBeNull();
  });
});

describe("normalizeSshDevices", () => {
  test("非数组 → 空;整条空白的脏记录丢弃,有空名称的草稿保留", () => {
    expect(normalizeSshDevices(undefined)).toEqual([]);
    expect(normalizeSshDevices({})).toEqual([]);
    expect(normalizeSshDevices([null, 1, "x", {}])).toEqual([]);
    expect(normalizeSshDevices([{ name: "草稿" }])).toHaveLength(1);
  });

  test("有效条目保留并补 id", () => {
    const list = normalizeSshDevices([
      { id: "keep", host: "a", username: "root" },
      { host: "b", username: "root" },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe("keep");
    expect(list[1]!.id).toBeTruthy();
    expect(list[1]!.host).toBe("b");
  });
});

describe("SSH 路由写边界", () => {
  const valid = {
    id: "dev-1",
    name: "测试机",
    host: "10.0.0.9",
    username: "root",
    authType: "password",
    password: "secret",
  };

  test("三项全空 → 400,不落库", async () => {
    expect((await call("POST", "ssh/device", {}))?.status).toBe(400);
    expect(saved()).toEqual([]);
  });

  test("半成品草稿可保存;凭据/地址不齐只拦连接,不发连接", async () => {
    const res = await call("POST", "ssh/device", { id: "draft", name: "草稿" });
    expect(res?.status).toBe(200);
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({ id: "draft", name: "草稿", host: "", port: 22 });
    // 连接边界:缺 host/username → 400(若漏校验会尝试连接,测试会挂到超时)。
    expect((await call("POST", "ssh/test", { deviceId: "draft" }))?.status).toBe(400);
    expect((await call("POST", "ssh/exec", { deviceId: "draft", command: "uname -a" }))?.status).toBe(400);
  });

  test("新建完整设备 → 默认端口 22;凭据不全会由连接边界拦下,不影响保存", async () => {
    const res = await call("POST", "ssh/device", { ...valid, name: undefined, port: undefined, password: "" });
    expect(res?.status).toBe(200);
    expect(saved()).toHaveLength(2);
    expect(saved()[1]).toMatchObject({ id: "dev-1", name: "", port: 22, password: "" });
    expect(saved()[1]!.host).toBe("10.0.0.9");
    expect((await call("POST", "ssh/test", { deviceId: "dev-1" }))?.status).toBe(400);
  });

  test("同 id 再提交是更新而非追加", async () => {
    await call("POST", "ssh/device", { ...valid, id: "dev-1", name: "改名", port: 2200 });
    expect(saved()).toHaveLength(2);
    expect(saved().find((item) => item.id === "dev-1")).toMatchObject({ name: "改名", port: 2200 });
  });

  test("未保存的内联 draft:缺地址 → 400(不是 404)", async () => {
    const res = await call("POST", "ssh/test", { device: { name: "临时", username: "root", password: "x" } });
    expect(res?.status).toBe(400);
  });

  test("未知 deviceId → 404;空命令先被 400 拦下", async () => {
    expect((await call("POST", "ssh/test", { deviceId: "nope" }))?.status).toBe(404);
    expect((await call("POST", "ssh/exec", { deviceId: "nope", command: "  " }))?.status).toBe(400);
    expect((await call("POST", "ssh/exec", { deviceId: "nope", command: "uname -a" }))?.status).toBe(404);
  });

  test("排序:已知 id 按请求顺序,未知 id 忽略,漏掉的追加在后", async () => {
    await call("POST", "ssh/device", { ...valid, id: "dev-2", host: "10.0.0.10" });
    await call("POST", "ssh/device", { ...valid, id: "dev-3", host: "10.0.0.11" });
    await call("POST", "ssh/reorder", { ids: ["dev-3", "ghost", "dev-1"] });
    expect(saved().map((item) => item.id)).toEqual(["dev-3", "dev-1", "draft", "dev-2"]);
  });

  test("删除按 id,重复删除幂等", async () => {
    expect((await call("DELETE", "ssh/device/dev-1"))?.status).toBe(200);
    expect(saved().map((item) => item.id)).toEqual(["dev-3", "draft", "dev-2"]);
    expect((await call("DELETE", "ssh/device/dev-1"))?.status).toBe(200);
    expect(saved()).toHaveLength(3);
  });

  test("未知路径交回路由层", async () => {
    expect(await call("GET", "ssh/device")).toBeNull();
  });
});
