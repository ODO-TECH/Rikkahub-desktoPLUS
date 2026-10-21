// 本地 stdio MCP 传输的端到端锁定：真实子进程 + 换行分隔 JSON-RPC。
// 用 Bun 自己跑一个最小 MCP 服务器脚本，验证握手、tools/list、tools/call 与错误/超时路径。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../foundation/types";
import { closeAllStdioClients, stdioRequest } from "./mcp-stdio";

const SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write("test-server ready\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } },
    }) + "\\n");
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: "echo:" + String(msg.params?.arguments?.text ?? "") }] },
    }) + "\\n");
  }
});
`;

const dir = mkdtempSync(join(tmpdir(), "rikka-mcp-stdio-"));
const scriptPath = join(dir, "server.cjs");
writeFileSync(scriptPath, SERVER_SCRIPT, "utf8");

function server(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    id: "stdio-test",
    type: "stdio",
    command: process.execPath,
    args: [scriptPath],
    env: [],
    cwd: "",
    commonOptions: { enable: true, name: "Test stdio", headers: [], tools: [] },
    ...overrides,
  } as Record<string, JsonValue>;
}

afterAll(() => {
  closeAllStdioClients();
});

describe("stdio MCP 运行时", () => {
  test("initialize 握手后 tools/list 解析出工具", async () => {
    const result = await stdioRequest(server(), "tools/list", undefined, 5000) as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  test("tools/call 走同一条常驻进程", async () => {
    const result = await stdioRequest(server(), "tools/call", { name: "echo", arguments: { text: "你好" } }, 5000) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]!.text).toBe("echo:你好");
  });

  test("配置变化（args）触发重启，依然可用", async () => {
    const changed = server({ args: [scriptPath, "--extra"] });
    const result = await stdioRequest(changed, "tools/list", undefined, 5000) as { tools: unknown[] };
    expect(result.tools).toHaveLength(1);
  });

  test("缺少启动命令是同步配置错误", async () => {
    await expect(stdioRequest(server({ command: " " }), "tools/list", undefined, 5000)).rejects.toThrow("缺少启动命令");
  });

  test("无响应的请求按超时失败并回收进程", async () => {
    // 测试服务器不处理 resources/list。
    await expect(stdioRequest(server({ id: "stdio-timeout" }), "resources/list", undefined, 200)).rejects.toThrow("超时");
  });
});
