// foundation/types/settings/subagent-config.ts — 子智能体(subagent_dispatch)设置面(PC 专属)
//
// 纪律:区间常量与校验只此一份——设置端点(写入)与加载归一化(读取)都消费这里,
// 服务端为准,前端只做提示。数值越界在写入侧报错拒绝(不静默夹取);加载侧对存量/
// 损坏数据宽容(逐字段回落默认),避免一个坏字段让整个 state 起不来。

/** 子智能体可挂载的工具白名单(顺序即设置页展示顺序)。subagent_dispatch 不在其中
 *  ——子面恒剔,深度锁 1 层是结构性保证(见 docs/plan-subagent.md D3)。 */
export const SUBAGENT_TOOL_WHITELIST = [
  "read",
  "grep",
  "find",
  "ls",
  "search_web",
  "scrape_web",
  "edit",
  "write",
  "bash",
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_WHITELIST)[number];

/** 默认子面:能读能写,不给 bash——bash 里的重定向写不受路径互斥锁保护(D9 代价),
 *  要开由用户在设置里显式勾选。 */
export const SUBAGENT_DEFAULT_TOOLS: SubagentToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "search_web",
  "scrape_web",
  "edit",
  "write",
];

export const SUBAGENT_LIMITS = {
  maxConcurrency: { min: 1, max: 8 },
  maxTasksPerCall: { min: 1, max: 16 },
  tokenBudget: { min: 16_000, max: 2_000_000 },
} as const;

export interface SubagentConfig {
  /** 总开关。默认关:开启后模型才能看到 subagent_dispatch 工具。 */
  enabled: boolean;
  /** 同时干活的子智能体数量上限。 */
  maxConcurrency: number;
  /** 单次 dispatch 的任务数上限。 */
  maxTasksPerCall: number;
  /** 单次 dispatch 的累计 token 预算(含所有子任务)。 */
  tokenBudget: number;
  /** 子智能体可用的工具集(白名单子集;空数组 = 只能凭 prompt 作答)。 */
  allowedTools: SubagentToolName[];
}

export type SubagentConfigPatch = Partial<SubagentConfig>;

export function defaultSubagentConfig(): SubagentConfig {
  return {
    enabled: false,
    maxConcurrency: 3,
    maxTasksPerCall: 8,
    tokenBudget: 200_000,
    allowedTools: [...SUBAGENT_DEFAULT_TOOLS],
  };
}

function isValidInteger(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** 写入侧校验(设置端点)。任何一个字段越界即整单拒绝并报明确文案——不夹取、不部分生效。 */
export function validateSubagentPatch(patch: unknown): { ok: true; value: SubagentConfigPatch } | { ok: false; error: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, error: "subagent settings patch must be a JSON object" };
  }
  const raw = patch as Record<string, unknown>;
  const value: SubagentConfigPatch = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    value.enabled = raw.enabled;
  }
  for (const key of ["maxConcurrency", "maxTasksPerCall", "tokenBudget"] as const) {
    const input = raw[key];
    if (input === undefined) continue;
    const range = SUBAGENT_LIMITS[key];
    if (!isValidInteger(input, range)) {
      return { ok: false, error: `${key} must be an integer between ${range.min} and ${range.max}` };
    }
    value[key] = input;
  }
  if (raw.allowedTools !== undefined) {
    if (!Array.isArray(raw.allowedTools) || raw.allowedTools.some((tool) => typeof tool !== "string")) {
      return { ok: false, error: "allowedTools must be an array of tool names" };
    }
    // 未知工具名静默剔除(前向兼容:旧版 PC 读到新版本导出的白名单不炸);结果去重保序。
    const whitelist = new Set<string>(SUBAGENT_TOOL_WHITELIST);
    value.allowedTools = [...new Set(raw.allowedTools.filter((tool) => whitelist.has(tool)))] as SubagentToolName[];
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "no recognized subagent settings in patch" };
  }
  return { ok: true, value };
}

/** 加载侧归一化:存量 state 无此字段、或字段损坏 → 逐字段回落默认,永不抛错。 */
export function normalizeSubagentConfig(raw: unknown): SubagentConfig {
  const defaults = defaultSubagentConfig();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : defaults.enabled;
  const maxConcurrency = isValidInteger(input.maxConcurrency, SUBAGENT_LIMITS.maxConcurrency)
    ? input.maxConcurrency
    : defaults.maxConcurrency;
  const maxTasksPerCall = isValidInteger(input.maxTasksPerCall, SUBAGENT_LIMITS.maxTasksPerCall)
    ? input.maxTasksPerCall
    : defaults.maxTasksPerCall;
  const tokenBudget = isValidInteger(input.tokenBudget, SUBAGENT_LIMITS.tokenBudget) ? input.tokenBudget : defaults.tokenBudget;
  let allowedTools = defaults.allowedTools;
  if (Array.isArray(input.allowedTools)) {
    const whitelist = new Set<string>(SUBAGENT_TOOL_WHITELIST);
    allowedTools = [...new Set(input.allowedTools.filter((tool): tool is string => typeof tool === "string" && whitelist.has(tool)))] as SubagentToolName[];
  }
  return { enabled, maxConcurrency, maxTasksPerCall, tokenBudget, allowedTools };
}
