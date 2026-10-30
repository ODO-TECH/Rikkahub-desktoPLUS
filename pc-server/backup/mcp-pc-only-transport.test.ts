// 安卓契约回归：stdio 与内置（builtin）同属 PC 独有传输，导出到 APP 时整条剥离，
// 助手上的引用也要一起清掉——否则 APP 反序列化到一个没有 command/url 的服务器直接崩。
import { describe, expect, test } from "bun:test";

import { PC_AVATAR_TYPE_TO_ANDROID, rewriteAvatarsInSettings } from "./export";

function settings() {
  return {
    mcpServers: [
      {
        id: "builtin_fetch",
        type: "builtin",
        url: "",
        commonOptions: { enable: true, name: "@rikkahub/fetch", headers: [], tools: [{ name: "fetch", enable: true }] },
      },
      {
        id: "stdio1",
        type: "stdio",
        command: "npx",
        commonOptions: { enable: true, name: "本地进程", headers: [], tools: [] },
      },
      {
        id: "http1",
        type: "streamable_http",
        url: "https://example.com/mcp",
        commonOptions: { enable: true, name: "远程", headers: [], tools: [] },
      },
    ],
    assistants: [{ id: "a1", name: "助手", mcpServers: ["builtin_fetch", "stdio1", "http1"] }],
  } as any;
}

function ids(servers: Array<Record<string, unknown>>) {
  return servers.map((server) => String(server.id));
}

describe("PC 独有传输的安卓导出剥离", () => {
  test("to-android：只留 streamable_http，助手引用同步清掉", () => {
    const out = rewriteAvatarsInSettings(settings(), PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(ids(out.mcpServers)).toEqual(["http1"]);
    expect(out.assistants[0].mcpServers).toEqual(["http1"]);
  });

  test("to-pc：原样透传，不做剥离", () => {
    const out = rewriteAvatarsInSettings(settings(), PC_AVATAR_TYPE_TO_ANDROID, "to-pc");
    expect(ids(out.mcpServers)).toEqual(["builtin_fetch", "stdio1", "http1"]);
    expect(out.assistants[0].mcpServers).toHaveLength(3);
  });
});
