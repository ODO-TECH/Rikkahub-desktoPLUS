// mood/model.test.ts — 心情数值模型与门控真值表的行为锁。
// 关键约束：基调慢（÷3）、维度快、衰减不同时间常数、门控按序短路。
import { describe, expect, test } from "bun:test";

import { DEFAULT_MOOD_EXPERIMENT_SETTINGS, applyMoodExperimentPatch, normalizeMoodExperimentSettings } from "./config";
import {
  applyMoodDelta,
  buildInjectionText,
  decayMoodState,
  emptyDims,
  emptyMoodState,
  evaluateInjection,
  parseMoodDelta,
  saidToday,
  type MoodState,
} from "./model";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

function stateOf(patch: Partial<MoodState> = {}): MoodState {
  return { ...emptyMoodState("assistant:a", 70, NOW), ...patch };
}

describe("衰减", () => {
  test("心情向基线指数回归：一个半衰期走完一半", () => {
    const state = stateOf({ mood: 100, lastDecayAt: NOW });
    const next = decayMoodState(state, DEFAULT_MOOD_EXPERIMENT_SETTINGS, NOW + 12 * 3600_000);
    expect(next.mood).toBeCloseTo(85, 1);
    expect(next.lastDecayAt).toBe(NOW + 12 * 3600_000);
  });

  test("维度用固定 90 分钟半衰，比心情散得快", () => {
    const dims = { ...emptyDims(), happy: 40 };
    const next = decayMoodState(
      stateOf({ mood: 70, dims, lastDecayAt: NOW }),
      DEFAULT_MOOD_EXPERIMENT_SETTINGS,
      NOW + 12 * 3600_000,
    );
    expect(next.dims.happy).toBeLessThan(0.2);
  });

  test("不足一分钟不衰减（避免每轮抖动）", () => {
    const state = stateOf({ mood: 100, lastDecayAt: NOW });
    expect(decayMoodState(state, DEFAULT_MOOD_EXPERIMENT_SETTINGS, NOW + 30_000)).toBe(state);
  });
});

describe("落判定", () => {
  test("基调步长 ÷3 四舍五入，维度原值", () => {
    const result = applyMoodDelta(
      stateOf(),
      { moodDelta: 2, dims: { happy: 4 }, reason: "松了一口气", confidence: 90 },
      DEFAULT_MOOD_EXPERIMENT_SETTINGS,
      NOW,
    );
    expect(result.moodStep).toBe(1);
    expect(result.state.mood).toBe(71);
    expect(result.state.dims.happy).toBe(4);
    expect(result.state.updatedAt).toBe(NOW);
    expect(result.changed).toBe(true);
    expect(result.minor).toBe(true);
  });

  test("达到显著阈值才算显性变化", () => {
    const result = applyMoodDelta(
      stateOf(),
      { moodDelta: 3, dims: {}, reason: "心里亮了一下", confidence: 90 },
      DEFAULT_MOOD_EXPERIMENT_SETTINGS,
      NOW,
    );
    expect(result.minor).toBe(false);
  });

  test("全零判定不更新 updatedAt、不产生时间线", () => {
    const state = stateOf({ mood: 70, updatedAt: 111 });
    const result = applyMoodDelta(
      state,
      { moodDelta: 0, dims: {}, reason: "这一轮没有可辨情绪变化", confidence: 70 },
      DEFAULT_MOOD_EXPERIMENT_SETTINGS,
      NOW,
    );
    expect(result.changed).toBe(false);
    expect(result.state.updatedAt).toBe(111);
  });

  test("心情与维度都夹取边界", () => {
    const high = applyMoodDelta(
      stateOf({ mood: 99 }),
      { moodDelta: 10, dims: { happy: 10 }, reason: "", confidence: 80 },
      DEFAULT_MOOD_EXPERIMENT_SETTINGS,
      NOW,
    );
    expect(high.state.mood).toBe(100);
    expect(high.state.dims.happy).toBe(10);
    const floor = applyMoodDelta(
      stateOf({ mood: 1 }),
      { moodDelta: -10, dims: {}, reason: "", confidence: 80 },
      { ...DEFAULT_MOOD_EXPERIMENT_SETTINGS, moodFloor: 5 },
      NOW,
    );
    expect(floor.state.mood).toBe(5);
  });
});

describe("模型输出解析", () => {
  test("带围栏与前后废话也能取到 JSON", () => {
    const delta = parseMoodDelta('好的\n```json\n{"moodDelta":2,"dims":{"happy":3},"reason":"被暖到","confidence":88}\n```');
    expect(delta).not.toBeNull();
    expect(delta!.moodDelta).toBe(2);
    expect(delta!.dims.happy).toBe(3);
    expect(delta!.confidence).toBe(88);
  });

  test("越界字段夹取，缺 confidence 兜底 70", () => {
    const delta = parseMoodDelta('{"moodDelta":99,"dims":{"sad":-99},"reason":"x"}');
    expect(delta!.moodDelta).toBe(10);
    expect(delta!.dims.sad).toBe(-10);
    expect(delta!.confidence).toBe(70);
  });

  test("非 JSON 返回 null", () => {
    expect(parseMoodDelta("今天心情不错")).toBeNull();
    expect(parseMoodDelta("")).toBeNull();
  });
});

describe("注入门控真值表", () => {
  const settings = { ...DEFAULT_MOOD_EXPERIMENT_SETTINGS, dryRun: false };
  const judged = stateOf({ kind: "judge", updatedAt: NOW, lastConfidence: 90, mood: 80, lastReason: "被暖到" });

  test("dryRun 一律不注入", () => {
    expect(evaluateInjection(judged, DEFAULT_MOOD_EXPERIMENT_SETTINGS, NOW)).toBe("dry_run");
  });

  test("还没判定过 → no_change", () => {
    expect(evaluateInjection(stateOf(), settings, NOW)).toBe("no_change");
  });

  test("同一次变化只说一次", () => {
    expect(evaluateInjection({ ...judged, injectedFor: NOW }, settings, NOW)).toBe("already_said");
  });

  test("小波动 / 低置信度 / 日额度分别拦截", () => {
    expect(evaluateInjection({ ...judged, minor: true }, settings, NOW)).toBe("minor");
    expect(evaluateInjection({ ...judged, lastConfidence: 40 }, settings, NOW)).toBe("low_confidence");
    expect(
      evaluateInjection({ ...judged, saidAt: Array.from({ length: 6 }, () => NOW - 1000) }, settings, NOW),
    ).toBe("daily_limit");
  });

  test("全部通过 → say，且文本带反模仿句", () => {
    expect(evaluateInjection(judged, settings, NOW)).toBe("say");
    const text = buildInjectionText(judged, settings, "小鱼", NOW);
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("别把这段念出来");
  });

  test("单行模式只给一句基调 + 缘由", () => {
    const text = buildInjectionText(judged, { ...settings, injectMode: "label" }, "小鱼", NOW);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("心里");
    expect(text).toContain("被暖到");
  });

  test("三行模式带上最强维度与时间词", () => {
    const text = buildInjectionText(
      { ...judged, dims: { ...emptyDims(), sweet: 6 } },
      settings,
      "小鱼",
      NOW,
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("甜蜜");
    expect(lines[1]).toMatch(/^[^（]+，被暖到$/);
  });

  test("saidToday 只数今天零点之后", () => {
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    const state = stateOf({ saidAt: [midnight.getTime() - 1, midnight.getTime() + 1] });
    expect(saidToday(state, NOW)).toBe(1);
  });
});

describe("设置规范化", () => {
  test("未知键忽略，非法值回默认", () => {
    const next = normalizeMoodExperimentSettings({ enabled: true, decayHalfHours: "abc", injectMode: "loud" });
    expect(next.enabled).toBe(true);
    expect(next.decayHalfHours).toBe(12);
    expect(next.injectMode).toBe("event");
    expect(next.dryRun).toBe(true);
  });

  test("旧值 off 已退役：注入方式只剩 label / event", () => {
    const next = normalizeMoodExperimentSettings({ injectMode: "off" });
    expect(next.injectMode).toBe("event");
    expect(() => applyMoodExperimentPatch(DEFAULT_MOOD_EXPERIMENT_SETTINGS, { injectMode: "off" })).toThrow();
    expect(applyMoodExperimentPatch(DEFAULT_MOOD_EXPERIMENT_SETTINGS, { injectMode: "label" }).injectMode).toBe("label");
  });

  test("局部更新拒绝错误类型", () => {
    expect(() => applyMoodExperimentPatch(DEFAULT_MOOD_EXPERIMENT_SETTINGS, { enabled: "yes" })).toThrow();
    expect(() => applyMoodExperimentPatch(DEFAULT_MOOD_EXPERIMENT_SETTINGS, { injectMode: "loud" })).toThrow();
    const next = applyMoodExperimentPatch(DEFAULT_MOOD_EXPERIMENT_SETTINGS, { injectPerDay: 999, moodModelId: " m1 " });
    expect(next.injectPerDay).toBe(48);
    expect(next.moodModelId).toBe("m1");
  });
});
