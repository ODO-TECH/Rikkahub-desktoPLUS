// 心情实验的统一运行时门控。判定链路必须先经过这里；总开关关闭时不得产生任何副作用。
import { state } from "../persistence/json-store";
import type { MoodExperimentSettings } from "../foundation/types/settings/mood-experiment-config";
import { DEFAULT_MOOD_EXPERIMENT_SETTINGS } from "./config";

export function getMoodExperimentSettings(): MoodExperimentSettings {
  return state?.settings?.moodExperimentSettings ?? DEFAULT_MOOD_EXPERIMENT_SETTINGS;
}

export function moodExperimentOn(): boolean {
  return getMoodExperimentSettings().enabled === true;
}

/** 试运行：允许判定与记账（含模型调用），但不允许把心情写进提示词。 */
export function moodExperimentDryRun(): boolean {
  return getMoodExperimentSettings().dryRun !== false;
}
