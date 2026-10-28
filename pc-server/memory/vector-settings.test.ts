// memory/vector-settings.test.ts — 特性 C 设置切片的默认值、回读规范化与 API 局部更新。
// 纪律：非法值逐项回落/夹取，不因一个坏字段丢掉整块设置；未知键忽略（旧前端/新前端混跑安全）。
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MEMORY_VECTOR_SETTINGS,
  MEMORY_VECTOR_LIMITS,
  applyMemoryVectorPatch,
  normalizeMemoryVectorSettings,
} from "./vector-settings";

describe("默认值与规范化", () => {
  test("缺省/非对象回落到默认设置", () => {
    expect(normalizeMemoryVectorSettings(undefined)).toEqual(DEFAULT_MEMORY_VECTOR_SETTINGS);
    expect(normalizeMemoryVectorSettings(null)).toEqual(DEFAULT_MEMORY_VECTOR_SETTINGS);
    expect(normalizeMemoryVectorSettings("oops")).toEqual(DEFAULT_MEMORY_VECTOR_SETTINGS);
  });

  test("默认关闭:未显式开启前零网络请求", () => {
    expect(DEFAULT_MEMORY_VECTOR_SETTINGS.enabled).toBe(false);
    expect(normalizeMemoryVectorSettings({ enabled: "true" }).enabled).toBe(false);
    expect(normalizeMemoryVectorSettings({ enabled: true }).enabled).toBe(true);
  });

  test("布尔项只认显式 false;缺省保持开启", () => {
    const normalized = normalizeMemoryVectorSettings({ autoIndex: false, expandNeighbors: false, rerankEnabled: false });
    expect(normalized.autoIndex).toBe(false);
    expect(normalized.expandNeighbors).toBe(false);
    expect(normalized.rerankEnabled).toBe(false);
    expect(normalizeMemoryVectorSettings({ autoIndex: "no" }).autoIndex).toBe(true);
  });

  test("数值夹取到设计范围并取整", () => {
    expect(normalizeMemoryVectorSettings({ topK: 1 }).topK).toBe(MEMORY_VECTOR_LIMITS.topK[0]);
    expect(normalizeMemoryVectorSettings({ topK: 999 }).topK).toBe(MEMORY_VECTOR_LIMITS.topK[1]);
    expect(normalizeMemoryVectorSettings({ topK: 12.6 }).topK).toBe(13);
    expect(normalizeMemoryVectorSettings({ minMemories: -5 }).minMemories).toBe(0);
    expect(normalizeMemoryVectorSettings({ minMemories: 999 }).minMemories).toBe(200);
    expect(normalizeMemoryVectorSettings({ rerankTopN: 3 }).rerankTopN).toBe(10);
    expect(normalizeMemoryVectorSettings({ rerankTopN: 999 }).rerankTopN).toBe(100);
  });

  test("非法数值按字段回落默认,其他字段仍保留", () => {
    const normalized = normalizeMemoryVectorSettings({ topK: "abc", minMemories: 30, enabled: true });
    expect(normalized.topK).toBe(DEFAULT_MEMORY_VECTOR_SETTINGS.topK);
    expect(normalized.minMemories).toBe(30);
    expect(normalized.enabled).toBe(true);
  });
});

describe("applyMemoryVectorPatch", () => {
  test("只更新出现的键,其余保持当前值", () => {
    const current = { ...DEFAULT_MEMORY_VECTOR_SETTINGS, topK: 25 };
    const next = applyMemoryVectorPatch(current, { enabled: true });
    expect(next).toEqual({ ...current, enabled: true });
    expect(current.enabled).toBe(false);
  });

  test("数值越界夹取、浮点取整", () => {
    const next = applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, {
      topK: 2,
      minMemories: 999,
      rerankTopN: 33.4,
    });
    expect(next.topK).toBe(5);
    expect(next.minMemories).toBe(200);
    expect(next.rerankTopN).toBe(33);
  });

  test("未知键忽略,不污染设置", () => {
    const next = applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { mystery: 1, topK: 30 });
    expect(next).toEqual({ ...DEFAULT_MEMORY_VECTOR_SETTINGS, topK: 30 });
  });

  test("布尔类型错误直接报错(不静默转换)", () => {
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { enabled: 1 })).toThrow("enabled must be a boolean");
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { autoIndex: "yes" })).toThrow("autoIndex must be a boolean");
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { rerankEnabled: null })).toThrow(
      "rerankEnabled must be a boolean",
    );
  });

  test("数值类型错误直接报错", () => {
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { topK: "many" })).toThrow("topK must be a number");
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, { minMemories: Number.NaN })).toThrow(
      "minMemories must be a number",
    );
  });

  test("非对象请求体直接报错", () => {
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, null)).toThrow("settings body must be an object");
    expect(() => applyMemoryVectorPatch(DEFAULT_MEMORY_VECTOR_SETTINGS, "x")).toThrow("settings body must be an object");
  });
});
