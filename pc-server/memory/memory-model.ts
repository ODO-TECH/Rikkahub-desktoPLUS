// memory/memory-model.ts — 记忆去重 / 整理共用的场景模型解析
// 与嵌入 / 重排同一套「设置 › 模型 › 场景模型」来源；未配置时调用方静默降级。

import { state } from "../persistence/json-store";
import { resolveSceneModel, type SceneModelRef } from "./scene-models";

export function resolveMemoryModel(): SceneModelRef | null {
  return resolveSceneModel(state.settings.memoryModelId, "CHAT");
}

export function memoryModelThinkingEnabled(): boolean {
  return state.settings.memorySettings.memoryModelThinkingEnabled === true;
}
