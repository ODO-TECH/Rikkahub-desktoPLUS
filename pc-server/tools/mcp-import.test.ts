// MCP 配置 JSON 导入解析：覆盖常见客户端形状与错误面。
import { describe, expect, test } from "bun:test";

import { parseMcpImportJson } from "./mcp-import";

describe("Claude Desktop 形状", () => {
  test("mcpServers 映射：command 推断 stdio，env 归一成 Pair", () => {
    const result = parseMcpImportJson(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\data"],
          env: { API_KEY: "secret", EMPTY: "" },
        },
      },
    }));
    expect(result.errors).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toEqual({
      name: "filesystem",
      type: "stdio",
      url: "",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\data"],
      env: [{ first: "API_KEY", second: "secret" }, { first: "EMPTY", second: "" }],
      cwd: "",
      headers: [],
    });
  });

  test("网络服务器：url + headers 对象，type 缺省按 Streamable HTTP", () => {
    const result = parseMcpImportJson(JSON.stringify({
      mcpServers: {
        remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } },
      },
    }));
    expect(result.servers[0]!.type).toBe("streamable_http");
    expect(result.servers[0]!.headers).toEqual([{ first: "Authorization", second: "Bearer t" }]);
    expect(result.servers[0]!.command).toBe("");
  });
});

describe("其它根形状", () => {
  test("VS Code servers 数组 + name 字段", () => {
    const result = parseMcpImportJson(JSON.stringify({
      servers: [
        { name: "local-tool", command: "uvx", args: ["mcp-server-git"] },
        { name: "web", url: "https://example.com/mcp" },
      ],
    }));
    expect(result.servers.map((s) => [s.name, s.type])).toEqual([
      ["local-tool", "stdio"],
      ["web", "streamable_http"],
    ]);
  });

  test("裸数组、单个服务器对象、name→config 裸映射、字符串 URL", () => {
    expect(parseMcpImportJson(JSON.stringify([
      { command: "bun", args: ["run", "server.ts"] },
    ])).servers[0]!.type).toBe("stdio");
    expect(parseMcpImportJson(JSON.stringify({
      name: "solo", type: "stdio", command: "node", args: "server.js --flag",
    })).servers[0]!.args).toEqual(["server.js", "--flag"]);
    expect(parseMcpImportJson(JSON.stringify({
      alpha: { command: "npx", args: ["pkg"] },
      beta: { url: "https://beta.example/mcp" },
    })).servers.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(parseMcpImportJson(JSON.stringify({
      mcpServers: { plain: "https://plain.example/mcp" },
    })).servers[0]).toMatchObject({ name: "plain", type: "streamable_http", url: "https://plain.example/mcp" });
  });

  test("cwd / workingDirectory 兼容", () => {
    const result = parseMcpImportJson(JSON.stringify({
      servers: {
        a: { command: "node", cwd: "C:\\work" },
        b: { command: "node", workingDirectory: "/tmp/work" },
      },
    }));
    expect(result.servers.map((s) => s.cwd)).toEqual(["C:\\work", "/tmp/work"]);
  });
});

describe("错误面", () => {
  test("坏 JSON / 无法识别 / 缺 url 或 command", () => {
    expect(parseMcpImportJson("{oops").errors[0]).toContain("JSON 解析失败");
    expect(parseMcpImportJson("42").errors[0]).toContain("无法识别");
    const missing = parseMcpImportJson(JSON.stringify({ mcpServers: { broken: { type: "stdio" } } }));
    expect(missing.servers).toHaveLength(0);
    expect(missing.errors[0]).toContain("缺少 command");
    const noUrl = parseMcpImportJson(JSON.stringify({ mcpServers: { remote: { type: "http" } } }));
    expect(noUrl.errors[0]).toContain("缺少 url");
  });

  test("一条坏配置不拖累其它条目", () => {
    const result = parseMcpImportJson(JSON.stringify({
      mcpServers: {
        good: { command: "npx", args: ["ok"] },
        bad: { args: ["no-command-no-url"] },
      },
    }));
    expect(result.servers.map((s) => s.name)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
  });
});
