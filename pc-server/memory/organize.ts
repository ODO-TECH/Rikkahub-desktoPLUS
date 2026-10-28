// memory/organize.ts — 记忆自动整理（去重 / 合并 / 重写）
// 触发：助手每完成 N 轮对话后自动入队；也支持手动立即整理。
// 候选来自当前助手可见的记忆，向量库可用时用余弦相似度提示重复对，再由记忆模型输出
// 合并 / 删除方案；所有方案都经过跨层校验后一次性落库。

import type { Assistant, Conversation, MemoryEntry } from "../foundation/types";
import { textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { fetchAuxiliaryText } from "../conversations/auxiliary";
import { getConversation, getConversationsDb } from "../conversations/index";
import { broadcastMemoryUpdate } from "../api/sse";
import { invalidateContextSnapshots } from "../inference-engine/context-snapshots";
import { memoriesForAssistant, memoryStore } from "./index";
import { memoryModelThinkingEnabled, resolveMemoryModel } from "./memory-model";
import { cosineSimilarity } from "./recall";
import { resolveEmbeddingModel } from "./scene-models";
import { loadMemoryVectors, openVectorDb } from "./vector-store";
import { readMemoryOrganizeState, writeMemoryOrganizeState } from "./sqlite";

const QUEUE_LIMIT = 8;
const MAX_MEMORIES = 80;
const MAX_OPS = 30;
const MAX_CONTENT_CHARS = 400;
const VECTOR_MIN_COS = 0.82;
const MAX_HINT_PAIRS = 40;

export interface MemoryOrganizeResult {
  ran: boolean;
  reason?: string;
  scanned: number;
  merged: number;
  deleted: number;
}

interface OrganizeJob {
  conversationId?: string;
  assistantId: string;
  force: boolean;
}

const queue: OrganizeJob[] = [];
let running = false;

function enqueue(job: OrganizeJob) {
  if (job.conversationId) {
    const existing = queue.findIndex((item) => item.conversationId === job.conversationId);
    if (existing >= 0) {
      if (!job.force) return;
      queue.splice(existing, 1);
    }
  }
  queue.push(job);
  while (queue.length > QUEUE_LIMIT) queue.shift();
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        await runOrganizeJob(job);
      } catch (err) {
        console.warn("[memory] 自动整理失败:", err);
      }
    }
  } finally {
    running = false;
  }
}

/** 助手完成一轮回复后调用：只入队，不做任何同步等待。 */
export function scheduleMemoryOrganize(conversationId: string): void {
  const conversation = getConversation(conversationId);
  if (!conversation) return;
  const assistant = state.settings.assistants.find((item) => item.id === conversation.assistantId);
  if (!assistant || !assistant.enableMemory || !assistant.autoOrganizeMemory) return;
  // 只读声明「记忆不许被改写」,整理会重写内容,与 UI 上的禁用保持一致。
  if (assistant.memoryWriteScope === "readonly") return;
  enqueue({ conversationId, assistantId: assistant.id, force: false });
}

/** 手动「立即整理」：绕过 N 轮门槛。 */
export async function runMemoryOrganizeNow(assistantId: string): Promise<MemoryOrganizeResult> {
  return runOrganizeJob({ assistantId, force: true });
}

function countAssistantTurnsSince(conversation: Conversation, watermark: number): number {
  let count = 0;
  const start = Math.min(Math.max(0, watermark), conversation.messages.length);
  for (let index = start; index < conversation.messages.length; index += 1) {
    const node = conversation.messages[index];
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (!message || message.role !== "ASSISTANT") continue;
    if (textFromParts(message.parts ?? []).trim()) count += 1;
  }
  return count;
}

async function runOrganizeJob(job: OrganizeJob): Promise<MemoryOrganizeResult> {
  const assistant = state.settings.assistants.find((item) => item.id === job.assistantId);
  if (!assistant) return { ran: false, reason: "assistant_missing", scanned: 0, merged: 0, deleted: 0 };
  if (assistant.memoryWriteScope === "readonly") {
    return { ran: false, reason: "readonly", scanned: 0, merged: 0, deleted: 0 };
  }

  const conversation = job.conversationId ? getConversation(job.conversationId) : null;
  const db = getConversationsDb();
  const prior = conversation && db ? readMemoryOrganizeState(db, conversation.id) : null;
  if (!job.force && conversation) {
    const turns = countAssistantTurnsSince(conversation, prior?.watermark ?? 0);
    const every = Math.min(20, Math.max(1, assistant.memoryOrganizeEveryNTurns || 5));
    if (turns < every) return { ran: false, reason: "below_threshold", scanned: 0, merged: 0, deleted: 0 };
  }

  const visible = memoriesForAssistant(assistant)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_MEMORIES);
  if (visible.length < 2) {
    if (conversation && db) {
      writeMemoryOrganizeState(db, conversation.id, {
        watermark: conversation.messages.length,
        lastStatus: "too_few_memories",
      });
    }
    return { ran: false, reason: "too_few_memories", scanned: visible.length, merged: 0, deleted: 0 };
  }

  const model = resolveMemoryModel();
  if (!model) {
    return { ran: false, reason: "memory_model_unset", scanned: visible.length, merged: 0, deleted: 0 };
  }

  const hints = vectorHintPairs(visible);
  const prompt = buildOrganizePrompt(assistant, visible, hints);
  let raw = "";
  try {
    raw = await fetchAuxiliaryText(model.model.id, prompt, "memory-organize", {
      maxTokens: 3000,
      conversationId: conversation?.id,
      reasoningLevel: memoryModelThinkingEnabled() ? "AUTO" : undefined,
    });
  } catch (err) {
    console.warn("[memory] 整理模型调用失败:", err);
    return { ran: false, reason: "model_call_failed", scanned: visible.length, merged: 0, deleted: 0 };
  }

  const operations = parseOrganizeOperations(raw, visible);
  if (operations.length === 0) {
    if (conversation && db) {
      writeMemoryOrganizeState(db, conversation.id, {
        watermark: conversation.messages.length,
        lastStatus: "no_operations",
      });
    }
    return { ran: true, scanned: visible.length, merged: 0, deleted: 0 };
  }

  const applied = memoryStore.applyConsolidation(operations);
  if (conversation && db) {
    writeMemoryOrganizeState(db, conversation.id, {
      watermark: conversation.messages.length,
      lastStatus: `merged:${applied.merged} deleted:${applied.deleted}`,
    });
  }
  if (applied.merged > 0 || applied.deleted > 0) {
    broadcastMemoryUpdate();
    invalidateContextSnapshots();
  }
  return {
    ran: true,
    scanned: visible.length,
    merged: applied.merged,
    deleted: applied.deleted,
  };
}

function vectorHintPairs(memories: MemoryEntry[]): Array<{ a: number; b: number; cos: number }> {
  if (!state.settings.memoryVectorSettings.enabled) return [];
  const embedding = resolveEmbeddingModel();
  const db = embedding ? openVectorDb() : null;
  if (!embedding || !db) return [];
  try {
    const vectors = loadMemoryVectors(db, embedding.modelKey);
    if (vectors.size === 0) return [];
    const pairs: Array<{ a: number; b: number; cos: number }> = [];
    for (let i = 0; i < memories.length; i += 1) {
      const left = vectors.get(memories[i].id)?.vector;
      if (!left) continue;
      for (let j = i + 1; j < memories.length; j += 1) {
        const right = vectors.get(memories[j].id)?.vector;
        if (!right) continue;
        const cos = cosineSimilarity(left, right);
        if (cos >= VECTOR_MIN_COS) pairs.push({ a: memories[i].id, b: memories[j].id, cos });
      }
    }
    return pairs.sort((x, y) => y.cos - x.cos).slice(0, MAX_HINT_PAIRS);
  } catch (err) {
    console.warn("[memory] 读取记忆向量失败，整理仅使用文本列表:", err);
    return [];
  }
}

function memoryScopeLabel(assistant: Assistant, entry: MemoryEntry): string {
  const scope = memoryStore.scopeOfMemory(entry.id);
  if (!scope) return "unknown";
  if (scope.scope === "global") return "global";
  return scope.assistantId === assistant.id ? "assistant" : `assistant:${scope.assistantId}`;
}

function buildOrganizePrompt(
  assistant: Assistant,
  memories: MemoryEntry[],
  hints: Array<{ a: number; b: number; cos: number }>,
): string {
  const list = memories.map((entry) => ({
    id: entry.id,
    scope: memoryScopeLabel(assistant, entry),
    content: entry.content.slice(0, MAX_CONTENT_CHARS),
  }));
  const hintText = hints.length > 0
    ? JSON.stringify(hints.map((hint) => ({ a: hint.a, b: hint.b, similarity: Number(hint.cos.toFixed(3)) })))
    : "（无向量提示，请自行判断）";
  return `你是记忆库整理器。检查下面一个助手可见的记忆，找出重复、可合并或互相矛盾的条目，输出整理方案。

记忆列表（id 全局唯一）：
${JSON.stringify(list, null, 2)}

向量相似度提示（a/b 为记忆 id，similarity 越高越可能重复）：
${hintText}

只输出 JSON：
{"operations":[{"op":"merge","targetId":1,"sourceIds":[2,3],"content":"合并后的完整内容"},{"op":"delete","targetId":4}]}

规则：
1. 只合并同一 scope 的记忆；targetId 保留，sourceIds 会被删除。
2. merge 的 content 必须保留双方全部重要事实，不添加新信息。
3. 不确定或信息不足时不要输出操作。
4. 最多 ${MAX_OPS} 个操作，不要删除所有记忆。
5. 不要输出 JSON 之外的任何文字。`;
}

function extractJson(text: string): unknown {
  let body = String(text ?? "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseOrganizeOperations(
  raw: string,
  visible: MemoryEntry[],
): Array<{ op: "merge" | "delete"; targetId: number; sourceIds?: number[]; content?: string }> {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = (parsed as Record<string, unknown>).operations;
  if (!Array.isArray(list)) return [];

  const ids = new Set(visible.map((entry) => entry.id));
  const scopeById = new Map<number, string>();
  for (const entry of visible) {
    const scope = memoryStore.scopeOfMemory(entry.id);
    scopeById.set(entry.id, scope ? JSON.stringify(scope) : "");
  }

  const operations: Array<{ op: "merge" | "delete"; targetId: number; sourceIds?: number[]; content?: string }> = [];
  const removed = new Set<number>();
  for (const item of list) {
    if (operations.length >= MAX_OPS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const op = String(record.op ?? "").toLowerCase();
    const targetId = Number(record.targetId);
    if (!ids.has(targetId)) continue;
    if (op === "delete") {
      if (!removed.has(targetId)) {
        operations.push({ op: "delete", targetId });
        removed.add(targetId);
      }
      continue;
    }
    if (op !== "merge") continue;
    const content = String(record.content ?? "").trim();
    if (!content || content.length > 4000) continue;
    const sourceIds = Array.isArray(record.sourceIds)
      ? record.sourceIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0 && value !== targetId && ids.has(value) && !removed.has(value))
      : [];
    const sameScope = sourceIds.filter((id) => scopeById.get(id) === scopeById.get(targetId) && scopeById.get(id) !== "");
    if (sameScope.length === 0) continue;
    operations.push({ op: "merge", targetId, sourceIds: sameScope, content });
    for (const id of sameScope) removed.add(id);
  }

  // 不允许把所有记忆都删/并掉：至少保留一条。
  if (removed.size >= visible.length) return [];
  return operations;
}
