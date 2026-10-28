// api/handlers/im.test.ts — 外部接入设置端点的契约锁。
//
// 重点不在"能存进去",而在三条纪律:
//  - 平台切片只走白名单合并:未知键静默丢弃,配对名单与会话绑定表不能被这个入口改写;
//  - /im/status 是把配置下发给界面的地方,运行态可以给,密钥明文不该出现在这个响应里;
//  - 配对码是开关一条大门的凭据:生成即换新、撤销即失效、过期就不再下发。
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts 在 import 时刻固化 dataDir——必须先设环境变量再动态加载被测模块:
// 工作区校验要查活库,不能让本文件落到别的文件的数据目录里。
process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-im-handler-test-"));

import type { State } from "../../foundation/types";

const { defaultImAccess } = await import("../../foundation/types/settings/im-access");
const jsonStore = await import("../../persistence/json-store");
const conversations = await import("../../conversations");
const { createWorkspace } = await import("../../workspace");
const { __resetPairingRateLimitForTest } = await import("../../im/pairing");
const { __resetImRegistryForTest } = await import("../../im/registry");
const { handleImRoutes } = await import("./im");

const SECRET = "super-secret-value";
const TOKEN = "wechat-bot-token-value";

// 工作区校验经 getWorkspace 查活库,先打开本文件的临时库。
conversations.openConversationsDb();

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1/api/${path}`);
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handleImRoutes(request, url, path);
  if (!response) throw new Error(`路由未命中: ${method} ${path}`);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function seed(overrides: Record<string, unknown> = {}) {
  jsonStore.setState({
    settings: {
      assistants: [],
      providers: [],
      chatModelId: null,
      imAccess: defaultImAccess(),
      ...overrides,
    },
  } as unknown as State);
}

beforeEach(() => {
  __resetImRegistryForTest();
  __resetPairingRateLimitForTest();
  seed();
});

describe("平台切片保存", () => {
  test("只认白名单字段:去首尾空白,丢弃未知键", async () => {
    const { status, body } = await call("POST", "im/qq", {
      appId: " 1024 ",
      appSecret: " s3cret ",
      enabled: true,
      bogus: "x",
    });

    expect(status).toBe(200);
    expect(body.config.appId).toBe("1024");
    expect(body.config.appSecret).toBe("s3cret");
    expect(body.config.enabled).toBe(true);
    expect(body.config.bogus).toBeUndefined();
    expect(jsonStore.state.settings.imAccess.qq.appId).toBe("1024");
  });

  test("配对名单与会话表不能从这个入口写入", async () => {
    await call("POST", "im/wechat", {
      accountId: "bot-1",
      pairedUsers: [{ userId: "intruder", displayName: "x" }],
      chats: [{ key: "wechat:c9", chatId: "c9", conversationId: "conv-x" }],
    });

    expect(jsonStore.state.settings.imAccess.wechat.pairedUsers).toEqual([]);
    expect(jsonStore.state.settings.imAccess.chats).toEqual([]);
  });

  test("显式空串可清掉凭据", async () => {
    await call("POST", "im/qq", { appId: "1024", appSecret: SECRET });
    await call("POST", "im/qq", { appSecret: "" });

    expect(jsonStore.state.settings.imAccess.qq.appSecret).toBe("");
    expect(jsonStore.state.settings.imAccess.qq.appId).toBe("1024");
  });

  test("纯文本输出去 Markdown 开关只认布尔值", async () => {
    expect(jsonStore.state.settings.imAccess.qq.plainText).toBe(true);

    await call("POST", "im/qq", { plainText: false });
    expect(jsonStore.state.settings.imAccess.qq.plainText).toBe(false);

    // 字符串 "false" 不算数:这类开关只接受真正的布尔,避免 "false" 被当成真值。
    await call("POST", "im/qq", { plainText: "false" });
    expect(jsonStore.state.settings.imAccess.qq.plainText).toBe(false);
  });
});

describe("工作区绑定", () => {
  test("真实存在的工作区 id 可以保存", async () => {
    const workspace = createWorkspace({ type: "managed", name: "接入工作区" });

    const { status, body } = await call("POST", "im/qq", { workspaceId: workspace.id, enabled: true });

    expect(status).toBe(200);
    expect(body.config.workspaceId).toBe(workspace.id);
    expect(jsonStore.state.settings.imAccess.qq.workspaceId).toBe(workspace.id);
  });

  test("不存在的工作区 id 拒绝保存(不静默退化成纯聊天)", async () => {
    const { status, body } = await call("POST", "im/wechat", { workspaceId: "no-such-workspace" });

    expect(status).toBe(400);
    expect(body.errorCode).toBe("im.workspace_not_found");
    expect(jsonStore.state.settings.imAccess.wechat.workspaceId).toBe("");
  });

  test("空串把通道改回纯聊天", async () => {
    const workspace = createWorkspace({ type: "managed", name: "待解绑工作区" });
    await call("POST", "im/wechat", { workspaceId: workspace.id });
    await call("POST", "im/wechat", { workspaceId: "" });

    expect(jsonStore.state.settings.imAccess.wechat.workspaceId).toBe("");
  });
});

describe("status 响应边界", () => {
  test("不回传 appSecret / botToken 明文", async () => {
    seed({
      imAccess: {
        ...defaultImAccess(),
        qq: { ...defaultImAccess().qq, appId: "1024", appSecret: SECRET },
        wechat: { ...defaultImAccess().wechat, accountId: "bot-1", botToken: TOKEN },
      },
    });

    const { body } = await call("GET", "im/status");
    const text = JSON.stringify(body);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(body.platforms).toHaveLength(2);
    // 配置是否齐备仍要说清楚,界面靠它决定开关能不能点。
    expect(body.platforms[0].configured).toBe(true);
    expect(body.platforms[1].configured).toBe(true);
  });

  test("过期的配对码不再下发", async () => {
    seed({
      imAccess: { ...defaultImAccess(), pairing: { enabled: true, code: "ABC234", expiresAt: Date.now() - 1 } },
    });

    const { body } = await call("GET", "im/status");

    expect(body.pairing).toEqual({ enabled: true, code: null, expiresAt: null });
  });

  test("开关状态随 status 下发,界面据此决定显示生成还是开关", async () => {
    seed({
      imAccess: { ...defaultImAccess(), pairing: { enabled: false, code: null, expiresAt: null } },
    });

    const { body } = await call("GET", "im/status");

    expect(body.pairing.enabled).toBe(false);
  });
});

describe("配对码", () => {
  test("生成 6 位且落库,再次生成换新码", async () => {
    const first = await call("POST", "im/pairing", {});
    expect(first.body.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(jsonStore.state.settings.imAccess.pairing.code).toBe(first.body.code);
    expect(first.body.expiresAt).toBeGreaterThan(Date.now());

    const second = await call("POST", "im/pairing", {});
    expect(jsonStore.state.settings.imAccess.pairing.code).toBe(second.body.code);
  });

  test("撤销后码与有效期一起清空", async () => {
    await call("POST", "im/pairing", {});
    const { body } = await call("POST", "im/pairing", { action: "revoke" });

    expect(body).toEqual({ status: "ok", code: null, expiresAt: null });
    expect(jsonStore.state.settings.imAccess.pairing.code).toBeNull();
    expect(jsonStore.state.settings.imAccess.pairing.expiresAt).toBeNull();
  });

  test("关闭开关:落库 enabled=false,存量码同时作废", async () => {
    await call("POST", "im/pairing", {});
    expect(jsonStore.state.settings.imAccess.pairing.code).not.toBeNull();

    const { status, body } = await call("POST", "im/pairing", { enabled: false });

    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", enabled: false, code: null, expiresAt: null });
    expect(jsonStore.state.settings.imAccess.pairing).toEqual({ enabled: false, code: null, expiresAt: null });
  });

  test("关闭状态下生成新码被拒(400 im.pairing_disabled)", async () => {
    await call("POST", "im/pairing", { enabled: false });

    const { status, body } = await call("POST", "im/pairing", {});

    expect(status).toBe(400);
    expect(body.errorCode).toBe("im.pairing_disabled");
    expect(jsonStore.state.settings.imAccess.pairing.code).toBeNull();
  });

  test("重新开启不复活旧码", async () => {
    await call("POST", "im/pairing", {});
    await call("POST", "im/pairing", { enabled: false });
    const { body } = await call("POST", "im/pairing", { enabled: true });

    expect(body.enabled).toBe(true);
    expect(jsonStore.state.settings.imAccess.pairing).toEqual({ enabled: true, code: null, expiresAt: null });
    // 开回来之后就能正常生成了。
    const issued = await call("POST", "im/pairing", {});
    expect(issued.body.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe("收回权限", () => {
  test("撤掉授权只摘指定平台的指定用户", async () => {
    seed({
      imAccess: {
        ...defaultImAccess(),
        qq: {
          ...defaultImAccess().qq,
          pairedUsers: [
            { userId: "u1", displayName: "甲", pairedAt: 1 },
            { userId: "u2", displayName: "乙", pairedAt: 2 },
          ],
        },
      },
    });

    const { status } = await call("POST", "im/pairing/unpair", { platform: "qq", userId: "u1" });

    expect(status).toBe(200);
    expect(jsonStore.state.settings.imAccess.qq.pairedUsers.map((u) => u.userId)).toEqual(["u2"]);
  });

  test("平台名必须合法", async () => {
    const { status } = await call("POST", "im/pairing/unpair", { platform: "telegram", userId: "u1" });
    expect(status).toBe(400);
  });

  test("解绑 IM 会话只删绑定,不碰会话本身", async () => {
    seed({
      imAccess: {
        ...defaultImAccess(),
        chats: [
          { key: "qq:c1", platform: "qq", chatId: "c1", displayName: "甲", conversationId: "conv-1", lastActiveAt: 1 },
          { key: "wechat:c2", platform: "wechat", chatId: "c2", displayName: "乙", conversationId: "conv-2", lastActiveAt: 2 },
        ],
      },
    });

    const { status } = await call("DELETE", "im/chat/qq%3Ac1");

    expect(status).toBe(200);
    expect(jsonStore.state.settings.imAccess.chats.map((c) => c.key)).toEqual(["wechat:c2"]);
  });
});
