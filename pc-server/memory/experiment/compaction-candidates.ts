// 压缩后置候选适配器：把一段即将被摘要取代的原文改写成结构化记忆断言，
// 只入待确认队列（pending），由用户逐条确认后才成为记忆。
//
// 触发点：聊天引擎 compressConversation 落库之后（手动 + 自动）与 pi 压缩记录
// 落库之后（手动 + 自动）。两条链路都只调 scheduleCompactionCandidates，本模块：
// - 总开关/单项开关关闭 → 直接返回，零副作用（不读模型、不写审计）；
// - 同一会话同一切点只处理一次（审计幂等键），失败可重试；
// - 任何异常都吞掉并记错误中心，绝不阻塞压缩或对话；
// - 提取结果只走 enqueuePending，不直接写记忆（dry-run 语义天然满足）。
import { createHash } from "node:crypto";
import type { Assistant, Conversation, Message } from "../../foundation/types";
import { textFromParts } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { reportError } from "../../observability/app-errors";
import { broadcastMemoryUpdate } from "../../api/sse";
import { fetchAuxiliaryText } from "../../conversations/auxiliary";
import { selectedConversationMessages } from "../../conversations/index";
import { parseEngineCompactions } from "../../inference-engine/engine-compaction";
import { memoryStore } from "../index";
import { memoryModelThinkingEnabled, resolveMemoryModel } from "../memory-model";
import { normalizeMemoryAssertion, type MemoryAssertion } from "./assertions";
import { getMemoryExperimentSettings, memoryExperimentFeature, memoryExperimentLlmAllowed } from "./gate";
import { getAuditByIdempotencyKey, openExperimentDb, recordAudit, updateAuditResult } from "./store";

/** 送进提取模型的原文预算。压缩段可能很长，只取靠近切点的一端：
 *  更早的内容若已进过上一轮摘要/候选，就不必重复付费。 */
const CANDIDATE_TRANSCRIPT_MAX_CHARS = 16_000;
/** 单条候选的展示长度上限（与记忆内容上限一致）。 */
const MODEL_MAX_TOKENS = 2_000;

export interface CompactionCandidateOutcome {
  status: "disabled" | "skipped" | "queued" | "empty" | "failed";
  reason?: string;
  queued: number;
  deduped: number;
  overflow: number;
  candidates: number;
}

const inFlight = new Set<string>();

function assistantFor(conversation: Conversation): Assistant | null {
  return state.settings.assistants.find((item) => item.id === conversation.assistantId) ?? null;
}

/** 只取正文：工具输出、附件与图片在压缩时已另行处理，对长期记忆提取是噪声。
 *  同时返回被纳入原文的消息 id（证据），审计里至少能回溯候选来自哪一段。 */
interface TranscriptBuild {
  transcript: string;
  /** 按时间升序；被截断的那条也算证据（它仍有部分原文进入模型）。 */
  messageIds: string[];
}

function buildTranscript(messages: Message[]): TranscriptBuild {
  const lines: string[] = [];
  const messageIds: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index]!;
    const text = textFromParts(msg.parts ?? []).trim();
    if (!text) continue;
    const line = `[${msg.role}]: ${text}`;
    if (total + line.length > CANDIDATE_TRANSCRIPT_MAX_CHARS) {
      const room = CANDIDATE_TRANSCRIPT_MAX_CHARS - total;
      if (room > 200) {
        lines.unshift(`[更早内容已截断]\n${line.slice(-room)}`);
        messageIds.unshift(msg.id);
      }
      break;
    }
    lines.unshift(line);
    messageIds.unshift(msg.id);
    total += line.length;
  }
  return { transcript: lines.join("\n\n"), messageIds };
}

export function compactionTranscript(messages: Message[]): string {
  return buildTranscript(messages).transcript;
}

function buildPrompt(assistant: Assistant, transcript: string, maxCandidates: number): string {
  return `你是长期记忆提取器。下面是一段即将被压缩成摘要的对话原文，请从中提取值得长期保留的记忆断言。

助手：${assistant.name}
对话原文：
${transcript}

只输出 JSON：
{"candidates":[{"content":"一句话断言","kind":"setting|habit|event","facets":{"time":"","place":"","person":"","event":"","tags":[""]},"explicitRemember":false}]}

规则：
1. kind 只能是 setting / habit / event：setting = 稳定设定、身份、偏好、长期事实；habit = 反复出现的习惯或惯例；event = 一次性发生的事。
2. content 用完整句子写清「谁 / 何时何地 / 做了什么」，不超过 200 字；不要照抄大段原文，不要写助手自己的寒暄或承诺。
3. facets 稀疏填写：只有原文明确给出时才填 time / place / person / event；tags 1~3 个短标签。没有依据的键直接省略。
4. explicitRemember 仅在用户明确要求「记住 / 记下来 / 别忘了」时为 true，其余为 false。
5. 忽略寒暄、一次性工具输出、临时状态、密码 / 密钥 / 证件号等敏感信息。
6. 最多 ${maxCandidates} 条；没有值得记的内容输出 {"candidates":[]}。
7. 不要输出 JSON 之外的任何文字。`;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let body = String(text ?? "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCandidateItems(raw: string, maxCandidates: number): Array<Record<string, unknown>> {
  const parsed = extractJsonObject(raw);
  const list = parsed?.candidates;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .slice(0, maxCandidates);
}

/** 断言内容的稳定哈希（16 hex）：幂等键 = 会话 + 切点 + 断言哈希。
 *  模型重跑时只要内容不变就命中同一条 pending；换了措辞则视为新候选，交由
 *  enqueuePending 的内容去重兜底。位置序号不参与——候选顺序变化不应产生重复。 */
function assertionHash(content: string): string {
  return createHash("sha256").update(content.trim(), "utf8").digest("hex").slice(0, 16);
}

/** 模型输出 → 归一化断言。切点/幂等键由适配器统一写死，模型同名输出不被采信；
 *  同批次内容去重，非法条目跳过而不是整批失败。 */
export function parseCompactionCandidates(
  raw: string,
  options: { conversationId: string; cutMessageId: string; maxCandidates: number },
): MemoryAssertion[] {
  const assertions: MemoryAssertion[] = [];
  const seen = new Set<string>();
  for (const item of parseCandidateItems(raw, options.maxCandidates)) {
    let assertion: MemoryAssertion;
    try {
      assertion = normalizeMemoryAssertion(item, {
        origin: "compaction",
        conversationId: options.conversationId,
      });
    } catch {
      continue;
    }
    assertion.sourceCutMessageId = options.cutMessageId;
    assertion.idempotencyKey = `compaction:${options.conversationId}:${options.cutMessageId}:${assertionHash(assertion.content)}`;
    const key = assertion.content.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    assertions.push(assertion);
    if (assertions.length >= options.maxCandidates) break;
  }
  return assertions;
}

function summarizeCandidates(assertions: MemoryAssertion[]): Array<Record<string, unknown>> {
  return assertions.map((assertion) => ({
    content: assertion.content.slice(0, 200),
    kind: assertion.kind,
    explicitRemember: assertion.explicitRemember,
    facets: assertion.facets,
  }));
}

async function runCandidates(
  conversation: Conversation,
  assistant: Assistant,
  messages: Message[],
  cutMessageId: string,
  auditId: string,
  db: NonNullable<ReturnType<typeof openExperimentDb>>,
): Promise<CompactionCandidateOutcome> {
  const maxCandidates = getMemoryExperimentSettings().maxCandidatesPerCompaction;
  if (maxCandidates <= 0) {
    updateAuditResult(db, auditId, "info", { reason: "max_candidates_zero" });
    return { status: "skipped", reason: "max_candidates_zero", queued: 0, deduped: 0, overflow: 0, candidates: 0 };
  }
  const model = resolveMemoryModel();
  if (!model) {
    updateAuditResult(db, auditId, "failed", { reason: "memory_model_unset" });
    return { status: "skipped", reason: "memory_model_unset", queued: 0, deduped: 0, overflow: 0, candidates: 0 };
  }

  const built = buildTranscript(messages);
  const transcript = built.transcript;
  if (!transcript.trim()) {
    updateAuditResult(db, auditId, "info", { reason: "empty_transcript" });
    return { status: "skipped", reason: "empty_transcript", queued: 0, deduped: 0, overflow: 0, candidates: 0 };
  }

  let raw = "";
  try {
    raw = await fetchAuxiliaryText(
      model.model.id,
      buildPrompt(assistant, transcript, maxCandidates),
      "memory-compaction",
      {
        maxTokens: MODEL_MAX_TOKENS,
        conversationId: conversation.id,
        reasoningLevel: memoryModelThinkingEnabled() ? "AUTO" : undefined,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateAuditResult(db, auditId, "failed", { reason: "model_call_failed", error: message });
    reportError("provider", "warn", `压缩后置记忆候选调用失败：${message}`, err, "memory_compaction_candidates_failed", {
      conversationId: conversation.id,
    });
    return { status: "failed", reason: "model_call_failed", queued: 0, deduped: 0, overflow: 0, candidates: 0 };
  }

  const assertions = parseCompactionCandidates(raw, {
    conversationId: conversation.id,
    cutMessageId,
    maxCandidates,
  });
  if (assertions.length === 0) {
    updateAuditResult(db, auditId, "info", {
      reason: "no_candidates",
      transcriptChars: transcript.length,
      evidenceMessageIds: built.messageIds.slice(-100),
    });
    return { status: "empty", queued: 0, deduped: 0, overflow: 0, candidates: 0 };
  }

  let queued = 0;
  let deduped = 0;
  let overflow = 0;
  for (const assertion of assertions) {
    try {
      const result = await memoryStore.enqueuePending({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        assistantId: assistant.id,
        assistantName: assistant.name,
        content: assertion.content,
        kind: assertion.kind,
        facets: assertion.facets,
        explicitRemember: assertion.explicitRemember,
        rawContent: assertion.rawContent,
        sourceCutMessageId: cutMessageId,
        idempotencyKey: assertion.idempotencyKey,
        origin: "compaction",
      });
      if (result === null) deduped += 1;
      else if (result === "overflow") overflow += 1;
      else queued += 1;
    } catch (err) {
      reportError("persistence", "warn", "压缩后置记忆候选入队失败", err, "memory_compaction_candidates_enqueue_failed", {
        conversationId: conversation.id,
      });
    }
  }

  const detail = {
    cutMessageId,
    transcriptChars: transcript.length,
    // 证据消息 id（时间升序，最多保留最近 100 条）：审计可回溯候选来自哪段原文。
    evidenceMessageIds: built.messageIds.slice(-100),
    candidates: summarizeCandidates(assertions),
    queued,
    deduped,
    overflow,
  };
  updateAuditResult(db, auditId, queued > 0 ? "applied" : "info", detail);
  if (queued > 0) broadcastMemoryUpdate();
  return {
    status: queued > 0 ? "queued" : "empty",
    queued,
    deduped,
    overflow,
    candidates: assertions.length,
  };
}

/** 计算本次压缩覆盖的原文：上一条压缩记录的切点 → 最新记录的切点。
 *  没有上一条记录时从会话开头算。切点不在历史中（被编辑/删除）时保守取全量。 */
function compactedRange(conversation: Conversation): { messages: Message[]; cutMessageId: string } | null {
  const records = parseEngineCompactions(conversation.engineCompactions);
  const latest = records.at(-1);
  if (!latest) return null;
  const all = selectedConversationMessages(conversation);
  const cutIndex = all.findIndex((msg) => msg.id === latest.cutMessageId);
  if (cutIndex < 0) return null;
  const previous = records.at(-2);
  const previousIndex = previous ? all.findIndex((msg) => msg.id === previous.cutMessageId) : 0;
  const start = previousIndex > 0 && previousIndex < cutIndex ? previousIndex : 0;
  return { messages: all.slice(start, cutIndex), cutMessageId: latest.cutMessageId };
}

/**
 * 压缩完成后的最佳努力后置：不 await、不抛错。调用方在压缩落库之后调用一次即可。
 * 同一会话同一切点重复调用只处理一次（审计幂等 + 进程内 in-flight 保护）。
 */
export function scheduleCompactionCandidates(conversation: Conversation): void {
  if (!memoryExperimentFeature("compactionCandidates")) return;
  if (!memoryExperimentLlmAllowed()) return;
  const assistant = assistantFor(conversation);
  if (!assistant || !assistant.enableMemory) return;
  if (assistant.memoryWriteScope === "readonly") return;
  const range = compactedRange(conversation);
  if (!range || range.messages.length === 0) return;
  const db = openExperimentDb();
  if (!db) return;

  const idempotencyKey = `compaction:${conversation.id}:${range.cutMessageId}`;
  if (inFlight.has(idempotencyKey)) return;
  const existing = getAuditByIdempotencyKey(db, idempotencyKey);
  if (existing && existing.status !== "failed") return;

  const reservation = recordAudit(db, {
    action: "compaction_candidates",
    status: "proposed",
    conversationId: conversation.id,
    idempotencyKey,
    detail: {
      cutMessageId: range.cutMessageId,
      messageCount: range.messages.length,
      assistantId: assistant.id,
    },
  });
  if (!reservation.inserted && existing == null) return;
  const auditId = existing?.auditId ?? reservation.auditId;
  if (!reservation.inserted && existing) {
    updateAuditResult(db, auditId, "proposed", { retry: true });
  }

  inFlight.add(idempotencyKey);
  void runCandidates(conversation, assistant, range.messages, range.cutMessageId, auditId, db)
    .catch((err) => {
      updateAuditResult(db, auditId, "failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      reportError("provider", "warn", "压缩后置记忆候选失败", err, "memory_compaction_candidates_failed", {
        conversationId: conversation.id,
      });
    })
    .finally(() => {
      inFlight.delete(idempotencyKey);
    });
}
