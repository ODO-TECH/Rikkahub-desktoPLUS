// memory/write-policy.test.ts — 助手级写入范围解析的规则锁。
// 纪律：固定档忽略模型请求；目标层关闭时降级进待确认队列；readonly 永远不可写。

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assistant } from "../foundation/types";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-writepolicy-test-"));

const { setState, state } = await import("../persistence/json-store");
const { canAssistantWriteMemory, resolveMemoryWriteTarget } = await import("./write-policy");

function assistant(patch: Partial<Assistant>): Assistant {
  return {
    id: "a1",
    enableMemory: true,
    memoryWriteScope: "tool_default_global",
    ...patch,
  } as Assistant;
}

function setLayers(globalEnabled: boolean) {
  setState({
    ...state,
    settings: {
      ...state.settings,
      memorySettings: { ...state.settings.memorySettings, globalEnabled },
    },
  });
}

describe("resolveMemoryWriteTarget", () => {
  beforeEach(() => setLayers(true));

  test("readonly 永远不可写，且不暴露 save_memory", () => {
    const a = assistant({ memoryWriteScope: "readonly" });
    expect(resolveMemoryWriteTarget(a, "global")).toEqual({ readonly: true });
    expect(canAssistantWriteMemory(a)).toBe(false);
  });

  test("always_global 忽略模型请求", () => {
    const a = assistant({ memoryWriteScope: "always_global" });
    expect(resolveMemoryWriteTarget(a, "assistant")).toEqual({ scope: "global" });
  });

  test("always_global 在全局层关闭时进待确认队列", () => {
    setLayers(false);
    const a = assistant({ memoryWriteScope: "always_global" });
    expect(resolveMemoryWriteTarget(a)).toEqual({ pending: true });
  });

  test("always_assistant 在助手层关闭时进待确认队列", () => {
    const a = assistant({ memoryWriteScope: "always_assistant", enableMemory: false });
    expect(resolveMemoryWriteTarget(a)).toEqual({ pending: true });
  });

  test("tool_default_global：模型请求 assistant 且可写时尊重请求", () => {
    const a = assistant({ memoryWriteScope: "tool_default_global" });
    expect(resolveMemoryWriteTarget(a, "assistant")).toEqual({ scope: "assistant" });
  });

  test("tool_default_global：助手层不可写时回退全局", () => {
    const a = assistant({ memoryWriteScope: "tool_default_global", enableMemory: false });
    expect(resolveMemoryWriteTarget(a, "assistant")).toEqual({ scope: "global" });
  });

  test("tool_default_global：两层都关时进待确认队列", () => {
    setLayers(false);
    const a = assistant({ memoryWriteScope: "tool_default_global", enableMemory: false });
    expect(resolveMemoryWriteTarget(a)).toEqual({ pending: true });
    expect(canAssistantWriteMemory(a)).toBe(false);
  });

  test("tool_default_assistant：默认本助手，显式请求全局且全局可写时写全局", () => {
    const a = assistant({ memoryWriteScope: "tool_default_assistant" });
    expect(resolveMemoryWriteTarget(a)).toEqual({ scope: "assistant" });
    expect(resolveMemoryWriteTarget(a, "global")).toEqual({ scope: "global" });
  });

  test("tool_default_assistant：助手层关闭时回退全局", () => {
    const a = assistant({ memoryWriteScope: "tool_default_assistant", enableMemory: false });
    expect(resolveMemoryWriteTarget(a)).toEqual({ scope: "global" });
  });

  test("缺省 scope 字段按 tool_default_global 处理", () => {
    const a = assistant({ memoryWriteScope: undefined });
    expect(resolveMemoryWriteTarget(a)).toEqual({ scope: "global" });
  });
});
