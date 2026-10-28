// memory/dynamic-recall.ts — 实验：按最新用户意图的易变召回块（S9 / 计划 S9）
//
// 与特性 C 的会话开场召回（recall.ts）互补：
// - 开场召回冻结在 system 面的常驻记忆块里，同一会话逐字节复用（保前缀缓存）；
// - 易变召回按「最新一条用户消息」重新检索，作为独立块追加到该用户消息末尾，
//   不触碰冻结 system 快照。工具循环/重编码复用同一条消息的缓存，不会重复计费。
//
// 安全纪律：
// - 总开关 / dynamicRecall 关闭 → 无任何网络与缓存副作用；
// - 检索池只含 active（statusRecall 开启时），历史提问才放宽到 superseded / archived；
// - 记忆来源是本会话（sourceConversationId 相同）时不重复注入——它已在当前历史里；
// - 任何失败（嵌入超时、无模型、维度不符）都退回词法或空块，绝不阻断聊天；
// - 块内容有长度上限（topK ≤ 20，单条 ≤ 300 字），不会把每轮上下文撑爆。
import type { Assistant, Conversation, MemoryEntry, Message } from "../foundation/types";
import { textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { memoriesForAssistant } from "./index";
import { contentHash, loadMemoryVectors, openVectorDb } from "./vector-store";
import { resolveEmbeddingModel } from "./scene-models";
import { embedQueryVector } from "./embedding-client";
import { cosineSimilarity, tokenizeForLex, type RecallVector } from "./recall";
import { getRecallSelection, recallCacheGeneration } from "./recall-cache";
import { normalizeMemoryStatus } from "./experiment/entry";
import { getMemoryExperimentSettings, memoryExperimentFeature } from "./experiment/gate";
import { listMemoryEdges, openExperimentDb } from "./experiment/store";

/** 查询长度上限：与特性 C 的开场召回同口径。 */
const QUERY_MAX_CHARS = 2000;
/** 最新消息过短时补上一条用户消息的上下文；只补一轮，避免查询漂移。 */
const SHORT_QUERY_CHARS = 12;
const CONTEXT_QUERY_CHARS = 400;
const QUERY_EMBED_TIMEOUT_MS = 5_000;
const LEX_WEIGHT = 0.45;
const COS_WEIGHT = 0.55;
/** 当前意图的最低相关度：低于它宁可不注入，也不塞无关记忆。 */
const CURRENT_MIN_SCORE = 0.3;
/** 纯词法命中门槛：按「实体级」命中算——中文 ≥3 字短语或 ≥2 字实词、英文 ≥3 字符
 *  单词。用 lexicalScore 的 query 比例会被长问句稀释到阈值以下，而 2-gram 全量比对
 *  又会把「喜欢」「现在」这类虚词当成命中。 */
const LEX_MIN_SCORE = 0.3;
/** 恰好 2 字的中文公共子串里，这些是虚词/疑问词，不能当实体命中。 */
const CJK_FUNCTION_WORDS = new Set([
  "喜欢", "现在", "以前", "什么", "怎么", "今天", "明天", "昨天", "时候",
  "我们", "你们", "他们", "她们", "可以", "因为", "所以", "但是", "而且",
  "已经", "还是", "就是", "不是", "我的", "你的", "他的", "她的", "这个",
  "那个", "哪个", "没有", "有没", "是不", "的话", "一下", "一些", "一个",
  "觉得", "知道", "想要", "需要", "应该", "可能", "然后", "如果", "虽然",
  "不过", "只是", "这样", "那样", "哪里", "这里", "那里", "为何", "如何",
]);
const MAX_CACHE = 200;
const BLOCK_ITEM_MAX_CHARS = 300;

/** 历史提问标记：命中后允许过去状态参与检索，并在块内标注「可能已更新」。 */
const PAST_INTENT = /(以前|之前|过去|曾经|当时|那时|上次|上回|那年|used to|previously|last time|back then|in the past)/i;

interface DynamicRecallEntry {
  latestMessageId: string;
  assistantId: string;
  modelKey: string | null;
  generation: string | number;
  signature: string;
  block: string;
  builtAt: number;
}

const cache = new Map<string, DynamicRecallEntry>();

interface QueryTurn {
  messageId: string;
  text: string;
  history: boolean;
}

function selectedMessages(conversation: Conversation): Message[] {
  const out: Message[] = [];
  for (const node of conversation.messages ?? []) {
    const message = node.messages[node.selectIndex] ?? node.messages[0];
    if (message) out.push(message);
  }
  return out;
}

/** 最新一条用户消息；过短时向前补一轮用户消息作为有限上下文。 */
function latestQueryTurn(conversation: Conversation): QueryTurn | null {
  const messages = selectedMessages(conversation);
  const userTexts: Array<{ id: string; text: string }> = [];
  for (const message of messages) {
    if (String(message.role ?? "").toUpperCase() !== "USER") continue;
    const text = textFromParts(message.parts ?? []).trim();
    if (text) userTexts.push({ id: message.id, text });
  }
  const latest = userTexts.at(-1);
  if (!latest) return null;
  let query = latest.text;
  if (query.length < SHORT_QUERY_CHARS && userTexts.length > 1) {
    const previous = userTexts[userTexts.length - 2]!.text.slice(-CONTEXT_QUERY_CHARS);
    query = `${previous}\n${query}`;
  }
  query = query.slice(0, QUERY_MAX_CHARS);
  // 合并了上一轮短问句的上下文也算数：紧接着「以前去过哪？」的「那肯德基呢？」
  // 仍是历史提问。
  return { messageId: latest.id, text: query, history: PAST_INTENT.test(query) };
}

/** 检索用的文本：正文 + （历史提问时）原文 + 稀疏标签，让「人物/地点/标签」也能命中。 */
function searchText(memory: MemoryEntry, history: boolean): string {
  const parts = [memory.content];
  if (history && memory.rawContent) parts.push(memory.rawContent);
  const facets = memory.facets;
  if (facets) {
    for (const value of [facets.time, facets.place, facets.person, facets.event, ...(facets.tags ?? [])]) {
      if (value) parts.push(value);
    }
  }
  return parts.join(" ");
}

function usableVector(
  memory: MemoryEntry,
  vectors: ReadonlyMap<number, RecallVector>,
): Float32Array | null {
  const stored = vectors.get(memory.id);
  if (!stored) return null;
  if (stored.contentHash !== contentHash(memory.content)) return null;
  return stored.vector;
}

/** 最长公共子串（只比较中文字符，非中文直接剔除）。返回长度与样例文本。
 *  导出给第二轮提及计分复用——两处对「实体级重合」的口径必须一致。 */
export function longestCjkRun(a: string, b: string): { length: number; text: string } {
  const left = [...a].filter((ch) => /[\u3400-\u9fff]/.test(ch)).join("");
  const right = [...b].filter((ch) => /[\u3400-\u9fff]/.test(ch)).join("");
  if (!left || !right) return { length: 0, text: "" };
  const prev = new Array<number>(right.length + 1).fill(0);
  let best = 0;
  let end = 0;
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = prev[j]!;
      if (left[i - 1] === right[j - 1]) {
        prev[j] = diagonal + 1;
        if (prev[j]! > best) {
          best = prev[j]!;
          end = i;
        }
      } else {
        prev[j] = 0;
      }
      diagonal = saved;
    }
  }
  return best > 0 ? { length: best, text: left.slice(end - best, end) } : { length: 0, text: "" };
}

/** 实体级词法相关度：中文短语/实词 + 英文 ≥3 字符单词；纯虚词重合记 0。 */
export function lexicalRelevance(query: string, text: string): number {
  let shared = 0;
  let hasCjkShared = false;
  const textTokens = new Set(tokenizeForLex(text));
  for (const token of new Set(tokenizeForLex(query))) {
    if (!textTokens.has(token)) continue;
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 3) shared += token.length;
      continue;
    }
    // 只有非虚词的中文 2-gram 重合才值得做子串比对（DP 只跑在有候选的记忆上）。
    if (/[\u3400-\u9fff]/.test(token) && !CJK_FUNCTION_WORDS.has(token)) hasCjkShared = true;
  }
  if (hasCjkShared) {
    const run = longestCjkRun(query, text.slice(0, 1000));
    if (run.length >= 3) shared += run.length;
    else if (run.length === 2 && !CJK_FUNCTION_WORDS.has(run.text)) shared += 2;
  }
  return shared === 0 ? 0 : Math.min(1, shared / 5);
}

function maxLexical(query: string, memory: MemoryEntry, history: boolean): number {
  return lexicalRelevance(query, searchText(memory, history));
}

interface Candidate {
  memory: MemoryEntry;
  score: number;
  historical: boolean;
}

function selectCandidates(
  memories: readonly MemoryEntry[],
  query: string,
  queryVector: Float32Array | null,
  vectors: ReadonlyMap<number, RecallVector>,
  history: boolean,
  conversationId: string,
  excludedIds: ReadonlySet<number>,
  topK: number,
): Candidate[] {
  const pastCue = history && PAST_INTENT.test(query);
  const picked: Candidate[] = [];
  for (const memory of memories) {
    if (excludedIds.has(memory.id)) continue;
    // 本会话产生的记忆已经在当前历史里；再注入一次就是同义重复。
    if (memory.sourceConversationId === conversationId) continue;
    const status = normalizeMemoryStatus(memory.status);
    const historical = status !== "active";
    if (historical && (!history || status === "tombstone")) continue;
    const lex = maxLexical(query, memory, history);
    const vector = queryVector ? usableVector(memory, vectors) : null;
    const cos = vector ? cosineSimilarity(queryVector!, vector) : 0;
    let score = LEX_WEIGHT * lex + COS_WEIGHT * cos;
    // 时间线索 + 带结构化时间的记忆：历史/时序提问时轻微加权，不做时间推理。
    if (pastCue && (memory.facets?.time || memory.facets?.event) && lex > 0) score += 0.08;
    if (score < CURRENT_MIN_SCORE && lex < LEX_MIN_SCORE) continue;
    picked.push({ memory, score, historical });
  }
  return picked
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || b.memory.id - a.memory.id)
    .slice(0, topK);
}

const RELATED_SEEDS = 5;
const RELATED_MAX = 5;

/** 历史提问的关系扩展（supersedes / merged_into / related，双向各一层）：
 *  问到旧偏好时，「现在是什么」往往就是旧条目边指向的新条目；反过来亦然。
 *  只做一跳、最多 RELATED_MAX 条，且必须仍在检索池里（状态过滤已在池上做过）。 */
function expandRelated(
  seeds: readonly Candidate[],
  poolById: ReadonlyMap<number, MemoryEntry>,
  conversationId: string,
  excludedIds: ReadonlySet<number>,
): Candidate[] {
  const db = openExperimentDb();
  if (!db) return [];
  const extras: Candidate[] = [];
  const seen = new Set(seeds.map((item) => item.memory.id));
  for (const seed of seeds.slice(0, RELATED_SEEDS)) {
    let edges;
    try {
      edges = [
        ...listMemoryEdges(db, { sourceId: seed.memory.id }),
        ...listMemoryEdges(db, { targetId: seed.memory.id }),
      ];
    } catch {
      continue;
    }
    for (const edge of edges) {
      if (extras.length >= RELATED_MAX) return extras;
      const neighborId = edge.sourceId === seed.memory.id ? edge.targetId : edge.sourceId;
      if (seen.has(neighborId) || excludedIds.has(neighborId)) continue;
      const memory = poolById.get(neighborId);
      if (!memory) continue;
      const status = normalizeMemoryStatus(memory.status);
      if (status === "tombstone") continue;
      if (memory.sourceConversationId === conversationId) continue;
      seen.add(neighborId);
      extras.push({ memory, score: Math.max(0, seed.score - 0.05), historical: status !== "active" });
    }
  }
  return extras;
}

function renderBlock(candidates: Candidate[]): string {  if (candidates.length === 0) return "";
  const lines = candidates.map(({ memory, historical }) => {
    const text = memory.content.replace(/\s+/g, " ").trim().slice(0, BLOCK_ITEM_MAX_CHARS);
    return historical ? `- [过去，可能已更新] ${text}` : `- ${text}`;
  });
  return `<related_memories>
Retrieved for the user's latest message. Use them only when relevant; the current conversation and newer facts override anything here.
${lines.join("\n")}
</related_memories>`;
}

function settingsSignature(): string {
  const experiment = getMemoryExperimentSettings();
  const vector = state.settings.memoryVectorSettings;
  return [
    experiment.dynamicRecallTopK,
    experiment.statusRecall ? 1 : 0,
    vector.enabled ? 1 : 0,
    vector.topK,
    // 换嵌入模型/换维度时旧块立即失效（readDynamicRecallBlock 另有一道 key 校验）。
    state.settings.memoryVectorSettings.enabled ? (resolveEmbeddingModel()?.modelKey ?? "") : "",
  ].join("|");
}

function readCache(
  conversationId: string,
  assistantId: string,
  latestMessageId: string,
  generation: string | number,
): DynamicRecallEntry | null {
  const entry = cache.get(conversationId);
  if (!entry) return null;
  if (entry.assistantId !== assistantId) return null;
  if (entry.latestMessageId !== latestMessageId) return null;
  if (String(entry.generation) !== String(generation)) return null;
  if (entry.signature !== settingsSignature()) return null;
  return entry;
}

function storeCache(conversationId: string, entry: DynamicRecallEntry): void {
  cache.delete(conversationId);
  cache.set(conversationId, entry);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** 生成开始前调用（best-effort）：按最新用户消息重建易变召回块。
 *  同一会话同一消息 + 同一代际只算一次；任何失败都退化为词法或空块。 */
export async function prepareDynamicRecall(
  conversation: Conversation,
  assistant: Assistant,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal?.aborted) return;
    if (!memoryExperimentFeature("dynamicRecall")) {
      cache.delete(conversation.id);
      return;
    }
    const turn = latestQueryTurn(conversation);
    if (!turn) return;
    const generation = recallCacheGeneration(conversation.id);
    if (readCache(conversation.id, assistant.id, turn.messageId, generation)) return;

    const topK = getMemoryExperimentSettings().dynamicRecallTopK;
    const pool = memoriesForAssistant(assistant, turn.history ? "history" : "recall");
    if (pool.length === 0) {
      storeCache(conversation.id, {
        latestMessageId: turn.messageId,
        assistantId: assistant.id,
        modelKey: null,
        generation,
        signature: settingsSignature(),
        block: "",
        builtAt: Date.now(),
      });
      return;
    }

    const settings = state.settings.memoryVectorSettings;
    let modelKey: string | null = null;
    let queryVector: Float32Array | null = null;
    const vectors = new Map<number, RecallVector>();
    if (settings.enabled) {
      const ref = resolveEmbeddingModel();
      if (ref) {
        modelKey = ref.modelKey;
        const db = openVectorDb();
        const stored = db ? loadMemoryVectors(db, ref.modelKey) : new Map();
        for (const [id, row] of stored) vectors.set(id, { vector: row.vector, contentHash: row.contentHash });
        // 没有可用向量就不打查询嵌入：纯词法已能覆盖标签/原文命中。
        if (pool.some((memory) => usableVector(memory, vectors) != null)) {
          try {
            const timeout = AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS);
            queryVector = await embedQueryVector(
              ref,
              turn.text,
              signal ? AbortSignal.any([signal, timeout]) : timeout,
            );
          } catch (err) {
            if (signal?.aborted) return;
            console.warn(
              `[memory] 动态召回查询向量失败，按词法召回：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // 冻结的开场召回已经注入过的不再重复放进易变块。必须与 buildMemoryPrompt 同一判据
    // （助手 + 嵌入模型都对上才算冻结值生效），否则会误排除实际没注入的条目。
    const selection = getRecallSelection(conversation.id);
    const excludedIds = new Set<number>(
      selection && selection.assistantId === assistant.id && modelKey != null && selection.modelKey === modelKey
        ? selection.selectedIds
        : [],
    );
    const candidates = selectCandidates(
      pool,
      turn.text,
      queryVector,
      vectors,
      turn.history,
      conversation.id,
      excludedIds,
      topK,
    );
    // 历史提问才做关系扩展：当前问题多拉「现在」只会制造噪声。
    const related = turn.history
      ? expandRelated(candidates, new Map(pool.map((memory) => [memory.id, memory])), conversation.id, excludedIds)
      : [];
    const ordered = [...candidates, ...related]
      .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt || b.memory.id - a.memory.id)
      .slice(0, topK);
    storeCache(conversation.id, {
      latestMessageId: turn.messageId,
      assistantId: assistant.id,
      modelKey,
      generation,
      signature: settingsSignature(),
      block: renderBlock(ordered),
      builtAt: Date.now(),
    });
  } catch (err) {
    console.warn(`[memory] 动态召回失败，本轮不注入：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 编码前同步读取（聊天引擎在 conversationTransformedMessages 里用）。
 *  latestMessageId 必须与本次要追加的用户消息一致——否则会把上一条消息的召回块
 *  贴到新消息上（编辑重发/steer 后的典型错位）。代际/助手/嵌入模型/开关任一不符
 *  都返回空串。 */
export function readDynamicRecallBlock(
  conversationId: string,
  assistant: Assistant,
  latestMessageId?: string,
): string {
  if (!memoryExperimentFeature("dynamicRecall")) return "";
  const entry = cache.get(conversationId);
  if (!entry || !entry.block) return "";
  if (latestMessageId && entry.latestMessageId !== latestMessageId) return "";
  if (entry.assistantId !== assistant.id) return "";
  if (String(entry.generation) !== String(recallCacheGeneration(conversationId))) return "";
  if (entry.signature !== settingsSignature()) return "";
  const modelKey = state.settings.memoryVectorSettings.enabled
    ? (resolveEmbeddingModel()?.modelKey ?? null)
    : null;
  if (entry.modelKey !== modelKey) return "";
  return entry.block;
}

/** 已选中的动态召回 id（S10 提及计分只认"用户消息命中"，不认注入）。 */
export function clearDynamicRecall(conversationId: string): void {
  cache.delete(conversationId);
}

export function clearDynamicRecallCache(): void {
  cache.clear();
}
