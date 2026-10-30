// tools/mcp-builtin.ts — 内置（进程内）MCP 服务器注册表
//
// 与 Streamable HTTP / stdio 平级的第三种传输：不出进程、不占端口、不拉子进程，工具直接
// 在 pc-server 内执行。客户端真正用到的协议面只有 initialize / tools/list / tools/call
// （Kelivo 的 @kelivo/fetch 同样是这个最小集），其余方法按 JSON-RPC 语义报错。
//
// 传输形态是「服务器记录」上的一个字段（type: "builtin"），所以工具同步、每工具开关、
// 助手级覆盖、健康探活、聊天输入框的 MCP 选择器全部照旧复用，无需各自的特判。
//
// 纪律：注册表只读、不写 state。持久化记录由 normalizeState 播种（见 persistence/state-load.ts），
// 用户能关（enable: false）、能逐个工具关，但不能删——删了下一次装载也会被重新播回。

import type { JsonValue } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import { BUILTIN_FETCH_TOOL_NAME, builtinFetchToolDefinition, runBuiltinFetchTool } from "./mcp-builtin-fetch";

export const BUILTIN_MCP_TRANSPORT = "builtin";

/** 与 stdio 同属「PC 专属」：导出到安卓备份时必须整条剥离。 */
export const BUILTIN_FETCH_SERVER_ID = "builtin_fetch";

const BUILTIN_PROTOCOL_VERSION = "2025-06-18";
const BUILTIN_SERVER_VERSION = "1.0.0";

interface BuiltinTool {
  name: string;
  /** 惰性构造：描述里带当天日期，进程常驻几天后 tools/list 仍要给出正确日期。 */
  definition: () => Record<string, JsonValue>;
  run: (args: Record<string, JsonValue>) => Promise<Record<string, JsonValue>>;
}

interface BuiltinServer {
  serverName: string;
  tools: BuiltinTool[];
}

const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  [BUILTIN_FETCH_SERVER_ID]: {
    serverName: "@rikkahub/fetch",
    tools: [{ name: BUILTIN_FETCH_TOOL_NAME, definition: builtinFetchToolDefinition, run: runBuiltinFetchTool }],
  },
};

export function isBuiltinMcpServer(server: Record<string, JsonValue>): boolean {
  return String(server.type ?? "") === BUILTIN_MCP_TRANSPORT;
}

export function isBuiltinMcpServerId(serverId: string): boolean {
  return serverId in BUILTIN_SERVERS;
}

/** 内置服务器的显示名（注册表常量，不允许用户改名）。 */
export function builtinServerName(serverId: string): string {
  return BUILTIN_SERVERS[serverId]?.serverName ?? serverId;
}

/** 日志与设置页展示用的地址（与 stdio:// 同一手法，不含任何参数）。 */
export function builtinLabel(server: Record<string, JsonValue>): string {
  return `builtin://${String(server.id ?? "")}`;
}

function builtinRecord(id: string, spec: BuiltinServer, current: Record<string, JsonValue> | undefined): JsonValue {
  const common = isRecord(current?.commonOptions) ? (current!.commonOptions as Record<string, JsonValue>) : {};
  return {
    id,
    type: BUILTIN_MCP_TRANSPORT,
    url: "",
    commonOptions: {
      // 只继承「用户意图」两项：服务器总开关与逐工具偏好。传输细节（url/headers/oauth）
      // 一律由注册表说了算，避免历史脏数据把内置服务器带偏。
      enable: common.enable !== false,
      name: spec.serverName,
      headers: [],
      tools: Array.isArray(common.tools) ? common.tools : [],
    },
  };
}

/** 播种/复位内置服务器记录，并保证它们在列表首位。逐工具的 schema 由常规同步刷新，
 *  这里只保留 enable/needsApproval 偏好（syncMcpServerTools 会自己做同样的事）。 */
export function ensureBuiltinMcpServers(servers: JsonValue[]): JsonValue[] {
  const records = servers.filter(isRecord);
  const rest = servers.filter((server) => !isRecord(server) || !isBuiltinMcpServerId(String(server["id"])));
  const builtins = Object.entries(BUILTIN_SERVERS).map(([id, spec]) =>
    builtinRecord(id, spec, records.find((server) => String(server["id"]) === id)),
  );
  return [...builtins, ...rest];
}

/** 进程内 JSON-RPC 服务端：返回 JSON-RPC 的 result 体，失败抛异常（与 stdio 分支同一契约，
 *  tools/call 的业务失败不走异常——MCP 规范里那是 isError 的 tool_result）。 */
export async function builtinMcpRequest(
  server: Record<string, JsonValue>,
  method: string,
  params: Record<string, JsonValue> | undefined,
): Promise<unknown> {
  const spec = BUILTIN_SERVERS[String(server.id ?? "")];
  if (!spec) throw new Error(`Unknown built-in MCP server: ${String(server.id ?? "")}`);
  switch (method) {
    case "initialize":
      return {
        protocolVersion: BUILTIN_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: spec.serverName, version: BUILTIN_SERVER_VERSION },
      };
    case "tools/list":
      return { tools: spec.tools.map((tool) => tool.definition()) };
    case "ping":
      return {};
    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = spec.tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`Tool not found: ${name}`);
      const args = isRecord(params?.arguments) ? (params!.arguments as Record<string, JsonValue>) : {};
      return tool.run(args);
    }
    default:
      throw new Error(`Method not found: ${method}`);
  }
}

/** 内置 fetch 的工具名（模型侧带 mcp__ 前缀），测试与文档都用它，避免到处写字面量。 */
export const BUILTIN_FETCH_TOOL_FULL_NAME = `mcp__${BUILTIN_FETCH_TOOL_NAME}`;
