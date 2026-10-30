// 批次三 R3-3 回归:normalizeState 必须一次性剥除持久化的 mcpServers[].ssePostEndpoint。
// 该字段是旧 SSE 传输的运行时会话缓存(常带 sessionId),曾被误写进 settings;服务器重启
// 即失效,留在磁盘会让重启 PC 也救不回来。每次加载无条件剥除,天然覆盖备份恢复带回的旧值。
// SSE 传输移除后,同一个迁移点把历史 type:"sse" 服务器归一为 Streamable HTTP。
import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";
import type { JsonValue } from "../foundation/types";

function servers(state: ReturnType<typeof normalizeState>) {
  return state.settings.mcpServers as Array<Record<string, JsonValue>>;
}

// normalizeState 会把内置服务器播在列表首位，按 id 取才不受顺序影响。
function serverOf(state: ReturnType<typeof normalizeState>, serverId: string) {
  const found = servers(state).find((server) => String(server.id) === serverId);
  if (!found) throw new Error(`server ${serverId} missing`);
  return found;
}

describe("R3-3 mcpServers.ssePostEndpoint 剥离 + SSE 迁移", () => {
  test("持久化的 ssePostEndpoint 被剥除，旧 SSE 服务器迁移为 Streamable HTTP", () => {
    const state = normalizeState({
      settings: {
        mcpServers: [
          {
            id: "s1",
            type: "sse",
            url: "https://mcp.example/sse",
            ssePostEndpoint: "https://mcp.example/messages?sessionId=stale",
            commonOptions: { enable: true, name: "X", headers: [], tools: [] },
          },
        ],
      } as any,
    });
    const s = serverOf(state, "s1");
    expect("ssePostEndpoint" in s).toBe(false);
    expect(s.id).toBe("s1");
    expect(s.type).toBe("streamable_http");
    expect(s.url).toBe("https://mcp.example/sse");
    expect((s.commonOptions as Record<string, JsonValue>).name).toBe("X");
  });

  test("没有 ssePostEndpoint 的旧 SSE 服务器也会迁移类型", () => {
    const state = normalizeState({
      settings: {
        mcpServers: [{ id: "s3", type: "sse", url: "https://mcp.example/sse", commonOptions: { enable: true } }],
      } as any,
    });
    expect(serverOf(state, "s3").type).toBe("streamable_http");
  });

  test("无该字段的 streamable_http 服务器原样通过", () => {
    const state = normalizeState({
      settings: {
        mcpServers: [{ id: "s2", type: "streamable_http", url: "https://mcp.example/mcp", commonOptions: { enable: true } }],
      } as any,
    });
    const s = serverOf(state, "s2");
    expect("ssePostEndpoint" in s).toBe(false);
    expect(s.id).toBe("s2");
    expect(s.type).toBe("streamable_http");
  });
});
