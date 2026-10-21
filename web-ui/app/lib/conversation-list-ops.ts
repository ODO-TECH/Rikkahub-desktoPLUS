// 会话列表纯操作(FE-P1-3:从 hooks/use-conversation-list.ts 原样迁出以便单测)。
// 排序/合并/刷新三个操作决定列表 UI 的最终呈现顺序与分页刷新语义,
// 行为契约见测试 conversation-list-ops.test.ts。
import type { ConversationListDto } from "~/types";

/** 置顶优先,同置顶按 updateAt 降序。不修改入参数组。 */
export function sortConversationList(items: ConversationListDto[]): ConversationListDto[] {
  return [...items].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return left.isPinned ? -1 : 1;
    }
    return right.updateAt - left.updateAt;
  });
}

/** 按 id 覆盖合并(incoming 优先),再整体排序。分页加载更多时使用。 */
export function mergeConversationList(
  base: ConversationListDto[],
  incoming: ConversationListDto[],
): ConversationListDto[] {
  const conversationById = new Map(base.map((item) => [item.id, item]));
  for (const item of incoming) {
    conversationById.set(item.id, item);
  }
  return sortConversationList(Array.from(conversationById.values()));
}

/** 刷新前 replaceCount 条:incoming 整体替换头部,尾部保留但剔除与 incoming 重复的 id。 */
export function refreshConversationList(
  previous: ConversationListDto[],
  incoming: ConversationListDto[],
  replaceCount: number,
): ConversationListDto[] {
  const incomingIds = new Set(incoming.map((item) => item.id));
  const tail = previous.slice(replaceCount).filter((item) => !incomingIds.has(item.id));
  return sortConversationList([...incoming, ...tail]);
}
