// 全域复审 H1/H2 回归:MCP sync/detail 的长 await(工具同步握手)期间,备份恢复/导入会
// 整体替换 state.settings(不走 per-id 写锁)。不设防时 upsertById 会把旧世界的服务器插回
// 新 settings(复活已删/覆盖已改)。守卫 = 写前身份重查(同批6 G1 会话守卫):起始捕获的
// 条目引用已不在当前 settings → 409 丢弃结果。
// 经真实路由驱动,mock 模块边界制造时序:
//   - tools/mcp 的 syncMcpServerTools → 可控 deferred("导入发生在同步完成前")
//   - app-config 的 updateSettings → 只改内存不落盘/不广播(避免测试进程写盘;经 rg 核实,
//     进程内没有其他测试依赖真实 updateSettings:e2e 测试全部走子进程+隔离数据目录,
//     keybindings-guard 只测拒绝路径)
// 注意:bun 的 mock.module 全局生效且跨测试文件不回收,必须展开真实模块只覆盖目标导出;
// json-store 不能 mock(state 是 let 重赋值绑定,展开会冻结成快照),这里静态导入拿活绑定。
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { State } from "../foundation/types";
import type { JsonValue } from "../foundation/types";
import type { Settings } from "../foundation/types/settings";
import { setState, state } from "../persistence/json-store";

import * as actualAppConfig from "../app-config";
import * as actualMcp from "../tools/mcp";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

let syncGate = deferred();
let gateEnabled = false;

mock.module("../app-config", () => ({
  ...actualAppConfig,
  updateSettings: (next: Settings) => { setState({ ...(state ?? {}), settings: next } as State); },
}));
mock.module("../tools/mcp", () => ({
  ...actualMcp,
  syncMcpServerTools: async (server: Record<string, JsonValue>) => {
    if (gateEnabled) await syncGate.promise;
    return {
      ...server,
      commonOptions: {
        ...(server.commonOptions as Record<string, JsonValue>),
        connected: true,
        tools: [{ name: "demo", enable: true }],
        lastSyncAt: Date.now(),
        lastSyncError: "",
      },
    };
  },
}));

const { handleSettingsRoutes } = await import("./handlers/settings");

const priorState = state;

function makeServer(id: string): Record<string, JsonValue> {
  return {
    id,
    type: "streamable_http",
    url: "http://localhost:9/mcp",
    commonOptions: { enable: true, name: id, headers: [], tools: [], lastSyncAt: null, lastSyncError: "", connected: false },
  };
}

function makeSettings(servers: Record<string, JsonValue>[]) {
  return {
    assistantId: "a1",
    assistants: [],
    providers: [],
    mcpServers: servers,
    proxyConfig: { type: "none" },
  };
}

function post(path: string, body: unknown): Promise<Response | null> {
  const request = new Request(`http://localhost/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, new URL(request.url), path);
}

beforeAll(() => {
  setState({ settings: makeSettings([]) } as unknown as State);
});

afterAll(() => {
  setState(priorState);
});

describe("MCP 导入穿透锁守卫(H1/H2)", () => {
  test("H1 sync:同步期间 settings 被整体替换(导入删除该服务器)→ 409 且不复活", async () => {
    const server = makeServer("h1-srv");
    setState({ settings: makeSettings([server]) } as unknown as State);

    syncGate = deferred();
    gateEnabled = true;
    const pending = post("settings/mcp-server/sync", { serverId: "h1-srv" });
    await Bun.sleep(0); // 让路由跑到 syncMcpServerTools 的 await

    // 模拟备份恢复:整体替换 settings,新世界里没有这台服务器
    setState({ settings: makeSettings([]) } as unknown as State);

    syncGate.resolve();
    gateEnabled = false;
    const response = await pending;
    expect(response?.status).toBe(409);
    expect((state.settings.mcpServers as JsonValue[]).length).toBe(0);
  });

  test("H2 detail 更新:保存期间 settings 被整体替换 → 409 且不复活", async () => {
    const server = makeServer("h2-srv");
    setState({ settings: makeSettings([server]) } as unknown as State);

    syncGate = deferred();
    gateEnabled = true;
    const pending = post("settings/mcp-server/detail", {
      ...server,
      commonOptions: { ...(server.commonOptions as Record<string, JsonValue>) },
    });
    await Bun.sleep(0);

    setState({ settings: makeSettings([]) } as unknown as State);

    syncGate.resolve();
    gateEnabled = false;
    const response = await pending;
    expect(response?.status).toBe(409);
    expect((state.settings.mcpServers as JsonValue[]).length).toBe(0);
  });

  test("对照:无干扰时 detail 保存正常成功(守卫不误伤)", async () => {
    const server = makeServer("ok-srv");
    setState({ settings: makeSettings([server]) } as unknown as State);

    gateEnabled = false;
    const response = await post("settings/mcp-server/detail", { ...server });
    expect(response?.status).toBe(200);
    const items = state.settings.mcpServers as Array<Record<string, JsonValue>>;
    expect(items.length).toBe(1);
    const common = items[0].commonOptions as Record<string, JsonValue>;
    expect(common.connected).toBe(true);
  });

  test("对照:新建服务器(此前不存在)在并发导入下仍按创建语义落地", async () => {
    setState({ settings: makeSettings([]) } as unknown as State);

    syncGate = deferred();
    gateEnabled = true;
    const server = makeServer("new-srv");
    const pending = post("settings/mcp-server/detail", { ...server });
    await Bun.sleep(0);

    // 导入替换 settings;新建没有"陈旧写回"问题,应照常插入(创建语义)
    setState({ settings: makeSettings([]) } as unknown as State);

    syncGate.resolve();
    gateEnabled = false;
    const response = await pending;
    expect(response?.status).toBe(200);
    expect((state.settings.mcpServers as JsonValue[]).length).toBe(1);
  });
});
