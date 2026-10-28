// conversations/auto-compaction.ts — 聊天引擎生成前的自动压缩预检(阶段三)
//
// 触发口径与 pi 的 shouldCompact 对齐:估算上下文 > contextWindow − reserveTokens。
// 判定只决定"压不压",压缩本身完全复用 compressConversation(记录、切点注解、链式
// 摘要、二次浓缩、审计闸门全同手动路径)——自动与手动不允许产生两种数据形态。
//
// 估算优先级:
//   ① 切点之后最后一条带真实 usage 的助手消息:promptTokens + completionTokens 包含
//      system/工具/摘要,是最接近上游视野的数(与前端提示条同口径)。该 usage 必须
//      晚于当前生效压缩记录,否则它反映的是压缩前的窗口(刚压完会误触发第二次)。
//   ② 无可用 usage(首轮/压缩后的第一轮/记录缺 createdAt):把模型真实要吃的富化产物
//      完整编码一遍再数 token——含 system、摘要、注入与工具往返。这一步会先做记忆
//      召回(prepareMemoryRecall),与正式生成同一时机,避免冻结出未召回的旧上下文档。
//
// 失败策略:best-effort。压缩模型调用失败时记一条 warn 级错误后继续生成——自动维护
// 不该把用户刚发的消息顶掉;上下文仍超限时上游自会报错,而手动压缩入口一直在。
// 唯一硬语义是取消:signal 中止(用户停止/新消息接管)时立即放弃,不落任何记录。

import type { Assistant, Conversation, Message, Model, Provider } from "../foundation/types";
import { estimateTokens, isRecord, textFromParts } from "../foundation/utils";
import { broadcastEngineStatus, broadcastList } from "../api/sse";
import { contextWindowFor } from "../model-providers/model-limits";
import { modelsDevCache } from "../inference-engine/providers";
import {
  findEffectiveCompaction,
  isPinnedMessage,
  parseEngineCompactions,
  shouldAutoCompact,
} from "../inference-engine/engine-compaction";
import { isEmptyAssistantPlaceholder } from "../inference-engine/parts";
import { conversationTransformedMessages } from "../inference-engine/conversation-encoding";
import { prepareMemoryRecall } from "../memory/recall";
import { prepareDynamicRecall } from "../memory/dynamic-recall";
import { reportError } from "../observability/app-errors";
import { state } from "../persistence/json-store";
import { selectedConversationMessages } from "./index";
import { compressing } from "./generation-state";
import { isRuntimeEpochCurrent, runtimeEpoch } from "./runtime-epoch";
import { toolPartsTextVolume } from "./helpers";
import { compressConversation } from "./auxiliary";
import { scheduleCompactionCandidates } from "../memory/experiment/compaction-candidates";

/** 自动压缩保留的最近消息比例:压掉约 3/4,避免"压完仍超阈值"每轮重复消费压缩模型。
 *  条数上限沿用手动压缩默认 32,下限 4(至少留一轮完整往返)。 */
const AUTO_COMPACT_KEEP_RATIO = 0.25;
const AUTO_COMPACT_KEEP_MAX = 32;
const AUTO_COMPACT_KEEP_MIN = 4;
const AUTO_COMPACT_TARGET_TOKENS = 2000;

/** 单条消息在模型视野里的近似 token(正文 + 工具输入/输出)。 */
function messageContextTokens(msg: Message): number {
  const text = textFromParts(msg.parts);
  const tool = toolPartsTextVolume(msg.parts);
  return (text ? estimateTokens(text) : 0) + (tool ? estimateTokens(tool) : 0);
}

/** 切点之后的可见消息(与编码层同一切点判定;切点失效时退回全量)。 */
function visibleMessages(conversation: Conversation): { messages: Message[]; compaction: ReturnType<typeof findEffectiveCompaction> } {
  const messages = selectedConversationMessages(conversation);
  const compaction = findEffectiveCompaction(
    parseEngineCompactions(conversation.engineCompactions),
    messages,
    () => true,
  );
  const cutIndex = compaction ? messages.findIndex((msg) => msg.id === compaction.cutMessageId) : -1;
  return { messages: cutIndex > 0 ? messages.slice(cutIndex) : messages, compaction };
}

/** 当前生效压缩记录是否晚于这条消息(是 → 它的 usage 反映压缩前窗口,不可用)。 */
function usageOlderThanCompaction(
  compaction: ReturnType<typeof findEffectiveCompaction>,
  msg: Message,
): boolean {
  if (!compaction) return false;
  const compactedAt = Date.parse(String(compaction.createdAt ?? ""));
  // 记录没有时间(如 pi 早期记录):无法证明 usage 新鲜,保守视为旧。
  if (!Number.isFinite(compactedAt)) return true;
  const messageAt = Date.parse(String(msg.createdAt ?? ""));
  if (!Number.isFinite(messageAt)) return true;
  return messageAt <= compactedAt;
}

/** 自动压缩判定用的上下文估算(≈ 下一次请求的 prompt token)。 */
export async function estimateAutoCompactContext(
  conversation: Conversation,
  assistant: Assistant,
): Promise<number> {
  const { messages: visible, compaction } = visibleMessages(conversation);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const msg = visible[index]!;
    if (msg.role !== "ASSISTANT" || isEmptyAssistantPlaceholder(msg)) continue;
    const usage = isRecord(msg.usage) ? msg.usage : null;
    const promptTokens = Number(usage?.promptTokens ?? 0);
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) continue;
    if (usageOlderThanCompaction(compaction, msg)) continue;
    const completionTokens = Number(usage?.completionTokens ?? 0);
    let trailing = 0;
    for (let i = index + 1; i < visible.length; i += 1) trailing += messageContextTokens(visible[i]!);
    return promptTokens + (Number.isFinite(completionTokens) ? completionTokens : 0) + trailing;
  }
  // 无可用 usage:按模型真实视野完整估算。召回先就位,避免冻结未召回的上下文块;
  // S9 易变块同一次请求就会带上,估算必须把它算进去,否则压完仍可能超阈值。
  await prepareMemoryRecall(conversation, assistant);
  await prepareDynamicRecall(conversation, assistant);
  const { messages: encoded } = conversationTransformedMessages(conversation, assistant, { dynamicRecall: true });
  return encoded.reduce((sum, msg) => sum + messageContextTokens(msg), 0);
}

function keepRecentFor(compressibleCount: number): number {
  const byRatio = Math.ceil(compressibleCount * AUTO_COMPACT_KEEP_RATIO);
  return Math.min(AUTO_COMPACT_KEEP_MAX, Math.max(AUTO_COMPACT_KEEP_MIN, byRatio));
}

/** 生成前预检:启用 + 未知窗口/窗口过小 + 未在压缩 + 有可压缩段 + 超过阈值 → 压一次。
 *  返回 true 表示本次生成前实际执行了压缩。 */
export async function maybeAutoCompactChat(input: {
  conversation: Conversation;
  assistant: Assistant;
  provider: Provider;
  model: Model;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { conversation, assistant, provider, model, signal } = input;
  // 代际守卫:本预检挂在生成入口,生成期间可能发生备份导入——旧实例的压缩结果与
  // compressing 记账都不得影响导入后的新运行态(见 finalizeConversationImport)。
  const epoch = runtimeEpoch();
  if (state.settings.chatAutoCompact !== true) return false;
  if (compressing.has(conversation.id)) return false;
  const contextWindow = contextWindowFor(modelsDevCache, provider, model.modelId);
  // 同步先做一次便宜的规模判断之外,窗口本身未知时直接放弃——不知道阈值就不猜。
  if (contextWindow == null) return false;

  const contextTokens = await estimateAutoCompactContext(conversation, assistant);
  if (signal?.aborted) return false;
  if (!isRuntimeEpochCurrent(epoch)) return false;
  if (!shouldAutoCompact(contextTokens, contextWindow)) return false;

  // 可压缩段:上一次切点之后。少于两条说明没有可摘的原文(压缩会拒绝),静默跳过。
  const allMessages = selectedConversationMessages(conversation);
  const previous = findEffectiveCompaction(
    parseEngineCompactions(conversation.engineCompactions),
    allMessages,
    () => true,
  );
  const previousIndex = previous ? allMessages.findIndex((msg) => msg.id === previous.cutMessageId) : 0;
  const compressible = allMessages.slice(Math.max(0, previousIndex));
  if (compressible.length < 2) return false;
  if (compressing.has(conversation.id)) return false;
  // 阶段四:钉住的消息不进摘要。若切点前的段落全被钉住,压缩会因"无可摘要内容"
  // 失败——自动路径不该每轮弹一条失败警告,静默跳过(上游超限时仍会自己报错)。
  let keepRecent = keepRecentFor(compressible.length);
  if (keepRecent >= compressible.length) keepRecent = Math.max(1, Math.floor(compressible.length / 2));
  const pinnedFreeBeforeCut = compressible
    .slice(0, compressible.length - keepRecent)
    .filter((msg) => !isPinnedMessage(msg));
  if (pinnedFreeBeforeCut.length === 0) return false;

  const startedAt = Date.now();
  compressing.set(conversation.id, startedAt);
  broadcastEngineStatus(conversation.id, {
    busy: true,
    phase: "compacting",
    reason: "threshold",
    startedAt,
  });
  broadcastList();
  try {
    await compressConversation(
      conversation,
      "",
      AUTO_COMPACT_TARGET_TOKENS,
      keepRecent,
      signal,
      { autoReason: "threshold" },
    );
    // 实验：压缩后置候选（默认关；内部自行门控，best-effort 不阻塞生成）。
    scheduleCompactionCandidates(conversation);
    return true;
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw error instanceof DOMException ? error : new DOMException("Compression cancelled", "AbortError");
    }
    // 导入替换导致的作废不是压缩故障:静默放弃,由生成入口的代际检查收尾。
    if (!isRuntimeEpochCurrent(epoch)) return false;
    reportError(
      "provider",
      "warn",
      `自动压缩上下文失败,本轮按原上下文继续生成:${error instanceof Error ? error.message : String(error)}`,
      error,
      "auto_compact_failed",
    );
    return false;
  } finally {
    if (isRuntimeEpochCurrent(epoch)) {
      compressing.delete(conversation.id);
      broadcastEngineStatus(conversation.id, { busy: false });
      broadcastList();
    }
  }
}
