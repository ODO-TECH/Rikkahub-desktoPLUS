// lib/compaction.ts — 压缩边界的展示面判定(纯函数)
//
// 两种注解对应两代压缩形态,前端并行识别:
// - compaction_cut(现行,非破坏性):打在"切点前一条消息"上,线画在该消息下方。线上
//   原文对用户仍可见,线下(切点及之后)才是模型逐字看到的范围。标记由
//   compressConversation 落库(对话模式)与工作区 pi 的切点记录对齐——同一语义。
// - compaction_boundary(旧破坏式):打在"用户发起压缩时的最新一条消息"上,线下原文
//   已被删除,线代表"历史从这里被替换成摘要"。老会话保留,新压缩不再产生。
import type { TokenUsage, UIMessage } from "~/types";

/** 压缩记忆边界:线画在该消息下方(下一行起为模型逐字可见的原文)。 */
export function isCompactionCutMessage(message: Pick<UIMessage, "annotations">): boolean {
  return (message.annotations ?? []).some((annotation) => annotation.type === "compaction_cut");
}

/** 旧破坏式压缩的发生点:线画在该消息下方(线上的会话已被压缩处理)。 */
export function isCompactionBoundaryMessage(message: Pick<UIMessage, "annotations">): boolean {
  return (message.annotations ?? []).some(
    (annotation) => annotation.type === "compaction_boundary",
  );
}

/** 该消息下方要画的分割线形态。cut 优先:同一条消息上两代标记并存时,记忆边界比
 *  "历史被替换的位置"更贴近模型现状。 */
export function compactionDividerBelow(
  message: Pick<UIMessage, "annotations">,
): "cut" | "boundary" | null {
  if (isCompactionCutMessage(message)) return "cut";
  if (isCompactionBoundaryMessage(message)) return "boundary";
  return null;
}

// ── 压缩记录展示(分割线点开看摘要/切点/规模) ─────────────────────────

/** 会话级压缩记录(conversation.engineCompactions 元素)的前端投影。
 *  与后端 inference-engine/engine-compaction.ts 同形;PC 自有字段,安卓导出不含。 */
export interface CompactionRecord {
  cutMessageId: string;
  summary: string;
  tokensBefore: number;
  createdAt?: string;
}

/** 详情卡只需要的最小消息面:线上 DTO 的 role 是大写枚举,不走前端内部 UIMessage。 */
export interface CompactionPreviewMessage {
  id: string;
  role: string;
  parts: ReadonlyArray<{ type: string; text?: string }>;
}

/** 时间线节点投影:候选消息只用来查切点,selectedId 是分割线要挂靠的那个节点。 */
export interface CompactionTimelineNode {
  messages: ReadonlyArray<CompactionPreviewMessage>;
  /** 当前选中的候选消息 id;分割线挂在切点节点的前一个节点所选消息下方。 */
  selectedId: string;
}

export interface CompactionAnchorInfo {
  record: CompactionRecord;
  /** 切点消息:分割线下方第一条逐字进入模型的原文。 */
  cutMessage: CompactionPreviewMessage;
  /** 当前这份(链式)摘要的估算 token。 */
  summaryTokens: number;
  /** 上一版摘要的估算 token;首份摘要为 0。 */
  previousSummaryTokens: number;
}

/** DB 任意 JSON → 压缩记录。宽容解析:坏条目丢弃,不因一条脏数据让整条分割线失效
 *  (与后端 parseEngineCompactions 同哲学)。 */
export function parseCompactionRecords(raw: unknown): CompactionRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: CompactionRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.cutMessageId !== "string" || typeof value.summary !== "string") continue;
    const tokensBefore =
      typeof value.tokensBefore === "number" && Number.isFinite(value.tokensBefore)
        ? Math.max(0, value.tokensBefore)
        : 0;
    records.push({
      cutMessageId: value.cutMessageId,
      summary: value.summary,
      tokensBefore,
      ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    });
  }
  return records;
}

/** 压缩记录 → "分割线锚点消息 id → 可展示详情"。
 *  切点所在的节点可能不是当前选中分支,所以按节点成员查;锚点则取前一个节点的当前
 *  选中消息——与后端 markCompactionCut 的落点一致。切点已被删除的旧记录直接跳过
 *  (线上不会画线,也没有可解释的切点)。同一锚点存在多条记录时后者覆盖前者,
 *  与"只有最新一条记录生效"的语义一致。 */
export function buildCompactionAnchors(
  raw: unknown,
  nodes: ReadonlyArray<CompactionTimelineNode>,
): Map<string, CompactionAnchorInfo> {
  const anchors = new Map<string, CompactionAnchorInfo>();
  let previousSummaryTokens = 0;
  for (const record of parseCompactionRecords(raw)) {
    let cutNodeIndex = -1;
    for (let index = 0; index < nodes.length; index++) {
      if (nodes[index]!.messages.some((message) => message.id === record.cutMessageId)) {
        cutNodeIndex = index;
        break;
      }
    }
    if (cutNodeIndex <= 0) continue;
    const cutMessage = nodes[cutNodeIndex]!.messages.find(
      (message) => message.id === record.cutMessageId,
    );
    const anchorId = nodes[cutNodeIndex - 1]!.selectedId;
    if (!cutMessage || !anchorId) continue;
    const summaryTokens = estimateCompactionTokens(record.summary);
    anchors.set(anchorId, {
      record,
      cutMessage,
      summaryTokens,
      previousSummaryTokens,
    });
    previousSummaryTokens = summaryTokens;
  }
  return anchors;
}

/** 最新一条仍有效的压缩记录落在时间线的哪个位置。
 *  与 buildCompactionAnchors 同一判定:从后往前找第一条"切点节点存在且前驱可选"的
 *  记录——切点被删/被编辑掉时回落到更早一条,与模型视野的降级方向一致。
 *  返回的 anchorNodeIndex 是分割线/摘要卡挂靠的节点下标(切点前一节点),用于把
 *  它之前的原文折叠起来。 */
export interface CompactionPlacement {
  record: CompactionRecord;
  anchorId: string;
  anchorNodeIndex: number;
  cutNodeIndex: number;
}

export function latestCompactionPlacement(
  raw: unknown,
  nodes: ReadonlyArray<CompactionTimelineNode>,
): CompactionPlacement | null {
  const records = parseCompactionRecords(raw);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const cutNodeIndex = nodes.findIndex((node) =>
      node.messages.some((message) => message.id === record.cutMessageId),
    );
    if (cutNodeIndex <= 0) continue;
    const anchorId = nodes[cutNodeIndex - 1]?.selectedId;
    if (!anchorId) continue;
    return { record, anchorId, anchorNodeIndex: cutNodeIndex - 1, cutNodeIndex };
  }
  return null;
}

/** 摘要体量估算:与后端 foundation/utils.ts estimateTokens 同一口径(CJK 0.9、
 *  其他字符 1/4),只用于详情卡里的近似展示,不参与任何压缩判定。 */
export function estimateCompactionTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk * 0.9 + other / 4));
}

/** 上下文告警的保留量:与工作区 pi 自动压缩阈值同一口径(contextWindow - reserveTokens,
 *  reserveTokens 默认 16384)。剩余窗口不足这么多 token 时提示用户主动压缩。 */
export const CONTEXT_WARNING_RESERVE_TOKENS = 16384;

/** 手动压缩参数归一化:对话框滑杆/输入框允许临时空串 / 小数 / 越界值,提交前统一成
 *  后端可用值。目标 token 下限与后端同口径(256);保留条数 0 合法,表示尽量压缩。 */
export const COMPRESS_TARGET_TOKENS_MIN = 256;
export const COMPRESS_KEEP_RECENT_DEFAULT = 32;

/** 压缩比例:用户选"压掉上下文的百分之多少",摘要 = 剩余部分。
 *  20% 是保留细节最稳的起步档,40% 默认;超过 65% 摘要保留的原文不足 35%,
 *  细节丢失会诱导模型编造,界面必须弹一次幻觉风险警告。 */
export const COMPRESS_RATIO_MIN = 20;
export const COMPRESS_RATIO_DEFAULT = 40;
export const COMPRESS_RATIO_WARN = 65;
export const COMPRESS_RATIO_MAX = 100;

function parseIntegerInput(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.floor(raw) : null;
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

/** 任意非负整数:0 = 尽量压缩(后端仍保留 1 条做切点锚点),大值由后端按可压段降级。 */
export function normalizeCompressKeepRecent(
  raw: string | number,
  fallback = COMPRESS_KEEP_RECENT_DEFAULT,
): number {
  const value = parseIntegerInput(raw);
  return value == null ? fallback : Math.max(0, value);
}

/** 压缩比例归一化:滑杆给整数,这里仍兜住越界值和非法输入,夹到 [20, 100]。 */
export function normalizeCompressRatio(
  raw: string | number,
  fallback = COMPRESS_RATIO_DEFAULT,
): number {
  const value = parseIntegerInput(raw);
  if (value == null) return fallback;
  return Math.min(COMPRESS_RATIO_MAX, Math.max(COMPRESS_RATIO_MIN, value));
}

/** 比例 → 后端 targetTokens:上下文 token × (1 − 比例/100),即摘要目标体量。
 *  上下文未知(新会话还没有 usage)时返回 null,由调用方省略该字段走服务端默认,
 *  而不是拿 0 换算出"压到下限"这种意外结果。下限与后端同口径 256。 */
export function compressRatioToTargetTokens(
  ratio: number,
  contextTokens?: number | null,
): number | null {
  if (contextTokens == null || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return null;
  }
  const normalized = normalizeCompressRatio(ratio);
  const target = Math.round(contextTokens * (1 - normalized / 100));
  return Math.max(COMPRESS_TARGET_TOKENS_MIN, target);
}

/** 最近一次压缩是否发生在该消息之后。压缩完成后、下一轮生成前,最后一条消息的 usage
 *  还是压缩前的窗口量——拿它提示"上下文即将用完"会自相矛盾(刚压完还催着压)。
 *  下一次回复落地后 usage 才反映压缩后的窗口,提示按新值重新裁决。 */
export function compactionAfterMessage(records: unknown, messageAt?: string | null): boolean {
  if (!Array.isArray(records)) return false;
  const messageTime = Date.parse(String(messageAt ?? ""));
  if (!Number.isFinite(messageTime)) return false;
  let latest: number | null = null;
  for (const item of records) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const at = Date.parse(String((item as { createdAt?: unknown }).createdAt ?? ""));
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest !== null && messageTime <= latest;
}

/** 上下文接近上限的占用百分比;未越过阈值/缺分母时返回 null(不显示提示)。
 *  分子与聊天消息里的上下文进度环同口径:promptTokens + completionTokens = 这条回复
 *  之后窗口里的总量。分母优先 live(切模型即更新),回退消息生成时的快照。 */
export function contextWarningPercent(
  usage: Pick<TokenUsage, "promptTokens" | "completionTokens" | "contextLimit">,
  liveLimit?: number | null,
): number | null {
  const limit =
    liveLimit != null && liveLimit > 0
      ? liveLimit
      : usage.contextLimit != null && usage.contextLimit > 0
        ? usage.contextLimit
        : null;
  if (limit == null) return null;
  const used = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
  if (!(used > 0)) return null;
  const threshold = limit - CONTEXT_WARNING_RESERVE_TOKENS;
  // 窗口本身小于保留量(极小模型/错误目录值):阈值失效,不提示——压缩救不了它。
  // 严格大于(与 pi 的 shouldCompact 同口径):恰好等于阈值时仍有一整个保留区可用。
  if (threshold <= 0 || used <= threshold) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}
