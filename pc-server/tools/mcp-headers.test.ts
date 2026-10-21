// MCP 请求头形状单源的行为锁定。
// 背景:安卓 McpCommonOptions.headers 是 List<Pair<String,String>>,kotlinx 只认 {first,second};
// 旧版设置页示例是 [["k","v"]] 元组——落进备份后 APP 的 settings 解码整体失败。
import { describe, expect, test } from "bun:test";

import { PC_AVATAR_TYPE_TO_ANDROID, rewriteAvatarsInSettings } from "../backup/export";
import { normalizeMcpHeaders, readMcpHeaders, toMcpHeaderPairs } from "./mcp-headers";

describe("readMcpHeaders:三种历史形状都能读", () => {
  test("安卓 Pair / 元组 / 键值 混合,顺序保留", () => {
    expect(
      readMcpHeaders([
        { first: "Authorization", second: "Bearer a" },
        ["X-Tuple", "t"],
        { key: "X-Key", value: "k" },
        { name: "X-Name", value: "n" },
      ]),
    ).toEqual([
      { name: "Authorization", value: "Bearer a" },
      { name: "X-Tuple", value: "t" },
      { name: "X-Key", value: "k" },
      { name: "X-Name", value: "n" },
    ]);
  });

  test("非数组 / 非法项安全跳过,缺值补空串", () => {
    expect(readMcpHeaders(undefined)).toEqual([]);
    expect(readMcpHeaders("x")).toEqual([]);
    expect(readMcpHeaders([null, 3, ["only-name"]])).toEqual([{ name: "only-name", value: "" }]);
  });

  test("JSON 导入常见对象表（headers / env）也能读", () => {
    expect(readMcpHeaders({ Authorization: "Bearer t", "X-N": 2, "X-Null": null })).toEqual([
      { name: "Authorization", value: "Bearer t" },
      { name: "X-N", value: "2" },
      { name: "X-Null", value: "" },
    ]);
  });
});

describe("写入形状 = 安卓 Pair 序列化", () => {
  test("toMcpHeaderPairs / normalizeMcpHeaders 输出 {first,second}", () => {
    expect(toMcpHeaderPairs([{ name: "A", value: "1" }])).toEqual([{ first: "A", second: "1" }]);
    expect(normalizeMcpHeaders([["A", "1"]])).toEqual([{ first: "A", second: "1" }]);
  });

  test("导出给 APP 时旧元组被归一;to-pc 方向原样不动", () => {
    const settings = {
      mcpServers: [{ id: "s1", type: "streamable_http", url: "https://x", commonOptions: { name: "S", headers: [["Authorization", "Bearer t"]] } }],
    };
    const out = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(out.mcpServers[0].commonOptions.headers).toEqual([{ first: "Authorization", second: "Bearer t" }]);
    expect(out.mcpServers[0].commonOptions.name).toBe("S");
    const back = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID, "to-pc");
    expect(back.mcpServers[0].commonOptions.headers).toEqual([["Authorization", "Bearer t"]]);
  });

  test("导出给 APP 时剔除本地 stdio 服务器及其助手引用", () => {
    const settings = {
      mcpServers: [
        { id: "http1", type: "streamable_http", url: "https://x", commonOptions: { name: "H" } },
        { id: "local1", type: "stdio", command: "npx", args: ["pkg"], env: [], cwd: "", commonOptions: { name: "L" } },
      ],
      assistants: [
        { id: "a1", mcpServers: ["http1", "local1"] },
        { id: "a2", mcpServers: ["local1"] },
      ],
    };
    const out = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID, "to-android");
    expect(out.mcpServers.map((server: any) => server.id)).toEqual(["http1"]);
    expect(out.assistants[0].mcpServers).toEqual(["http1"]);
    expect(out.assistants[1].mcpServers).toEqual([]);
    // PC→PC（to-pc）不动：本地 stdio 是 PC 合法配置。
    const kept = rewriteAvatarsInSettings(settings, PC_AVATAR_TYPE_TO_ANDROID, "to-pc");
    expect(kept.mcpServers).toHaveLength(2);
    expect(kept.assistants[1].mcpServers).toEqual(["local1"]);
  });
});
