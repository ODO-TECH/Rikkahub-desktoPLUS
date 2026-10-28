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
import {
  findRemoteDir,
  normalizeSshDevices,
  parseSshDevice,
  sshConnectionSignature,
  sshCredentialError,
  sshDeviceInputError,
  usableRemoteDirs,
} from "../ssh/devices";
import { encodeHostKey } from "../ssh/host-key";
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

/** 造一把合法的 ed25519 公钥 blob:长度前缀算法名 + 长度前缀 32 字节密钥。 */
function ed25519Blob(seed = "aaaaaaaa"): Buffer {
  const type = Buffer.from("ssh-ed25519", "ascii");
  const key = Buffer.alloc(32);
  key.write(seed.padEnd(32, ".").slice(0, 32), "ascii");
  const blob = Buffer.alloc(4 + type.length + 4 + key.length);
  let offset = 0;
  blob.writeUInt32BE(type.length, offset);
  offset += 4;
  type.copy(blob, offset);
  offset += type.length;
  blob.writeUInt32BE(key.length, offset);
  offset += 4;
  key.copy(blob, offset);
  return blob;
}

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
    hostKey: null,
    dirs: [],
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

// 主机密钥与授权目录是这次对齐新增的两个写边界,单独成组测,免得混在凭据用例里看不清在验什么。
describe("parseSshDevice 主机密钥与授权目录", () => {
  test("指纹按 blob 重算:客户端回传什么都不能信", () => {
    const trusted = encodeHostKey(ed25519Blob())!;
    const device = parseSshDevice({
      host: "h",
      username: "u",
      hostKey: { type: trusted.type, key: trusted.key, fingerprint: "SHA256:伪造的" },
    }, fixedId)!;
    expect(device.hostKey).toEqual(trusted);
    expect(device.hostKey!.fingerprint).not.toBe("SHA256:伪造的");
    expect(device.hostKey!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test("解不开的 hostKey 当未信任(null),而不是带着坏条目去连", () => {
    expect(parseSshDevice({ host: "h", hostKey: { type: "ssh-ed25519", key: "!!!" } }, fixedId)!.hostKey).toBeNull();
    expect(parseSshDevice({ host: "h", hostKey: { type: "", key: "" } }, fixedId)!.hostKey).toBeNull();
    expect(parseSshDevice({ host: "h", hostKey: "字符串" }, fixedId)!.hostKey).toBeNull();
    // blob 与 type 对不上(拿 rsa 的 blob 冒充 ed25519)同样拒绝。
    const blob = ed25519Blob("bbbbbbbb");
    expect(parseSshDevice({
      host: "h",
      hostKey: { type: "ssh-rsa", key: blob.toString("base64") },
    }, fixedId)!.hostKey).toBeNull();
  });

  test("目录路径归一;半填的相对路径原样留着,由使用处报错而不是入口吞掉整行", () => {
    const device = parseSshDevice({
      host: "h",
      dirs: [
        { id: "d1", name: " 编译机 ", path: "/srv/app//" },
        { id: "d2", path: "var/log" },
        { id: "d3", path: "" },
        { id: "d4", path: "\\\\server\\share" },
        "不是对象",
      ],
    }, fixedId)!;
    expect(device.dirs.map((dir) => dir.path)).toEqual(["/srv/app", "var/log", "", "/server/share"]);
    expect(device.dirs.map((dir) => dir.name)).toEqual(["编译机", "", "", ""]);
    expect(device.dirs).toHaveLength(4);
  });

  test("目录 id 缺失或重复时补新 id(界面按 id 绑定,重复会让 React key 撞车)", () => {
    const device = parseSshDevice({
      host: "h",
      dirs: [{ id: "same", path: "/a" }, { id: "same", path: "/b" }, { path: "/c" }],
    }, fixedId)!;
    const ids = device.dirs.map((dir) => dir.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("same");
    expect(device.dirs[2]!.id).toMatch(/^generated-\d+$/);
  });

  test("usableRemoteDirs 只认填完的;findRemoteDir 按 id 找,旧数据的路径也能命中", () => {
    const device = parseSshDevice({
      host: "h",
      dirs: [{ id: "ok", path: "/srv/app" }, { id: "draft", path: "" }],
    }, fixedId)!;
    expect(usableRemoteDirs(device).map((dir) => dir.id)).toEqual(["ok"]);
    expect(findRemoteDir(device, "ok")?.path).toBe("/srv/app");
    expect(findRemoteDir(device, "/srv/app")?.id).toBe("ok");
    expect(findRemoteDir(device, "nope")).toBeNull();
    // 草稿目录不可绑定:命中了也只回空 path,由调用方判空。
    expect(findRemoteDir(device, "draft")?.path).toBe("");
  });

  test("私钥超过 64 KiB 整条拒绝(截断只会变成更难查的认证失败)", () => {
    const device = parseSshDevice({ host: "h", username: "u", authType: "key", privateKey: "x".repeat(64 * 1024 + 1) }, fixedId)!;
    expect(sshDeviceInputError(device)).toBe("ssh.key_too_large");
    expect(sshDeviceInputError(parseSshDevice({ host: "h", username: "u", privateKey: "x" }, fixedId)!)).toBeNull();
  });
});

describe("sshConnectionSignature", () => {
  const device = (patch: Partial<SshDevice>): SshDevice => ({
    ...parseSshDevice({ host: "h", username: "u", password: "p" }, fixedId)!,
    ...patch,
  });

  test("影响连接的字段变了就换指纹;改名与改目录不影响连接", () => {
    const base = device({});
    expect(sshConnectionSignature(base)).toBe(sshConnectionSignature(device({})));
    expect(sshConnectionSignature(device({ host: "h2" }))).not.toBe(sshConnectionSignature(base));
    expect(sshConnectionSignature(device({ port: 2222 }))).not.toBe(sshConnectionSignature(base));
    expect(sshConnectionSignature(device({ password: "p2" }))).not.toBe(sshConnectionSignature(base));
    expect(sshConnectionSignature(device({ name: "改名" }))).toBe(sshConnectionSignature(base));
    expect(sshConnectionSignature(device({
      dirs: [{ id: "d", name: "新目录", path: "/srv" }],
    }))).toBe(sshConnectionSignature(base));
  });

  test("取消信任主机密钥必须触发重连——否则旧连接绕过了新加的信任门槛", () => {
    const trusted = encodeHostKey(ed25519Blob())!;
    const withKey = device({ hostKey: trusted });
    expect(sshConnectionSignature(device({ hostKey: null }))).not.toBe(sshConnectionSignature(withKey));
    const other = encodeHostKey(ed25519Blob("另一把"))!;
    expect(sshConnectionSignature(device({ hostKey: other }))).not.toBe(sshConnectionSignature(withKey));
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

  // 授权目录是这次对齐的执行边界:命令的工作目录只能是条目里 grant 过的路径。
  // 拒绝类用例必须在「连网之前」就被拦下(地址用一个不会通的私网 IP,漏拦会变成慢超时);
  // 放行类用 127.0.0.1:1 —— 秒级 ECONNREFUSED,证明过了 403 闸、卡在连接阶段。
  test("cwd 未授权 → 403;dirId 不存在同样 403", async () => {
    const draft = {
      id: "grant-check",
      host: "10.0.0.9",
      username: "root",
      password: "secret",
      dirs: [{ id: "d1", name: "应用", path: "/srv/app" }],
    };
    const escaping = await call("POST", "ssh/exec", { device: draft, command: "id", cwd: "/etc" });
    expect(escaping?.status).toBe(403);
    expect((await escaping!.json()).errorCode).toBe("ssh.path_escape");
    expect((await call("POST", "ssh/exec", { device: draft, command: "id", dirId: "nope" }))?.status).toBe(403);
    // 探测里的 remoteDir 是编辑表单的「先看看存不存在」,不参与授权校验,但同样只 stat。
    expect((await call("POST", "ssh/test", { device: draft, dirId: "nope" }))?.status).toBe(403);
  });

  test("过了授权校验才轮到连接:本地 1 端口秒失败 → 502,不是 403", async () => {
    const draft = {
      id: "grant-pass",
      host: "127.0.0.1",
      port: 1,
      username: "root",
      password: "secret",
      dirs: [{ id: "d1", name: "应用", path: "/srv/app" }],
    };
    const res = await call("POST", "ssh/exec", { device: draft, command: "id", dirId: "d1" });
    expect(res?.status).toBe(502);
    expect((await res!.json()).error).toContain("127.0.0.1");
  });

  test("私钥过大在保存边界就拒绝", async () => {
    const res = await call("POST", "ssh/device", {
      id: "fat-key",
      name: "超大私钥",
      host: "h",
      username: "u",
      authType: "key",
      privateKey: "x".repeat(64 * 1024 + 1),
    });
    expect(res?.status).toBe(400);
    expect((await res!.json()).errorCode).toBe("ssh.key_too_large");
    expect(saved().some((item) => item.id === "fat-key")).toBe(false);
  });
});
