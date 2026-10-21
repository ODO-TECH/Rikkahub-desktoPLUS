// 专题12(缓存命中对照 codex):记忆/最近会话区块冻结快照。
//
// 这两块是 system 消息里唯二的高频易变段——记忆一写就重排、任何其他会话被使用
// "最近会话"就变;而前缀缓存按首个分歧点截断,它们一变,跟在 system 后面的整个
// 会话历史缓存全部失效。快照按 会话+助手+相关开关 冻结:同一会话生命周期内
// system 逐字节不变,前缀缓存可覆盖 system+全部历史。
//
// 语义代价可接受:记忆块自述"供未来会话参考",会话中途的记忆写入在工具结果里
// 模型本就看得见;最近会话天然是开场语境。失效面收敛到"设置页手动改记忆"
// (api/handlers 调 invalidateContextSnapshots),工具写入不失效;相关开关
// (enableMemory/globalEnabled/enableRecentChatsReference)编进快照键,切开关即
// 换键自动重建;进程重启自然重建——厂商缓存 TTL 分钟~小时级,跨重启本就冷。
import type { Assistant } from "../foundation/types";
import { buildMemoryPrompt, buildRecentChatsPrompt } from "../memory";
import { state } from "../persistence/json-store";

/** [记忆块, 最近会话块](可为空串)。 */
export type ContextBlocks = readonly [string, string];

const MAX_SNAPSHOTS = 200;
const snapshots = new Map<string, ContextBlocks>();

function snapshotKey(assistant: Assistant, conversationId: string): string {
  // state 在启动装载后才可用;编码只在运行期发生,这里的可选链仅为单测隔离兜底。
  const globalEnabled = state?.settings?.memorySettings?.globalEnabled === true;
  const flags = `${assistant.enableMemory ? 1 : 0}${globalEnabled ? 1 : 0}${assistant.enableRecentChatsReference ? 1 : 0}`;
  return `${conversationId}|${assistant.id}|${flags}`;
}

function defaultBuild(assistant: Assistant, conversationId: string): ContextBlocks {
  return [buildMemoryPrompt(assistant), buildRecentChatsPrompt(assistant, conversationId)];
}

/** 会话首次编码时构建并冻结记忆/最近会话区块,之后复用。build 参数仅供单测注入。 */
export function frozenContextBlocks(
  assistant: Assistant,
  conversationId: string,
  build: (assistant: Assistant, conversationId: string) => ContextBlocks = defaultBuild,
): ContextBlocks {
  const key = snapshotKey(assistant, conversationId);
  const hit = snapshots.get(key);
  if (hit) {
    // LRU 触活:删除重插,让活跃会话不被淘汰
    snapshots.delete(key);
    snapshots.set(key, hit);
    return hit;
  }
  const blocks = build(assistant, conversationId);
  snapshots.set(key, blocks);
  if (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  return blocks;
}

/** 设置页手动改记忆/备份导入替换记忆时调用:清空全部快照,下一轮编码重建。
 *  这是明确的用户动作,应立即生效,代价只是一次缓存冷启动。 */
export function invalidateContextSnapshots(): void {
  snapshots.clear();
}
