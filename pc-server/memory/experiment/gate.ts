// 统一运行时门控。所有实验行为（解析、合并、失真、召回、压缩后置、提及计分）
// 必须先经过这里；总开关关闭时任何调用方都不得产生副作用。
import { state } from "../../persistence/json-store";
import type { MemoryExperimentSettings } from "../../foundation/types/settings/memory-experiment-config";
import { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } from "./config";

export type MemoryExperimentFeature =
  | "structuredIntake"
  | "compactionCandidates"
  | "mergeProposals"
  | "mentionScoring"
  | "maintenance"
  | "statusRecall"
  | "dynamicRecall";

export function getMemoryExperimentSettings(): MemoryExperimentSettings {
  const raw = state?.settings?.memoryExperimentSettings;
  return raw ?? DEFAULT_MEMORY_EXPERIMENT_SETTINGS;
}

/** 总开关。关闭 = 与原实现逐字节一致（除读取 active 状态这一无副作用过滤）。 */
export function memoryExperimentOn(): boolean {
  return getMemoryExperimentSettings().enabled === true;
}

/** 单项功能开关：总开关关时恒 false。 */
export function memoryExperimentFeature(feature: MemoryExperimentFeature): boolean {
  const settings = getMemoryExperimentSettings();
  return settings.enabled === true && settings[feature] === true;
}

/** 试运行：允许生成审计提案，但不允许改记忆内容 / 状态 / 删除。 */
export function memoryExperimentDryRun(): boolean {
  return getMemoryExperimentSettings().dryRun !== false;
}

/** 是否允许真正修改数据（总开关开 + 非 dry-run）。 */
export function memoryExperimentMutates(): boolean {
  return memoryExperimentOn() && !memoryExperimentDryRun();
}

/** 是否允许调用记忆场景模型（可能计费）。dry-run 下允许，因为只生成提案。 */
export function memoryExperimentLlmAllowed(): boolean {
  return memoryExperimentOn() && getMemoryExperimentSettings().llmAssist === true;
}
