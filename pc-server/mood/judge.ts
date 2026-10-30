// mood/judge.ts — 每轮回复结束后的一次异步判定。
// 纪律：判定与主回复解耦（不 await、不抛错）、按助手串行排队、超时自断、
// 任何失败只记计数与日志，绝不影响对话本身。
import type { Assistant, Conversation } from "../foundation/types";
import { textFromParts } from "../foundation/utils";
import { fetchAuxiliaryText } from "../conversations/auxiliary";
import { findModelStrict } from "../model-providers";
import { state } from "../persistence/json-store";
import { getMoodExperimentSettings, moodExperimentOn } from "./gate";
import {
  applyMoodDelta,
  decayMoodState,
  emptyMoodState,
  parseMoodDelta,
  strongestDim,
  MOOD_DIM_LABELS,
  type MoodState,
} from "./model";
import { loadMoodState, openMoodDb, saveMoodState } from "./sqlite";

const JUDGE_TIMEOUT_MS = 30_000;
const INPUT_LIMIT = 1200;

export function moodKey(assistantId: string): string {
  return `assistant:${assistantId}`;
}

export interface MoodTurnInput {
  assistantId: string;
  assistantName: string;
  conversationModelId: string | null;
  conversationId: string;
  userText: string;
  replyText: string;
}

function limitText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > INPUT_LIMIT ? `${trimmed.slice(0, INPUT_LIMIT)}…` : trimmed;
}

function ownerName(): string {
  const raw = state?.settings?.displaySetting?.userNickname;
  return typeof raw === "string" ? raw.trim() : "";
}

function buildJudgePrompt(current: MoodState, input: MoodTurnInput): string {
  const self = input.assistantName.trim() || "助手";
  const owner = ownerName() || "对方";
  const top = strongestDim(current.dims);
  const statusLine = top
    ? `心情 ${Math.round(current.mood)}/100，最强的是「${MOOD_DIM_LABELS[top]}」`
    : `心情 ${Math.round(current.mood)}/100`;
  return [
    `你是「${self}」，是${owner}的对话伙伴。任务：根据这一轮对话，判断你自己（${self}）此刻的心情变化。`,
    "只输出一个 JSON 对象，不要任何解释、不要代码围栏。",
    '格式：{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}',
    "规则：",
    "1. moodDelta 与每根维度取 -10..10 的整数；大多数轮次应当是 0 或很小的值。",
    "2. 心情下降只能因为心疼、担心或自己难过，绝不能因为对方惹你生气。",
    "3. 你自己这轮说的话是最直接的情绪证据：语气、用词、有没有松一口气，优先于对方说了什么。",
    "4. reason 用过去式写一到两句，说明为什么变化；禁止「此刻 / 现在 / 还」这类进行时措辞，禁止套话。",
    "5. confidence 取 0..100：证据直接、情绪明显给 80~95；只有语气暗示给 60~75；几乎看不出来给 20~55。",
    "6. moodDelta 为 0 且所有维度为 0 时，reason 写这一轮没有可辨情绪变化的原因。",
    "",
    `当前状态：${statusLine}。`,
    "这一轮：",
    `【对方】${limitText(input.userText) || "（没有新的文字消息）"}`,
    `【你】${limitText(input.replyText) || "（这一轮没有回复文本）"}`,
  ].join("\n");
}

function resolveJudgeModelId(configured: string, conversationModelId: string | null): string {
  if (configured && findModelStrict(configured)) return configured;
  return conversationModelId || state.settings.chatModelId;
}

async function judgeOnce(key: string, input: MoodTurnInput): Promise<void> {
  const settings = getMoodExperimentSettings();
  if (!settings.enabled) return;
  const db = openMoodDb();
  if (!db) return;
  const now = Date.now();
  const base = loadMoodState(db, key) ?? emptyMoodState(key, settings.moodBase, now);
  const current = decayMoodState(base, settings, now);
  const modelId = resolveJudgeModelId(settings.moodModelId, input.conversationModelId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  let raw: string;
  try {
    raw = await fetchAuxiliaryText(modelId, buildJudgePrompt(current, input), "mood", {
      maxTokens: 400,
      temperature: 0.2,
      signal: controller.signal,
      conversationId: input.conversationId,
    });
  } catch (err) {
    saveMoodState(db, {
      ...current,
      judgeCalls: current.judgeCalls + 1,
      judgeFailures: current.judgeFailures + 1,
    });
    console.warn("[mood] 判定失败", err instanceof Error ? err.message : err);
    return;
  } finally {
    clearTimeout(timer);
  }
  // 判定在飞期间总开关被关掉 → 丢弃结果，避免关掉后还写库。
  const latest = getMoodExperimentSettings();
  if (!latest.enabled) return;
  const delta = parseMoodDelta(raw);
  if (!delta) {
    saveMoodState(db, {
      ...current,
      judgeCalls: current.judgeCalls + 1,
      judgeFailures: current.judgeFailures + 1,
    });
    console.warn("[mood] 判定输出无法解析", raw.slice(0, 120));
    return;
  }
  const applied = applyMoodDelta(current, delta, latest, Date.now());
  const next: MoodState = { ...applied.state, judgeCalls: current.judgeCalls + 1 };
  saveMoodState(
    db,
    next,
    applied.changed
      ? {
          at: next.updatedAt,
          mood: next.mood,
          delta: applied.moodStep,
          reason: next.lastReason,
          confidence: next.lastConfidence,
          dims: next.dims,
          dimsDelta: delta.dims,
          kind: "judge",
        }
      : undefined,
  );
}

const chains = new Map<string, Promise<void>>();

export function scheduleMoodJudge(input: MoodTurnInput): void {
  if (!moodExperimentOn()) return;
  const key = moodKey(input.assistantId);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous
    .then(() => judgeOnce(key, input))
    .catch((err) => console.warn("[mood] 判定任务异常", err instanceof Error ? err.message : err))
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  chains.set(key, next);
}

/** 从一轮完成的会话快照里取「最后一条用户消息 + 本轮回复」，异步判定一次。 */
export function scheduleMoodJudgeForTurn(input: {
  conversation: Conversation;
  assistant: Assistant;
  assistantMessageId: string;
}): void {
  if (!moodExperimentOn()) return;
  const { conversation } = input;
  let userText = "";
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const node = conversation.messages[index]!;
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (message?.role !== "USER") continue;
    userText = textFromParts(message.parts);
    if (userText.trim()) break;
  }
  let replyText = "";
  for (const node of conversation.messages) {
    const message = node.messages.find((item) => item.id === input.assistantMessageId);
    if (!message) continue;
    replyText = textFromParts(message.parts);
    break;
  }
  if (!userText.trim() && !replyText.trim()) return;
  scheduleMoodJudge({
    assistantId: input.assistant.id,
    assistantName: input.assistant.name,
    conversationModelId: input.assistant.chatModelId,
    conversationId: conversation.id,
    userText,
    replyText,
  });
}
