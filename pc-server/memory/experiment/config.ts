// 实验设置：默认值、state.json 宽容规范化、API 局部更新（纯函数，不 import 运行时状态）。
// 与 memory/vector-settings.ts 同款分层：配置文件不读 state，门控在 gate.ts。
import type { MemoryExperimentSettings } from "../../foundation/types/settings/memory-experiment-config";

export const MEMORY_EXPERIMENT_LIMITS = {
  hotMentionThreshold: [2, 50],
  eventDistillDays: [1, 365],
  habitDistillDays: [1, 365],
  purgeAfterDays: [0, 365],
  maxCandidatesPerCompaction: [0, 20],
  dynamicRecallTopK: [1, 20],
} as const;

export const DEFAULT_MEMORY_EXPERIMENT_SETTINGS: MemoryExperimentSettings = {
  enabled: false,
  dryRun: true,
  structuredIntake: false,
  compactionCandidates: false,
  mergeProposals: false,
  mentionScoring: false,
  maintenance: false,
  statusRecall: false,
  dynamicRecall: false,
  llmAssist: false,
  autoApplySafe: false,
  hotMentionThreshold: 5,
  eventDistillDays: 7,
  habitDistillDays: 14,
  purgeAfterDays: 30,
  maxCandidatesPerCompaction: 6,
  dynamicRecallTopK: 6,
};

const BOOLEAN_KEYS = [
  "enabled",
  "dryRun",
  "structuredIntake",
  "compactionCandidates",
  "mergeProposals",
  "mentionScoring",
  "maintenance",
  "statusRecall",
  "dynamicRecall",
  "llmAssist",
  "autoApplySafe",
] as const;

const NUMBER_KEYS = [
  "hotMentionThreshold",
  "eventDistillDays",
  "habitDistillDays",
  "purgeAfterDays",
  "maxCandidatesPerCompaction",
  "dynamicRecallTopK",
] as const;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeMemoryExperimentSettings(raw: unknown): MemoryExperimentSettings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_MEMORY_EXPERIMENT_SETTINGS;
  const next: MemoryExperimentSettings = { ...defaults };
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === "boolean") next[key] = input[key] as boolean;
  }
  for (const key of NUMBER_KEYS) {
    const [min, max] = MEMORY_EXPERIMENT_LIMITS[key];
    next[key] = clampInt(input[key], defaults[key], min, max);
  }
  return next;
}

/** 是否正从「只试运行」切换到「可执行失真/清除」——需要用户确认并先跑过一轮扫描。
 *  已处于可执行状态时再改其他开关不重复要确认。 */
export function needsForgettingUnlock(
  current: MemoryExperimentSettings,
  next: MemoryExperimentSettings,
): boolean {
  const armed = (settings: MemoryExperimentSettings) =>
    settings.enabled === true && settings.dryRun === false && settings.maintenance === true;
  return !armed(current) && armed(next);
}

/** API 局部更新：只认已知键；布尔必须是真布尔，数值夹取，类型不对抛可读错误。 */
export function applyMemoryExperimentPatch(
  current: MemoryExperimentSettings,
  patch: unknown,
): MemoryExperimentSettings {
  if (!patch || typeof patch !== "object") throw new Error("settings body must be an object");
  const input = patch as Record<string, unknown>;
  const next: MemoryExperimentSettings = { ...current };
  for (const key of BOOLEAN_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean`);
    next[key] = input[key] as boolean;
  }
  for (const key of NUMBER_KEYS) {
    if (!(key in input)) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    const [min, max] = MEMORY_EXPERIMENT_LIMITS[key];
    next[key] = clampInt(n, next[key], min, max);
  }
  return next;
}
