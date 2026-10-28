// foundation/types/settings/subagent-config.test.ts — 子智能体设置面单测
// 语义:写入侧整单校验(越界即拒),加载侧逐字段宽容回落,工具白名单过滤未知项。
import { describe, expect, test } from "bun:test";
import {
  SUBAGENT_DEFAULT_TOOLS,
  defaultSubagentConfig,
  normalizeSubagentConfig,
  validateSubagentPatch,
} from "./subagent-config";

describe("subagent 设置:默认值", () => {
  test("默认关、并发 3、任务上限 8、预算 200k、子面含写不含 bash", () => {
    const defaults = defaultSubagentConfig();
    expect(defaults.enabled).toBe(false);
    expect(defaults.maxConcurrency).toBe(3);
    expect(defaults.maxTasksPerCall).toBe(8);
    expect(defaults.tokenBudget).toBe(200_000);
    expect(defaults.allowedTools).toContain("edit");
    expect(defaults.allowedTools).toContain("write");
    expect(defaults.allowedTools).not.toContain("bash");
    expect(defaults.allowedTools).toEqual([...SUBAGENT_DEFAULT_TOOLS]);
  });
});

describe("subagent 设置:写入侧校验", () => {
  test("合法整单通过并原样返回", () => {
    const result = validateSubagentPatch({
      enabled: true,
      maxConcurrency: 5,
      maxTasksPerCall: 12,
      tokenBudget: 500_000,
      allowedTools: ["read", "bash"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        enabled: true,
        maxConcurrency: 5,
        maxTasksPerCall: 12,
        tokenBudget: 500_000,
        allowedTools: ["read", "bash"],
      });
    }
  });

  test("越界/非整数/类型错误 → 整单拒绝并给明确文案", () => {
    expect(validateSubagentPatch({ maxConcurrency: 0 }).ok).toBe(false);
    expect(validateSubagentPatch({ maxConcurrency: 9 }).ok).toBe(false);
    expect(validateSubagentPatch({ maxTasksPerCall: 17 }).ok).toBe(false);
    expect(validateSubagentPatch({ tokenBudget: 15_999 }).ok).toBe(false);
    expect(validateSubagentPatch({ tokenBudget: 2_000_001 }).ok).toBe(false);
    expect(validateSubagentPatch({ maxConcurrency: 2.5 }).ok).toBe(false);
    expect(validateSubagentPatch({ enabled: "yes" }).ok).toBe(false);
    expect(validateSubagentPatch({ allowedTools: "read" }).ok).toBe(false);
    const outOfRange = validateSubagentPatch({ maxConcurrency: 99 });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error).toContain("1 and 8");
  });

  test("边界值放行", () => {
    expect(validateSubagentPatch({ maxConcurrency: 1 }).ok).toBe(true);
    expect(validateSubagentPatch({ maxConcurrency: 8 }).ok).toBe(true);
    expect(validateSubagentPatch({ maxTasksPerCall: 16 }).ok).toBe(true);
    expect(validateSubagentPatch({ tokenBudget: 16_000 }).ok).toBe(true);
    expect(validateSubagentPatch({ tokenBudget: 2_000_000 }).ok).toBe(true);
  });

  test("allowedTools 未知项剔除、重复去重、空数组合法", () => {
    const withUnknown = validateSubagentPatch({ allowedTools: ["read", "telepathy", "read"] });
    expect(withUnknown.ok).toBe(true);
    if (withUnknown.ok) expect(withUnknown.value.allowedTools).toEqual(["read"]);
    const empty = validateSubagentPatch({ allowedTools: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.allowedTools).toEqual([]);
  });

  test("空对象与非对象输入拒绝", () => {
    expect(validateSubagentPatch({}).ok).toBe(false);
    expect(validateSubagentPatch(null).ok).toBe(false);
    expect(validateSubagentPatch([1, 2]).ok).toBe(false);
  });
});

describe("subagent 设置:加载侧归一化", () => {
  test("缺失/损坏 → 回落默认,不抛错", () => {
    expect(normalizeSubagentConfig(undefined)).toEqual(defaultSubagentConfig());
    expect(normalizeSubagentConfig(null)).toEqual(defaultSubagentConfig());
    expect(normalizeSubagentConfig("nope")).toEqual(defaultSubagentConfig());
    expect(normalizeSubagentConfig({ maxConcurrency: "3" })).toEqual(defaultSubagentConfig());
    expect(normalizeSubagentConfig({ maxConcurrency: 99 })).toEqual(defaultSubagentConfig());
  });

  test("部分合法字段保留,非法字段单独回落", () => {
    const normalized = normalizeSubagentConfig({
      enabled: true,
      maxConcurrency: 6,
      tokenBudget: -1,
      allowedTools: ["read", "mind-control"],
    });
    expect(normalized.enabled).toBe(true);
    expect(normalized.maxConcurrency).toBe(6);
    expect(normalized.tokenBudget).toBe(200_000);
    expect(normalized.maxTasksPerCall).toBe(8);
    expect(normalized.allowedTools).toEqual(["read"]);
  });
});
