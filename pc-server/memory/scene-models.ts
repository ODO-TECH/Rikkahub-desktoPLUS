// memory/scene-models.ts — 从全局场景档严格解析非聊天模型
// 「设置 › 模型 › 场景模型」存的是 Model.id；这里按 id 反查并将 providerOverwrite
// 叠到父供应商上（与 model-providers.findModel 同一投影规则），但**不做聊天模型兜底**：
// 场景档未配置或类型不符时必须返回 null，让调用方降级而不是悄悄拿聊天模型打 /embeddings。

import type { Model, Provider } from "../foundation/types";
import { state } from "../persistence/json-store";
import { modelKeyOf } from "./vector-store";

export interface SceneModelRef {
  provider: Provider;
  model: Model;
  /** `${providerId}::${modelId}`，向量表按它判定「换模型即失效」。 */
  modelKey: string;
  displayName: string;
}

function effectiveProvider(provider: Provider, modelItem: Model): Provider {
  const overwrite = modelItem.providerOverwrite;
  if (overwrite && typeof overwrite === "object" && overwrite.type) {
    return { ...provider, ...overwrite, id: provider.id, models: [] } as Provider;
  }
  return provider;
}

export function resolveSceneModel(
  modelId: string | null | undefined,
  expectedType: "CHAT" | "EMBEDDING" | "RERANK",
): SceneModelRef | null {
  const wanted = String(modelId ?? "").trim();
  if (!wanted) return null;
  for (const provider of state.settings.providers) {
    const modelItem = provider.models.find((item) => item.id === wanted);
    if (!modelItem) continue;
    if (String(modelItem.type ?? "").toUpperCase() !== expectedType) return null;
    return {
      provider: effectiveProvider(provider, modelItem),
      model: modelItem,
      modelKey: modelKeyOf(provider.id, modelItem.modelId),
      displayName: modelItem.displayName || modelItem.modelId,
    };
  }
  return null;
}

export function resolveEmbeddingModel(): SceneModelRef | null {
  return resolveSceneModel(state.settings.embeddingModelId, "EMBEDDING");
}

export function resolveRerankModel(): SceneModelRef | null {
  return resolveSceneModel(state.settings.rerankModelId, "RERANK");
}
