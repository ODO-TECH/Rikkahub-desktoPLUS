// working-set 单测（DB-first 批2a）：单实例保证 / 引用计数 / sweep 四条件 / 注册与作废语义。
import { beforeEach, describe, expect, test } from "bun:test";

import {
  checkoutConversation,
  clearWorkingSet,
  configureWorkingSet,
  peekConversation,
  registerConversation,
  releaseConversation,
  removeConversations,
  sweepWorkingSet,
  workingSetSize,
} from "./working-set";
import type { Conversation } from "../foundation/types";

function conv(id: string): Conversation {
  return {
    id, assistantId: "a1", systemPrompt: null, title: id, messages: [],
    chatSuggestions: [], isPinned: false, createAt: 1, updateAt: 1,
  };
}

// 可变判据，各测试按需拨动
const flags = {
  generating: new Set<string>(),
  sse: new Set<string>(),
  dirty: new Set<string>(),
  store: new Map<string, Conversation>(),
  loads: 0,
};

beforeEach(() => {
  clearWorkingSet();
  flags.generating.clear();
  flags.sse.clear();
  flags.dirty.clear();
  flags.store.clear();
  flags.loads = 0;
  configureWorkingSet({
    loadConversation: (id) => {
      flags.loads += 1;
      const found = flags.store.get(id);
      return found ? { ...found, messages: [...found.messages] } : undefined;
    },
    isGenerating: (id) => flags.generating.has(id),
    hasSseClients: (id) => flags.sse.has(id),
    hasDirty: (id) => flags.dirty.has(id),
  });
});

const FUTURE = () => Date.now() + 120_000; // lastAccess 为 Date.now(),用未来时间戳判定闲置

describe("单实例保证", () => {
  test("并发 checkout 返回同一实例，仅加载一次", () => {
    flags.store.set("c1", conv("c1"));
    const a = checkoutConversation("c1");
    const b = checkoutConversation("c1");
    expect(a).toBe(b!);
    expect(flags.loads).toBe(1);
  });

  test("不存在的会话返回 undefined 且不入注册表", () => {
    expect(checkoutConversation("nope")).toBeUndefined();
    expect(workingSetSize()).toBe(0);
  });

  test("register 后 checkout 命中注册实例，不触发加载", () => {
    const c = conv("new1");
    registerConversation(c);
    expect(checkoutConversation("new1")).toBe(c);
    expect(flags.loads).toBe(0);
  });
});

describe("sweep 四条件", () => {
  function residentIdle(id: string) {
    flags.store.set(id, conv(id));
    checkoutConversation(id);
    releaseConversation(id);
  }

  test("refs>0 永不清（长 await 手术窗）", () => {
    flags.store.set("c1", conv("c1"));
    checkoutConversation("c1"); // 不 release
    expect(sweepWorkingSet(FUTURE())).toBe(0);
    expect(peekConversation("c1")).toBeDefined();
  });

  test("生成中不清", () => {
    residentIdle("c1");
    flags.generating.add("c1");
    expect(sweepWorkingSet(FUTURE())).toBe(0);
  });

  test("有 SSE 客户端不清", () => {
    residentIdle("c1");
    flags.sse.add("c1");
    expect(sweepWorkingSet(FUTURE())).toBe(0);
  });

  test("有脏标记不清", () => {
    residentIdle("c1");
    flags.dirty.add("c1");
    expect(sweepWorkingSet(FUTURE())).toBe(0);
  });

  test("闲置期内不清，过期且四条件满足才清", () => {
    residentIdle("c1");
    expect(sweepWorkingSet(Date.now())).toBe(0); // 60s 宽限内
    expect(sweepWorkingSet(FUTURE())).toBe(1);
    expect(peekConversation("c1")).toBeUndefined();
    // 清出后再 checkout 重新加载
    expect(checkoutConversation("c1")).toBeDefined();
    expect(flags.loads).toBe(2);
  });
});

describe("注册与作废", () => {
  test("同 id 重复注册替换实例内容（导入覆盖场景）", () => {
    const oldC = conv("c1");
    registerConversation(oldC);
    const newC = { ...conv("c1"), title: "imported" };
    registerConversation(newC);
    expect(peekConversation("c1")!.title).toBe("imported");
  });

  test("removeConversations / clearWorkingSet", () => {
    registerConversation(conv("c1"));
    registerConversation(conv("c2"));
    removeConversations(["c1"]);
    expect(peekConversation("c1")).toBeUndefined();
    expect(peekConversation("c2")).toBeDefined();
    clearWorkingSet();
    expect(workingSetSize()).toBe(0);
  });

  test("release 未注册 id 不抛错；refs 不为负", () => {
    releaseConversation("ghost");
    flags.store.set("c1", conv("c1"));
    checkoutConversation("c1");
    releaseConversation("c1");
    releaseConversation("c1"); // 多余 release
    expect(sweepWorkingSet(FUTURE())).toBe(1); // refs 停在 0，可清
  });
});
