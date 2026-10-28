// inference-engine/engine-compaction.ts — 压缩切点记录的引擎中性判定单源
//
// 压缩记录是会话级状态(conversation.engineCompactions,仅存 PC 自有库),不是某个
// 引擎的私有物:工作区(pi)用它重放原生 compaction,聊天引擎用它把切点接入富化窗口
// 并注入摘要。两边的"哪条记录生效"必须是同一个算法,否则同一份数据在两种模式下
// 给出不同的模型视野。
//
// 与编码器的分工:本模块只回答"哪条记录生效",不决定"怎么编码"。pi 侧还要求切点
// 行真的能编出条目(encodesToEntries),那是 pi 编码器的知识,通过 isUsable 谓词
// 注回来;聊天侧只要求切点仍在选中路径里(它的窗口锚是纯下标,不依赖内容)。
//
// 取"最新一条"而不是合并:压缩记录天然是链式的——每次压缩的 summary 已包含上一次
// 摘要(见 auxiliary.ts compressConversation 的链式拼接),所以最新一条就是完整状态。

import type { JsonValue, Message } from "../foundation/types";
import { isRecord } from "../foundation/utils";

/** DB 压缩记录(conversation.engineCompactions 元素)。 */
export interface EngineCompactionRecord {
  /** 切点:从这条消息(含)起保留原文,之前的历史被 summary 取代。 */
  cutMessageId: string;
  /** 被取代历史的摘要。第二次压缩起为链式文本(含更早的摘要)。 */
  summary: string;
  /** 压缩前的上下文估算(展示/诊断用,不参与判定)。 */
  tokensBefore: number;
  createdAt?: string;
}

/** DB 任意 JSON → 压缩记录。宽容校验:坏条目丢弃而不是整列作废(与列解析
 *  "损坏回 null"同哲学)。 */
export function parseEngineCompactions(raw: JsonValue[] | null | undefined): EngineCompactionRecord[] {
  const records: EngineCompactionRecord[] = [];
  for (const item of raw ?? []) {
    if (!isRecord(item)) continue;
    if (typeof item.cutMessageId !== "string" || typeof item.summary !== "string") continue;
    const record: EngineCompactionRecord = {
      cutMessageId: item.cutMessageId,
      summary: item.summary,
      tokensBefore: typeof item.tokensBefore === "number" ? item.tokensBefore : 0,
    };
    if (typeof item.createdAt === "string") record.createdAt = item.createdAt;
    records.push(record);
  }
  return records;
}

/** 有效压缩切点判定:取最新一条"切点在历史中且可用"的记录,无则 null。
 *  isUsable 由调用方给:pi 传"该行能否编出条目",聊天传恒真(只校验在场)。
 *  陈旧记录(切点被删/被编辑掉)自动跳过并回落到更早一条——更早的切点若仍有效,
 *  它的摘要继续生效,中间那段原文重新可见,这是唯一不丢信息的降级方向。 */
export function findEffectiveCompaction(
  compactions: EngineCompactionRecord[],
  history: Message[],
  isUsable: (message: Message) => boolean,
): EngineCompactionRecord | null {
  return (
    compactions
      .filter((record) => {
        const cut = history.find((msg) => msg.id === record.cutMessageId);
        return cut !== undefined && isUsable(cut);
      })
      .at(-1) ?? null
  );
}

// ── 自动压缩阈值(聊天引擎与前端提示共用口径) ──────────────────────────

/** 保留窗口:与 pi compaction 默认一致(contextWindow - reserveTokens)。前端的
 *  "上下文即将用完"提示(web-ui/app/lib/compaction.ts)用同一数字,两处必须同步改。 */
export const COMPACTION_RESERVE_TOKENS = 16384;

/** 自动压缩阈值。窗口本身不大于保留量(极小模型/错误目录值)时返回 null——阈值
 *  失效时不自动压缩,压缩救不了连系统提示都放不下的窗口(与前端提示同判定)。 */
export function compactionThresholdFor(contextWindow: number | null | undefined): number | null {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) return null;
  if (contextWindow <= COMPACTION_RESERVE_TOKENS) return null;
  return contextWindow - COMPACTION_RESERVE_TOKENS;
}

/** 严格大于(与 pi shouldCompact 同口径):恰好等于阈值时仍有一整个保留区可用。 */
export function shouldAutoCompact(usedTokens: number, contextWindow: number | null | undefined): boolean {
  const threshold = compactionThresholdFor(contextWindow);
  return threshold !== null && usedTokens > threshold;
}

// ── 钉住消息(压缩时不被摘要吞掉) ─────────────────────────────────────

/** 消息是否被用户钉住。pinned 是 PC-only 注解(导出安卓时过滤),标注意义集中在
 *  这里,避免压缩输入、摘要注入、前端各自字符串比较。 */
/** 只认 pinned 注解。参数按运行时实际宽容度声明:老消息行可能没有 annotations 列,
 *  解析层也可能给出 null——两者都应视为"未钉住"而不是崩。 */
export function isPinnedMessage(msg: { annotations?: JsonValue[] | null }): boolean {
  return Array.isArray(msg.annotations)
    && msg.annotations.some((annotation) => isRecord(annotation) && annotation.type === "pinned");
}

/** 切点之前被钉住的消息:这些原文已被摘要取代,但用户要求逐字保留。
 *  切点及之后的消息本来就在模型视野里,不重复注入。 */
export function pinnedMessagesBefore(history: Message[], cutMessageId: string): Message[] {
  const cutIndex = history.findIndex((msg) => msg.id === cutMessageId);
  if (cutIndex <= 0) return [];
  return history.slice(0, cutIndex).filter(isPinnedMessage);
}

/** 链式摘要合并:上一版摘要 + 本次新增段的摘要。
 *  正常情况下直接拼接;但摘要模型可能复述上一版(尤其本地小模型/固定 mock),
 *  此时再拼一遍只会让记录里出现重复段落,并把上下文预算耗在复读上。三种退化都收敛:
 *  - 本次摘要已包含上一版 → 用本次(它信息更全,且已覆盖旧内容);
 *  - 上一版已包含本次 → 保留上一版(本次没有新增信息);
 *  - 完全相同 → 只留一份。
 *  只做字符串包含判断,不改写摘要内容;真正的二次浓缩仍由预算闸门负责。 */
export function mergeCompactionSummary(previousSummary: string, freshSummary: string): string {
  const previous = previousSummary.trim();
  const fresh = freshSummary.trim();
  if (!previous) return fresh;
  if (!fresh) return previous;
  if (previous === fresh) return previous;
  // 包含判断只在被包含的一侧足够长时生效:摘要里出现"好""同意"这类短句时,
  // 用 includes 去重会把不同的新内容误判成复述。
  const MIN_CONTAINMENT = 16;
  if (previous.length >= MIN_CONTAINMENT && fresh.includes(previous)) return fresh;
  if (fresh.length >= MIN_CONTAINMENT && previous.includes(fresh)) return previous;
  return `${previous}\n\n${fresh}`;
}
