// tools/mcp-import.ts — MCP 配置 JSON 导入（Claude Desktop / VS Code / Cline / 裸对象）
//
// 只做形状解析，不落盘、不启动进程。支持：
//   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
//   { "mcpServers": [ { "name": "...", "url": "..." } ] }
//   { "servers": {...} } / 裸数组 / 单个服务器对象 / 单条字符串 URL
// 远程按 Streamable HTTP 处理；带 command 或 type=stdio 的按本地 stdio 处理。

import type { JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { normalizeMcpHeaders, readMcpHeaders } from "./mcp-headers";

export type McpTransportType = "streamable_http" | "stdio";

export interface ParsedMcpServer {
  name: string;
  type: McpTransportType;
  url: string;
  command: string;
  args: string[];
  env: Array<{ first: string; second: string }>;
  cwd: string;
  headers: Array<{ first: string; second: string }>;
}

export interface McpImportResult {
  servers: ParsedMcpServer[];
  errors: string[];
}

const STDIO_TYPE_HINTS = new Set(["stdio", "local", "process"]);
const HTTP_TYPE_HINTS = new Set(["streamable_http", "streamablehttp", "streamable-http", "http", "https", "remote", "sse"]);

function stringValue(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function stringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => stringValue(item)).filter(Boolean);
  const text = stringValue(raw);
  if (!text) return [];
  // 少数客户端把 args 写成一行；按空白拆开，带引号的片段做最简处理。
  return text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) ?? [];
}

function singleServer(entry: unknown, fallbackName: string): ParsedMcpServer | string {
  if (typeof entry === "string") {
    const url = entry.trim();
    if (!/^https?:\/\//i.test(url)) return "字符串配置必须是 http(s) URL";
    return { name: fallbackName, type: "streamable_http", url, command: "", args: [], env: [], cwd: "", headers: [] };
  }
  if (!isRecord(entry)) return "配置项不是对象";
  const name = stringValue(entry.name) || stringValue(entry.title) || fallbackName;
  const typeHint = stringValue(entry.type || entry.transport).toLowerCase();
  const command = stringValue(entry.command);
  const url = stringValue(entry.url) || stringValue(entry.serverUrl) || stringValue(entry.endpoint);
  const explicitStdio = STDIO_TYPE_HINTS.has(typeHint) || Boolean(command);
  const explicitHttp = HTTP_TYPE_HINTS.has(typeHint) || (!command && Boolean(url));
  if (explicitStdio && !command) return `「${name}」声明为 stdio 但缺少 command`;
  if (!command && !url) return `「${name}」缺少 url 或 command`;
  if (!explicitStdio && explicitHttp && !url) return `「${name}」缺少 url`;
  const type: McpTransportType = explicitStdio ? "stdio" : "streamable_http";
  return {
    name,
    type,
    url: type === "streamable_http" ? url : "",
    command: type === "stdio" ? command : "",
    args: type === "stdio" ? stringArray(entry.args) : [],
    env: type === "stdio" ? (normalizeMcpHeaders(entry.env) as Array<{ first: string; second: string }>) : [],
    cwd: type === "stdio" ? stringValue(entry.cwd) || stringValue(entry.workingDirectory) : "",
    headers: type === "streamable_http"
      ? (normalizeMcpHeaders(entry.headers) as Array<{ first: string; second: string }>)
      : [],
  };
}

function entriesOf(root: unknown): Array<{ key: string; value: unknown }> | null {
  if (Array.isArray(root)) {
    return root.map((value, index) => ({ key: `MCP ${index + 1}`, value }));
  }
  if (!isRecord(root)) return null;
  for (const field of ["mcpServers", "servers", "mcp"]) {
    const value = root[field];
    if (Array.isArray(value)) return value.map((item, index) => ({ key: `MCP ${index + 1}`, value: item }));
    if (isRecord(value)) return Object.entries(value).map(([key, item]) => ({ key, value: item }));
  }
  // 单个服务器对象（带 command/url/type）直接当一条。
  if (root.command !== undefined || root.url !== undefined || root.serverUrl !== undefined) {
    return [{ key: stringValue(root.name) || "MCP Server", value: root }];
  }
  // name → config 的裸映射表。
  const values = Object.values(root);
  if (values.length > 0 && values.every((value) => isRecord(value) || typeof value === "string")) {
    return Object.entries(root).map(([key, value]) => ({ key, value }));
  }
  return null;
}

export function parseMcpImportJson(text: string): McpImportResult {
  const errors: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return { servers: [], errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`] };
  }
  const entries = entriesOf(root);
  if (!entries) return { servers: [], errors: ["无法识别的 MCP 配置：需要 mcpServers / servers 对象、数组或单个服务器对象"] };
  if (entries.length === 0) return { servers: [], errors: ["配置中没有 MCP 服务器"] };
  const servers: ParsedMcpServer[] = [];
  for (const { key, value } of entries) {
    const parsed = singleServer(value, key);
    if (typeof parsed === "string") errors.push(parsed);
    else servers.push(parsed);
  }
  return { servers, errors };
}

/** 从条目里读数组/对象形式的 env；导出给测试与调用方复用。 */
export function readEnvPairs(raw: JsonValue | undefined): Array<{ name: string; value: string }> {
  return readMcpHeaders(raw);
}
