// memory/vector-hooks.ts — 记忆写入 → 向量索引的单向通知
// 放在独立叶子模块，避免 memory/index（写入方）与 vector-index（订阅方）互相 import 成环。

export type MemoryVectorChangeReason = "add" | "update" | "replace";

let listener: ((reason: MemoryVectorChangeReason) => void) | null = null;

export function setMemoryVectorChangeListener(fn: ((reason: MemoryVectorChangeReason) => void) | null): void {
  listener = fn;
}

export function notifyMemoryVectorChanged(reason: MemoryVectorChangeReason): void {
  try {
    listener?.(reason);
  } catch (err) {
    console.warn("[memory] 向量索引通知失败:", err);
  }
}
