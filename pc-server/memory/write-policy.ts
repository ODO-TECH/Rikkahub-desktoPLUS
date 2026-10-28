// memory/write-policy.ts — 助手级记忆写入范围解析（对齐 Kelivo MemoryWriteScope）
// 纪律：纯函数，只读 state 的层开关与助手字段，不写记忆。

import type { Assistant } from "../foundation/types";
import { state } from "../persistence/json-store";

export type MemoryWriteTarget = "global" | "assistant";

export type ResolvedMemoryWrite =
  | { scope: MemoryWriteTarget }
  | { pending: true }
  | { readonly: true };

export function canAssistantWriteMemory(assistant: Assistant): boolean {
  if (assistant.memoryWriteScope === "readonly") return false;
  return assistant.enableMemory === true || state.settings.memorySettings.globalEnabled === true;
}

/** 解析一条提议记忆的落点。模型自选档读取工具参数里的 scope，其余档位忽略它。
 *  目标层未启用时降级进待确认队列，与旧 always_* 矛盾组合降级一致。 */
export function resolveMemoryWriteTarget(
  assistant: Assistant,
  requestedScope?: unknown,
): ResolvedMemoryWrite {
  const globalWritable = state.settings.memorySettings.globalEnabled === true;
  const assistantWritable = assistant.enableMemory === true;
  const requested = requestedScope === "global" || requestedScope === "assistant" ? requestedScope : null;

  switch (assistant.memoryWriteScope) {
    case "readonly":
      return { readonly: true };
    case "always_global":
      return globalWritable ? { scope: "global" } : { pending: true };
    case "always_assistant":
      return assistantWritable ? { scope: "assistant" } : { pending: true };
    case "tool_default_assistant":
      if (requested === "global" && globalWritable) return { scope: "global" };
      if (assistantWritable) return { scope: "assistant" };
      return globalWritable ? { scope: "global" } : { pending: true };
    case "tool_default_global":
    default:
      if (requested === "assistant" && assistantWritable) return { scope: "assistant" };
      if (globalWritable) return { scope: "global" };
      return assistantWritable ? { scope: "assistant" } : { pending: true };
  }
}
