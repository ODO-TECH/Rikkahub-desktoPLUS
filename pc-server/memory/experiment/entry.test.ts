// memory/experiment/entry.test.ts — 实验字段纯函数的形状锁。
// 只测不依赖全局状态的部分：归一化、保护、权重、合并去重时的分类/标签继承。
import { describe, expect, test } from "bun:test";

import {
  isForgettable,
  isProtectedMemory,
  isRecallableStatus,
  isVisibleStatus,
  memoryWeight,
  mergeMemoryFacets,
  normalizeMemoryFacets,
  normalizeMemoryKind,
  normalizeMemoryStatus,
  strongerMemoryKind,
  withMemoryExperimentDefaults,
} from "./entry";

describe("记忆分类与状态归一化", () => {
  test("未知 kind / status 回落到 unclassified / active", () => {
    expect(normalizeMemoryKind("preference")).toBe("unclassified");
    expect(normalizeMemoryKind(undefined)).toBe("unclassified");
    expect(normalizeMemoryKind("setting")).toBe("setting");
    expect(normalizeMemoryStatus("deleted")).toBe("active");
    expect(normalizeMemoryStatus("superseded")).toBe("superseded");
  });

  test("稀疏 facets：空串与空 tags 不落键", () => {
    expect(normalizeMemoryFacets({ time: "  ", place: "上海", tags: ["", "旅行", "旅行", " 美食 "] })).toEqual({
      place: "上海",
      tags: ["旅行", "美食"],
    });
    expect(normalizeMemoryFacets({})).toBeNull();
    expect(normalizeMemoryFacets("not-an-object")).toBeNull();
  });

  test("withMemoryExperimentDefaults 补齐缺省且不改 content", () => {
    const entry = withMemoryExperimentDefaults({
      id: 1,
      content: "喜欢帕秋莉",
      createdAt: 1,
      updatedAt: 2,
      source: "ai",
    });
    expect(entry.kind).toBe("unclassified");
    expect(entry.status).toBe("active");
    expect(entry.explicitRemember).toBe(false);
    expect(entry.mentionCount).toBe(0);
    expect(entry.content).toBe("喜欢帕秋莉");
  });
});

describe("不可遗忘区与权重", () => {
  test("设定类与显式记住受保护；习惯不自动删除但可 stale", () => {
    expect(isProtectedMemory({ kind: "setting", explicitRemember: false })).toBe(true);
    expect(isProtectedMemory({ kind: "event", explicitRemember: true })).toBe(true);
    expect(isProtectedMemory({ kind: "habit", explicitRemember: false })).toBe(false);
  });

  test("只有未受保护的事件类可被第二轮失真", () => {
    expect(isForgettable({ kind: "event", explicitRemember: false, status: "active" })).toBe(true);
    expect(isForgettable({ kind: "event", explicitRemember: true, status: "active" })).toBe(false);
    expect(isForgettable({ kind: "habit", explicitRemember: false, status: "active" })).toBe(false);
    expect(isForgettable({ kind: "event", explicitRemember: false, status: "stale" })).toBe(false);
  });

  test("stale 仍可见，其余非 active 状态隐藏", () => {
    expect(isVisibleStatus("active")).toBe(true);
    expect(isVisibleStatus("stale")).toBe(true);
    expect(isVisibleStatus("superseded")).toBe(false);
    expect(isVisibleStatus("tombstone")).toBe(false);
  });

  test("语义召回池只收 active：stale 可注入但不参与相似度竞争", () => {
    expect(isRecallableStatus("active")).toBe(true);
    expect(isRecallableStatus(undefined)).toBe(true);
    expect(isRecallableStatus("stale")).toBe(false);
    expect(isRecallableStatus("superseded")).toBe(false);
    expect(isRecallableStatus("archived")).toBe(false);
    expect(isRecallableStatus("tombstone")).toBe(false);
  });

  test("权重排序：设定 > 显式记住 > 习惯 > 事件；提及加成封顶 30", () => {
    expect(memoryWeight({ kind: "setting", explicitRemember: false, mentionCount: 0 })).toBe(100);
    expect(memoryWeight({ kind: "event", explicitRemember: true, mentionCount: 0 })).toBe(90);
    expect(memoryWeight({ kind: "habit", explicitRemember: false, mentionCount: 0 })).toBe(60);
    expect(memoryWeight({ kind: "event", explicitRemember: false, mentionCount: 0 })).toBe(20);
    expect(memoryWeight({ kind: "event", explicitRemember: false, mentionCount: 100 })).toBe(50);
  });
});

describe("合并去重时的实验字段继承", () => {
  test("分类只升不降", () => {
    expect(strongerMemoryKind("event", "setting")).toBe("setting");
    expect(strongerMemoryKind("setting", "event")).toBe("setting");
    expect(strongerMemoryKind(undefined, "habit")).toBe("habit");
    expect(strongerMemoryKind("habit", undefined)).toBe("habit");
  });

  test("标签取并集，其余键以新值为准", () => {
    expect(mergeMemoryFacets(
      { place: "旧地点", tags: ["草莓", "水果"] },
      { place: "新地点", person: "帕秋莉", tags: ["西瓜", "水果"] },
    )).toEqual({
      place: "新地点",
      person: "帕秋莉",
      tags: ["草莓", "水果", "西瓜"],
    });
    expect(mergeMemoryFacets(null, { time: "上周" })).toEqual({ time: "上周" });
    expect(mergeMemoryFacets({ time: "上周" }, null)).toEqual({ time: "上周" });
  });
});
