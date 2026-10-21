// 专题12:记忆/最近会话冻结快照单测——冻结、失效、键维度(会话/助手/开关)、LRU 上限。
// 通过注入 build 函数隔离 memoryStore/会话库,只验证快照层自身的语义。
import { afterEach, describe, expect, test } from "bun:test";

import type { Assistant } from "../foundation/types";
import { frozenContextBlocks, invalidateContextSnapshots } from "./context-snapshots";

function fakeAssistant(overrides: Partial<Assistant> = {}): Assistant {
  return { id: "assistant-1", enableMemory: true, enableRecentChatsReference: true, ...overrides } as Assistant;
}

/** 每次调用返回递增内容的 build 桩,借 calls 计数断言是否重建。 */
function countingBuild() {
  const state = { calls: 0 };
  const build = (): readonly [string, string] => {
    state.calls += 1;
    return [`memory-v${state.calls}`, `recent-v${state.calls}`];
  };
  return { state, build };
}

afterEach(() => {
  invalidateContextSnapshots();
});

describe("frozenContextBlocks", () => {
  test("同一会话+助手复用快照:底层数据变化不触发重建", () => {
    const { state, build } = countingBuild();
    const assistant = fakeAssistant();
    const first = frozenContextBlocks(assistant, "conv-1", build);
    const second = frozenContextBlocks(assistant, "conv-1", build);
    expect(first).toEqual(["memory-v1", "recent-v1"]);
    expect(second).toBe(first);
    expect(state.calls).toBe(1);
  });

  test("不同会话各自快照;失效后重建拿到新内容", () => {
    const { state, build } = countingBuild();
    const assistant = fakeAssistant();
    frozenContextBlocks(assistant, "conv-1", build);
    const other = frozenContextBlocks(assistant, "conv-2", build);
    expect(other).toEqual(["memory-v2", "recent-v2"]);
    invalidateContextSnapshots();
    const rebuilt = frozenContextBlocks(assistant, "conv-1", build);
    expect(rebuilt).toEqual(["memory-v3", "recent-v3"]);
    expect(state.calls).toBe(3);
  });

  test("换助手或切相关开关即换键重建", () => {
    const { state, build } = countingBuild();
    frozenContextBlocks(fakeAssistant(), "conv-1", build);
    frozenContextBlocks(fakeAssistant({ id: "assistant-2" }), "conv-1", build);
    frozenContextBlocks(fakeAssistant({ enableMemory: false }), "conv-1", build);
    frozenContextBlocks(fakeAssistant({ enableRecentChatsReference: false }), "conv-1", build);
    expect(state.calls).toBe(4);
  });

  test("超过 200 条上限淘汰最旧,活跃条目不受影响", () => {
    const { state, build } = countingBuild();
    const assistant = fakeAssistant();
    frozenContextBlocks(assistant, "conv-keep", build);
    for (let i = 0; i < 199; i += 1) {
      frozenContextBlocks(assistant, `conv-${i}`, build);
      // 触活 conv-keep,让它始终不是最旧
      frozenContextBlocks(assistant, "conv-keep", build);
    }
    expect(state.calls).toBe(200);
    // 再插一条挤掉最旧(conv-0),conv-keep 仍在缓存
    frozenContextBlocks(assistant, "conv-overflow", build);
    frozenContextBlocks(assistant, "conv-keep", build);
    expect(state.calls).toBe(201);
    frozenContextBlocks(assistant, "conv-0", build);
    expect(state.calls).toBe(202);
  });
});
