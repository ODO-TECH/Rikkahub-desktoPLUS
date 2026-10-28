import type { MemoryVectorSettings } from "../foundation/types/settings/memory-vector-config";

export const MEMORY_VECTOR_LIMITS = {
  topK: [5, 50],
  minMemories: [0, 200],
  rerankTopN: [10, 100],
} as const;

export const DEFAULT_MEMORY_VECTOR_SETTINGS: MemoryVectorSettings = {
  enabled: false,
  autoIndex: true,
  topK: 20,
  minMemories: 24,
  expandNeighbors: true,
  rerankEnabled: true,
  rerankTopN: 40,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** state.json 回读用的宽容规范化：非法字段逐项回落默认，不整块丢弃。 */
export function normalizeMemoryVectorSettings(raw: unknown): MemoryVectorSettings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const defaults = DEFAULT_MEMORY_VECTOR_SETTINGS;
  return {
    enabled: input.enabled === true,
    autoIndex: input.autoIndex !== false,
    topK: clampInt(input.topK, defaults.topK, ...MEMORY_VECTOR_LIMITS.topK),
    minMemories: clampInt(input.minMemories, defaults.minMemories, ...MEMORY_VECTOR_LIMITS.minMemories),
    expandNeighbors: input.expandNeighbors !== false,
    rerankEnabled: input.rerankEnabled !== false,
    rerankTopN: clampInt(input.rerankTopN, defaults.rerankTopN, ...MEMORY_VECTOR_LIMITS.rerankTopN),
  };
}

/** API 局部更新：只认已知键；数值夹取、布尔只接受真布尔，类型不对抛可读错误。 */
export function applyMemoryVectorPatch(
  current: MemoryVectorSettings,
  patch: unknown,
): MemoryVectorSettings {
  if (!patch || typeof patch !== "object") throw new Error("settings body must be an object");
  const input = patch as Record<string, unknown>;
  const next: MemoryVectorSettings = { ...current };
  if ("enabled" in input) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
    next.enabled = input.enabled;
  }
  if ("autoIndex" in input) {
    if (typeof input.autoIndex !== "boolean") throw new Error("autoIndex must be a boolean");
    next.autoIndex = input.autoIndex;
  }
  if ("expandNeighbors" in input) {
    if (typeof input.expandNeighbors !== "boolean") throw new Error("expandNeighbors must be a boolean");
    next.expandNeighbors = input.expandNeighbors;
  }
  if ("rerankEnabled" in input) {
    if (typeof input.rerankEnabled !== "boolean") throw new Error("rerankEnabled must be a boolean");
    next.rerankEnabled = input.rerankEnabled;
  }
  for (const key of ["topK", "minMemories", "rerankTopN"] as const) {
    if (!(key in input)) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
    const [min, max] = MEMORY_VECTOR_LIMITS[key];
    next[key] = clampInt(n, next[key], min, max);
  }
  return next;
}
