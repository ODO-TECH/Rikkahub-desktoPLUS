// mood/injection.ts — M2：把心情写进提示词的易变槽（最新 USER 消息末尾）。
// 纪律：
// - 只在真实生成前 prepare（辅助调用不准备，编码也不读）；总开关关闭时零副作用。
// - 同一轮（同一最新 USER 消息）复用同一段文本：工具循环/重编码不重复计数，
//   提示词前缀在同一轮内也不变（保前缀缓存）。
// - 一次实质变化只说一次（injectedFor = updatedAt），每日上限在 evaluateInjection 里守。
// - 任何失败只告警：注入是增强，绝不阻断聊天。
import type { Assistant, Conversation } from "../foundation/types";
import { state } from "../persistence/json-store";
import { getMoodExperimentSettings, moodExperimentOn } from "./gate";
import { moodKey } from "./judge";
import {
  buildInjectionText,
  decayMoodState,
  emptyMoodState,
  evaluateInjection,
  type MoodState,
} from "./model";
import { loadMoodState, openMoodDb, saveMoodState } from "./sqlite";

interface CachedInjection {
  messageId: string;
  assistantId: string;
  injectedFor: number;
  signature: string;
  text: string;
}

const MAX_CACHE = 200;
const cache = new Map<string, CachedInjection>();

function latestUserMessageId(conversation: Conversation): string | null {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const node = conversation.messages[index]!;
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (String(message?.role ?? "").toUpperCase() === "USER") return message.id;
  }
  return null;
}

function ownerName(): string {
  const raw = state?.settings?.displaySetting?.userNickname;
  return typeof raw === "string" ? raw.trim() : "";
}

/** 影响注入文本/门控的字段签名；变了就丢弃缓存重算。 */
function signature(): string {
  const s = getMoodExperimentSettings();
  return [
    s.dryRun ? 1 : 0,
    s.injectMode,
    s.injectConfidence,
    s.injectPerDay,
    s.moodBase,
    s.moodFloor,
    s.decayHalfHours,
    ownerName(),
  ].join("|");
}

function store(conversationId: string, entry: CachedInjection): void {
  cache.delete(conversationId);
  cache.set(conversationId, entry);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 生成前调用：门控通过且有资格注入时落库记账（saidAt / injectedFor）并缓存文本。 */
export async function prepareMoodInjection(
  conversation: Conversation,
  assistant: Assistant,
): Promise<void> {
  try {
    if (!moodExperimentOn()) {
      cache.delete(conversation.id);
      return;
    }
    const messageId = latestUserMessageId(conversation);
    if (!messageId) {
      cache.delete(conversation.id);
      return;
    }
    const db = openMoodDb();
    if (!db) {
      cache.delete(conversation.id);
      return;
    }
    const settings = getMoodExperimentSettings();
    const key = moodKey(assistant.id);
    const now = Date.now();
    const stored = loadMoodState(db, key) ?? emptyMoodState(key, settings.moodBase, now);
    const view = decayMoodState(stored, settings, now);
    const decision = evaluateInjection(view, settings, now);
    const sig = signature();
    if (decision === "say") {
      const text = buildInjectionText(view, settings, ownerName(), now);
      if (!text) {
        cache.delete(conversation.id);
        return;
      }
      const next: MoodState = {
        ...view,
        injectedFor: view.updatedAt,
        saidAt: [...view.saidAt, now],
      };
      saveMoodState(db, next);
      store(conversation.id, {
        messageId,
        assistantId: assistant.id,
        injectedFor: view.updatedAt,
        signature: sig,
        text,
      });
      return;
    }
    if (decision === "already_said") {
      // 同一轮的重编码（工具循环/重试）沿用缓存；换了消息或设置则在编码侧读不到。
      const cached = cache.get(conversation.id);
      const reusable =
        cached != null &&
        cached.messageId === messageId &&
        cached.assistantId === assistant.id &&
        cached.injectedFor === view.updatedAt &&
        cached.signature === sig;
      if (!reusable) cache.delete(conversation.id);
      return;
    }
    cache.delete(conversation.id);
  } catch (err) {
    console.warn("[mood] 注入准备失败，本轮不注入", err instanceof Error ? err.message : err);
  }
}

/** 编码前同步读取（conversation-encoding 里用）。消息 id / 助手 / 设置任一不符都返回空串。 */
export function readMoodInjectionBlock(
  conversationId: string,
  assistant: Assistant,
  latestMessageId?: string,
): string {
  if (!moodExperimentOn()) return "";
  const entry = cache.get(conversationId);
  if (!entry || entry.assistantId !== assistant.id) return "";
  if (latestMessageId && entry.messageId !== latestMessageId) return "";
  if (entry.signature !== signature()) return "";
  return entry.text;
}

export function clearMoodInjection(conversationId: string): void {
  cache.delete(conversationId);
}

/** 设置/状态重置后清空全部缓存（重置心情不应继续沿用旧文案）。 */
export function clearMoodInjectionCache(): void {
  cache.clear();
}
