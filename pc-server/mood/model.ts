// mood/model.ts — 心情数值模型（纯函数：不读配置、不碰数据库）。
// 与 DSH dsh-feiyu-mood 对齐的三条口径：基调步长 ÷3（防长期贴顶）、维度原值累加、
// 心情与维度用不同时间常数做指数回归（隔夜留余温，情绪细节先散）。
import type { MoodExperimentSettings } from "../foundation/types/settings/mood-experiment-config";

export const MOOD_DIMS = ["happy", "calm", "sweet", "heartache", "worry", "sad", "jealous"] as const;
export type MoodDim = (typeof MOOD_DIMS)[number];
export type MoodDims = Record<MoodDim, number>;

export const MOOD_STEP_DIVISOR = 3;
/** 维度衰减的半衰期（分钟）。固定值，不随设置变化。 */
export const DIM_DECAY_MINUTES = 90;
const MAX_DELTA = 10;
const REASON_LIMIT = 120;

export const MOOD_DIM_LABELS: Record<MoodDim, string> = {
  happy: "开心",
  calm: "踏实",
  sweet: "甜蜜",
  heartache: "心疼",
  worry: "担心",
  sad: "难过",
  jealous: "吃醋",
};

export interface MoodState {
  key: string;
  mood: number;
  dims: MoodDims;
  lastReason: string;
  lastConfidence: number;
  /** 本次变化是否小于显著阈值（小波动只记账，不打扰）。 */
  minor: boolean;
  /** "" = 还没有任何一次有效判定。 */
  kind: "" | "judge";
  /** 最后一次「实质变化」的时间。没变化的判定只更新计数与理由，不动它。 */
  updatedAt: number;
  lastDecayAt: number;
  lastNotedMood: number;
  /** 已经因为哪次 updatedAt 说过心情（一次变化只说一次）。 */
  injectedFor: number | null;
  saidAt: number[];
  judgeCalls: number;
  judgeFailures: number;
}

export interface MoodDelta {
  moodDelta: number;
  dims: Partial<MoodDims>;
  reason: string;
  confidence: number;
}

export function emptyDims(): MoodDims {
  return { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 };
}

export function emptyMoodState(key: string, base: number, now: number): MoodState {
  return {
    key,
    mood: base,
    dims: emptyDims(),
    lastReason: "",
    lastConfidence: 0,
    minor: false,
    kind: "",
    updatedAt: 0,
    lastDecayAt: now,
    lastNotedMood: base,
    injectedFor: null,
    saidAt: [],
    judgeCalls: 0,
    judgeFailures: 0,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampDelta(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return clampNumber(Math.round(n), -MAX_DELTA, MAX_DELTA);
}

/** 指数回归：心情趋近基线（半衰期可配），维度各自向 0 收敛（固定 90 分钟半衰）。 */
export function decayMoodState(state: MoodState, settings: MoodExperimentSettings, now: number): MoodState {
  const ageMin = (now - state.lastDecayAt) / 60000;
  if (!(ageMin >= 1)) return state;
  const halfHours = Math.max(1, settings.decayHalfHours);
  const moodRatio = 1 - Math.exp(-(Math.LN2 * ageMin) / (halfHours * 60));
  const dimRatio = 1 - Math.exp(-(Math.LN2 * ageMin) / DIM_DECAY_MINUTES);
  const mood = clampNumber(state.mood + (settings.moodBase - state.mood) * moodRatio, settings.moodFloor, 100);
  const dims = { ...state.dims };
  for (const dim of MOOD_DIMS) dims[dim] = state.dims[dim] * (1 - dimRatio);
  return { ...state, mood, dims, lastDecayAt: now };
}

export interface ApplyResult {
  state: MoodState;
  changed: boolean;
  minor: boolean;
  moodStep: number;
}

/** 落一次判定：基调吃 ÷3，维度原值；只有实质变化才更新 updatedAt（一次变化只说一次的依据）。 */
export function applyMoodDelta(
  state: MoodState,
  delta: MoodDelta,
  settings: MoodExperimentSettings,
  now: number,
): ApplyResult {
  const moodStep = Math.round(delta.moodDelta / MOOD_STEP_DIVISOR);
  const dimSteps: Partial<Record<MoodDim, number>> = {};
  let dimChanged = false;
  for (const dim of MOOD_DIMS) {
    const step = clampDelta(delta.dims[dim] ?? 0);
    if (step !== 0) {
      dimSteps[dim] = step;
      dimChanged = true;
    }
  }
  const changed = moodStep !== 0 || dimChanged;
  const mood = clampNumber(state.mood + moodStep, settings.moodFloor, 100);
  const dims = { ...state.dims };
  for (const dim of MOOD_DIMS) {
    const step = dimSteps[dim];
    if (step) dims[dim] = clampNumber(state.dims[dim] + step, 0, 100);
  }
  const significant = Math.abs(delta.moodDelta) >= settings.sigMood
    || MOOD_DIMS.some((dim) => Math.abs(dimSteps[dim] ?? 0) >= settings.sigDim);
  const next: MoodState = {
    ...state,
    mood,
    dims,
    lastReason: delta.reason,
    lastConfidence: delta.confidence,
  };
  if (!changed) return { state: next, changed: false, minor: false, moodStep };
  next.kind = "judge";
  next.minor = !significant;
  next.updatedAt = now;
  next.lastDecayAt = now;
  next.lastNotedMood = mood;
  return { state: next, changed: true, minor: !significant, moodStep };
}

/** 从模型输出里取第一个 { 到最后一个 }，逐字段 clamp；结构不成形则返回 null。 */
export function parseMoodDelta(raw: string): MoodDelta | null {
  const text = raw.trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const input = parsed as Record<string, unknown>;
  const rawDims = input.dims && typeof input.dims === "object" ? (input.dims as Record<string, unknown>) : {};
  const dims: Partial<MoodDims> = {};
  for (const dim of MOOD_DIMS) {
    const step = clampDelta(rawDims[dim] ?? 0);
    if (step !== 0) dims[dim] = step;
  }
  const confidenceRaw = Number(input.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? clampNumber(Math.round(confidenceRaw), 0, 100) : 70;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, REASON_LIMIT) : "";
  return { moodDelta: clampDelta(input.moodDelta ?? 0), dims, reason, confidence };
}

export function strongestDim(dims: MoodDims): MoodDim | null {
  let best: MoodDim | null = null;
  for (const dim of MOOD_DIMS) {
    if (!best || dims[dim] > dims[best]) best = dim;
  }
  return best && dims[best] > 0.5 ? best : null;
}

export function moodBandLabel(mood: number): string {
  if (mood >= 80) return "心里是亮堂的";
  if (mood >= 62) return "心里平常";
  if (mood >= 42) return "心里有点发闷";
  if (mood >= 25) return "心里沉甸甸的";
  return "心里很不好受";
}

export type InjectionDecision =
  | "dry_run"
  | "no_change"
  | "already_said"
  | "minor"
  | "low_confidence"
  | "daily_limit"
  | "say";

export function saidToday(state: MoodState, now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const edge = midnight.getTime();
  return state.saidAt.filter((at) => Number(at) >= edge).length;
}

/** M0 规格里的门控真值表，按序短路。注入与否的唯一判据（预览与 M2 注入共用）。 */
export function evaluateInjection(
  state: MoodState,
  settings: MoodExperimentSettings,
  now: number,
): InjectionDecision {
  if (settings.dryRun !== false) return "dry_run";
  if (state.kind === "") return "no_change";
  if (state.injectedFor === state.updatedAt) return "already_said";
  if (state.minor) return "minor";
  if (Number(state.lastConfidence) < settings.injectConfidence) return "low_confidence";
  if (saidToday(state, now) >= Math.max(0, settings.injectPerDay)) return "daily_limit";
  return "say";
}

function timeWord(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "夜里";
  if (hour < 9) return "一大早";
  if (hour < 12) return "上午";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  if (hour < 22) return "傍晚";
  return "晚上";
}

/** 注入文本。event = 基调 / 缘由 / 反模仿句三行；label = 单行。空串 = 无可注入内容。 */
export function buildInjectionText(
  state: MoodState,
  settings: MoodExperimentSettings,
  ownerName: string,
  now: number,
): string {
  if (state.kind === "") return "";
  const band = moodBandLabel(state.mood);
  const top = strongestDim(state.dims);
  const reason = state.lastReason || "心里回到了平常的样子";
  if (settings.injectMode === "label") {
    return `${band}，${reason}（别把这句话念出来）`;
  }
  const basis = top ? `${band}，还带着点${MOOD_DIM_LABELS[top]}` : band;
  const who = ownerName.trim() || "对方";
  return [
    `（这会儿）${basis}`,
    `${timeWord(now)}，${reason}`,
    `这是这会儿的底子，不是非这样不可——${who}说别的，你按自己的判断接，也别把这段念出来。`,
  ].join("\n");
}
