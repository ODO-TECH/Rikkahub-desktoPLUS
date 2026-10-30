// 心情实验设置：默认值、state.json 宽容规范化、API 局部更新（纯函数，不 import 运行时状态）。
// 与 memory/experiment/config.ts 同款分层：本文件不读 state，门控在 gate.ts。
import type {
  MoodExperimentSettings,
  MoodInjectMode,
} from "../foundation/types/settings/mood-experiment-config";

export const MOOD_EXPERIMENT_LIMITS = {
  moodBase: [0, 100],
  moodFloor: [0, 100],
  decayHalfHours: [1, 72],
  sigMood: [1, 20],
  sigDim: [1, 30],
  injectConfidence: [0, 100],
  injectPerDay: [0, 48],
} as const;

export const DEFAULT_MOOD_EXPERIMENT_SETTINGS: MoodExperimentSettings = {
  enabled: false,
  dryRun: true,
  moodModelId: "",
  moodBase: 70,
  moodFloor: 0,
  decayHalfHours: 12,
  sigMood: 3,
  sigDim: 5,
  injectConfidence: 60,
  injectPerDay: 6,
  injectMode: "event",
};

const BOOLEAN_KEYS = ["enabled", "dryRun"] as const;

const NUMBER_KEYS = [
  "moodBase",
  "moodFloor",
  "decayHalfHours",
  "sigMood",
  "sigDim",
  "injectConfidence",
  "injectPerDay",
] as const;

const INJECT_MODES: readonly MoodInjectMode[] = ["label", "event"];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeInjectMode(value: unknown): MoodInjectMode {
  return INJECT_MODES.includes(value as MoodInjectMode)
    ? (value as MoodInjectMode)
    : DEFAULT_MOOD_EXPERIMENT_SETTINGS.injectMode;
}

export function normalizeMoodExperimentSettings(raw: unknown): MoodExperimentSettings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_MOOD_EXPERIMENT_SETTINGS;
  const next: MoodExperimentSettings = { ...defaults };
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === "boolean") next[key] = input[key] as boolean;
  }
  for (const key of NUMBER_KEYS) {
    const [min, max] = MOOD_EXPERIMENT_LIMITS[key];
    next[key] = clampInt(input[key], defaults[key], min, max);
  }
  next.moodModelId = typeof input.moodModelId === "string" ? input.moodModelId.trim() : "";
  next.injectMode = normalizeInjectMode(input.injectMode);
  return next;
}

/** API 局部更新：只认已知键；布尔必须是真布尔，数值夹取，类型不对抛可读错误。 */
export function applyMoodExperimentPatch(
  current: MoodExperimentSettings,
  patch: unknown,
): MoodExperimentSettings {
  if (!patch || typeof patch !== "object") throw new Error("settings body must be an object");
  const input = patch as Record<string, unknown>;
  const next: MoodExperimentSettings = { ...current };
  for (const key of BOOLEAN_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    next[key] = input[key] as boolean;
  }
  for (const key of NUMBER_KEYS) {
    if (!(key in input)) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    const [min, max] = MOOD_EXPERIMENT_LIMITS[key];
    next[key] = clampInt(n, next[key], min, max);
  }
  if ("moodModelId" in input) {
    if (typeof input.moodModelId !== "string") throw new Error("moodModelId must be a string");
    next.moodModelId = input.moodModelId.trim();
  }
  if ("injectMode" in input) {
    if (!INJECT_MODES.includes(input.injectMode as MoodInjectMode)) {
      throw new Error(`injectMode must be one of ${INJECT_MODES.join(" / ")}`);
    }
    next.injectMode = input.injectMode as MoodInjectMode;
  }
  return next;
}
