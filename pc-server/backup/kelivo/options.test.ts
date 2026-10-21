import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KELIVO_SYNC_OPTIONS,
  LEGACY_KELIVO_SYNC_OPTIONS,
  normalizeKelivoSyncOptions,
} from "./options";

describe("Kelivo 同步范围解析", () => {
  test("没有显式选项时保持历史行为：助手/对话/记忆", () => {
    expect(normalizeKelivoSyncOptions(undefined)).toEqual(LEGACY_KELIVO_SYNC_OPTIONS);
    expect(normalizeKelivoSyncOptions(null)).toEqual(LEGACY_KELIVO_SYNC_OPTIONS);
  });

  test("逗号参数只打开列出的项", () => {
    const parsed = normalizeKelivoSyncOptions("conversations,models");
    expect(parsed.conversations).toBe(true);
    expect(parsed.models).toBe(true);
    expect(parsed.assistants).toBe(false);
    expect(parsed.memories).toBe(false);
    expect(parsed.worldBooks).toBe(false);
  });

  test("none 表示一项都不导", () => {
    const parsed = normalizeKelivoSyncOptions("none");
    expect(Object.values(parsed).every((value) => value === false)).toBe(true);
  });

  test("对象只接受布尔值，缺省键回退", () => {
    const parsed = normalizeKelivoSyncOptions({ models: true, worldBooks: "yes" }, DEFAULT_KELIVO_SYNC_OPTIONS);
    expect(parsed.models).toBe(true);
    expect(parsed.worldBooks).toBe(true);
    expect(parsed.conversations).toBe(true);
    expect(parsed.searchServices).toBe(true);
  });
});