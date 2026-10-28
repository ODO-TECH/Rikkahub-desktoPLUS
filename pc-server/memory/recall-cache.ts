// memory/recall-cache.ts — 会话级召回结果的冻结缓存（叶子模块，供 memory 与 infer 两侧读）
// 与 context-snapshots 同生命周期：首次编码时算一次，之后逐字节复用；手动刷新/改设置清空。

export interface RecallSelection {
  conversationId: string;
  /** 生成这份选择时的助手；同一会话 id 换绑助手后旧选择不适用。 */
  assistantId: string;
  selectedIds: number[];
  /** 生成这份选择时使用的嵌入模型；换模型后旧选择不再适用。 */
  modelKey: string;
  queryHash: string;
  /** 当次可见记忆总数，用于「本次召回 N / M」与降级判断。 */
  total: number;
  builtAt: number;
  reranked: boolean;
  /** 生成时的失效代际；期间发生过清缓存/单会话重匹配则对不上，读写两侧都会丢弃。 */
  invalidationGeneration: string;
}

const MAX_RECALLS = 200;
const selections = new Map<string, RecallSelection>();
// 代际令牌用单调递增的全局计数：每次失效取一个新号，令牌永不复用。
let epoch = 0;
let globalGeneration = 0;
const conversationGenerations = new Map<string, number>();

/** 当前代际令牌。召回开始时取一次、写缓存时带上；等待网络期间发生过失效则写入被拒。 */
export function recallCacheGeneration(conversationId: string): string {
  return `${globalGeneration}.${conversationGenerations.get(conversationId) ?? 0}`;
}

export function getRecallSelection(conversationId: string): RecallSelection | null {
  const hit = selections.get(conversationId);
  if (!hit) return null;
  if (hit.invalidationGeneration !== recallCacheGeneration(conversationId)) {
    selections.delete(conversationId);
    return null;
  }
  selections.delete(conversationId);
  selections.set(conversationId, hit);
  return hit;
}

/** 写入召回结果，返回是否被接受。expectedGeneration 与当前代际不符（等待嵌入/重排期间
 *  被失效）时拒绝写入——旧异步结果不能复活成新一轮的冻结值。
 *  省略 expectedGeneration 表示无条件写（测试/手工注入）。 */
export function putRecallSelection(selection: RecallSelection, expectedGeneration?: string): boolean {
  if (expectedGeneration !== undefined
    && expectedGeneration !== recallCacheGeneration(selection.conversationId)) {
    return false;
  }
  selections.delete(selection.conversationId);
  selections.set(selection.conversationId, selection);
  if (selections.size > MAX_RECALLS) {
    const oldest = selections.keys().next().value;
    if (oldest !== undefined) selections.delete(oldest);
  }
  return true;
}

export function clearConversationRecall(conversationId: string): boolean {
  epoch += 1;
  conversationGenerations.set(conversationId, epoch);
  return selections.delete(conversationId);
}

export function clearRecallCache(): void {
  epoch += 1;
  globalGeneration = epoch;
  conversationGenerations.clear();
  selections.clear();
}
