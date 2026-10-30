// 内置（进程内）MCP 传输回归：注册表 JSON-RPC 面、播种与复位、以及经由常规 mcp.ts 路径的
// 工具同步/调用/日志信封——下游代码不应感知到第三种传输的存在。
import { afterEach, describe, expect, test } from "bun:test";

import type { JsonValue } from "../foundation/types";
import { formatKeyLocal } from "../foundation/utils";
import { normalizeState } from "../persistence/state-load";
import { fetchMcpTools, mcpJsonRpc, resolveMcpToolServer, type McpLogCallback } from "./mcp";
import {
  BUILTIN_FETCH_SERVER_ID,
  BUILTIN_FETCH_TOOL_FULL_NAME,
  BUILTIN_MCP_TRANSPORT,
  builtinLabel,
  builtinMcpRequest,
  builtinServerName,
  ensureBuiltinMcpServers,
  isBuiltinMcpServer,
  isBuiltinMcpServerId,
} from "./mcp-builtin";

function builtinRecord(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    id: BUILTIN_FETCH_SERVER_ID,
    type: BUILTIN_MCP_TRANSPORT,
    url: "",
    commonOptions: { enable: true, name: builtinServerName(BUILTIN_FETCH_SERVER_ID), headers: [], tools: [] },
    ...overrides,
  };
}

describe("内置服务器注册表", () => {
  test("initialize 报出协议版本与服务器名", async () => {
    const result = (await builtinMcpRequest(builtinRecord(), "initialize", {})) as Record<string, JsonValue>;
    expect(result.serverInfo).toEqual({ name: "@rikkahub/fetch", version: "1.0.0" });
    expect(typeof result.protocolVersion).toBe("string");
  });

  test("tools/list 只暴露 fetch，且带完整 inputSchema", async () => {
    const result = (await builtinMcpRequest(builtinRecord(), "tools/list", {})) as { tools: Array<Record<string, JsonValue>> };
    expect(result.tools.map((tool) => tool.name)).toEqual(["fetch"]);
    expect((result.tools[0]!.inputSchema as Record<string, JsonValue>).required).toEqual(["url"]);
  });

  test("tools/list 每次现算日期，进程常驻几天也不会给出过期日期", async () => {
    const first = await builtinMcpRequest(builtinRecord(), "tools/list", {});
    const description = String((first as any).tools[0].description);
    const today = formatKeyLocal(new Date());
    expect(description).toContain(`Today is ${today}`);
  });

  test("ping 返回空对象，未知方法按 JSON-RPC 语义抛错", async () => {
    expect(await builtinMcpRequest(builtinRecord(), "ping", {})).toEqual({});
    await expect(builtinMcpRequest(builtinRecord(), "resources/list", {})).rejects.toThrow(/Method not found/);
  });

  test("调用未注册的工具抛错而不是静默返回空结果", async () => {
    await expect(builtinMcpRequest(builtinRecord(), "tools/call", { name: "nope", arguments: {} })).rejects.toThrow(/Tool not found/);
  });

  test("未知内置 id 直接拒绝", async () => {
    await expect(builtinMcpRequest({ id: "ghost", type: BUILTIN_MCP_TRANSPORT }, "ping", {})).rejects.toThrow(/Unknown built-in MCP server/);
  });

  test("传输判定只认 type 字段", () => {
    expect(isBuiltinMcpServer(builtinRecord())).toBe(true);
    expect(isBuiltinMcpServer({ id: "x", type: "stdio" })).toBe(false);
    expect(isBuiltinMcpServerId(BUILTIN_FETCH_SERVER_ID)).toBe(true);
    expect(isBuiltinMcpServerId("user_server")).toBe(false);
    expect(builtinLabel(builtinRecord())).toBe(`builtin://${BUILTIN_FETCH_SERVER_ID}`);
    expect(BUILTIN_FETCH_TOOL_FULL_NAME).toBe("mcp__fetch");
  });
});

describe("内置服务器播种（ensureBuiltinMcpServers）", () => {
  test("缺失时播到列表首位并带着可读的名字", () => {
    const seeded = ensureBuiltinMcpServers([{ id: "user", type: "streamable_http", url: "https://a/mcp" }]) as Array<Record<string, JsonValue>>;
    expect(seeded.map((server) => server.id)).toEqual([BUILTIN_FETCH_SERVER_ID, "user"]);
    const record = seeded[0]!;
    expect(record.type).toBe(BUILTIN_MCP_TRANSPORT);
    const common = record.commonOptions as Record<string, JsonValue>;
    expect(common.enable).toBe(true);
    expect(common.name).toBe("@rikkahub/fetch");
  });

  test("用户关掉的开关与逐工具偏好被继承，脏字段被注册表覆盖", () => {
    const polluted = ensureBuiltinMcpServers([
      {
        id: BUILTIN_FETCH_SERVER_ID,
        type: BUILTIN_MCP_TRANSPORT,
        url: "https://attacker.example/mcp",
        command: "rm",
        commonOptions: {
          enable: false,
          name: "改名试试",
          headers: [{ first: "Authorization", second: "leak" }],
          oauth: { accessToken: "stale" },
          lastSyncError: "旧的错",
          tools: [{ name: "fetch", enable: false, needsApproval: true }],
        },
      },
    ]) as Array<Record<string, JsonValue>>;
    expect(polluted).toHaveLength(1);
    const record = polluted[0]!;
    expect(record.url).toBe("");
    expect("command" in record).toBe(false);
    const common = record.commonOptions as Record<string, JsonValue>;
    // 只继承用户意图：总开关 + 逐工具偏好；其余一律由注册表说了算。
    expect(common.enable).toBe(false);
    expect(common.name).toBe("@rikkahub/fetch");
    expect(common.tools).toEqual([{ name: "fetch", enable: false, needsApproval: true }]);
    expect(common.headers).toEqual([]);
    expect("oauth" in common).toBe(false);
    expect("lastSyncError" in common).toBe(false);
  });

  test("重复记录被折叠成一条", () => {
    const deduped = ensureBuiltinMcpServers([
      builtinRecord(),
      builtinRecord(),
      { id: "user", type: "streamable_http" },
    ]);
    expect(deduped).toHaveLength(2);
  });

  test("幂等：对已播种的列表再跑一次不变", () => {
    const once = ensureBuiltinMcpServers([]);
    expect(ensureBuiltinMcpServers(once)).toEqual(once);
  });
});

describe("加载链播种（normalizeState）", () => {
  test("空设置加载后也带内置服务器", () => {
    const state = normalizeState({ settings: {} } as any);
    const servers = state.settings.mcpServers as Array<Record<string, JsonValue>>;
    expect(servers[0]?.id).toBe(BUILTIN_FETCH_SERVER_ID);
    expect(servers[0]?.type).toBe(BUILTIN_MCP_TRANSPORT);
  });

  test("mcpServers 被写成非数组时也会被纠正", () => {
    const state = normalizeState({ settings: { mcpServers: null } } as any);
    const servers = state.settings.mcpServers as Array<Record<string, JsonValue>>;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers[0]?.id).toBe(BUILTIN_FETCH_SERVER_ID);
  });
});

describe("内置服务器走常规 mcp.ts 路径", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("fetchMcpTools 直接拿到工具定义，不发网络请求", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("内置传输不应出网");
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
    const tools = await fetchMcpTools(builtinRecord());
    expect(tools.map((tool) => tool.name)).toEqual(["fetch"]);
    expect(tools[0]!.enable).toBe(true);
  });

  test("日志信封记成 BUILTIN/builtin://，与 stdio 同一形状", async () => {
    const logs: Array<Record<string, JsonValue>> = [];
    const log: McpLogCallback = (entry) => logs.push(entry as unknown as Record<string, JsonValue>);
    await mcpJsonRpc(builtinRecord(), "tools/list", undefined, log);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.method).toBe("BUILTIN");
    expect(logs[0]!.url).toBe(`builtin://${BUILTIN_FETCH_SERVER_ID}`);
    expect(logs[0]!.ok).toBe(true);
    expect(logs[0]!.status).toBe(200);
    expect(logs[0]!.kind).toBe("mcp:tools/list");
  });

  test("失败也记 ok=false + status 0，供健康层归因", async () => {
    const logs: Array<Record<string, JsonValue>> = [];
    const log: McpLogCallback = (entry) => logs.push(entry as unknown as Record<string, JsonValue>);
    await expect(mcpJsonRpc(builtinRecord(), "prompts/list", undefined, log)).rejects.toThrow();
    expect(logs[0]!.ok).toBe(false);
    expect(logs[0]!.status).toBe(0);
    expect(String(logs[0]!.error)).toContain("Method not found");
  });

  test("助手侧按 mcp__fetch 命中内置服务器并取回原文", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><body><main><p>内置抓取结果</p></main></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };

    const server = builtinRecord();
    (server.commonOptions as Record<string, JsonValue>).tools = [{ name: "fetch", enable: true }];
    const assistant = { mcpServers: [BUILTIN_FETCH_SERVER_ID] } as any;
    const resolved = resolveMcpToolServer(assistant, "mcp__fetch", [server]);
    expect(resolved?.rawToolName).toBe("fetch");

    const result = (await mcpJsonRpc(server, "tools/call", {
      name: "fetch",
      arguments: { url: "https://203.0.113.10/page" },
    })) as Record<string, JsonValue>;
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain("内置抓取结果");
  });
});
