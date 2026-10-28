// model-providers/embeddings.ts — 嵌入（/embeddings）与重排（/rerank）两条非聊天出线路
//
// 为什么单独成文件：这两类模型不参与对话编码（不进 orchestrator、不进 pi 引擎），
// 但必须「真的能打出去」——设置页的模型检测、后续的记忆索引与召回都复用这里的同一份
// 请求构造与响应解析，避免「UI 能选、后端没路」的假支持。
//
// 契约来源：OpenAI 兼容 /embeddings（{model, input: string[]} → data[].embedding）与
// 主流 rerank 服务（{model, query, documents, top_n} → results[].relevance_score）。
// 端点构造与 endpointFor 同款纪律：baseUrl 剥尾斜杠后拼固定尾缀，非标准路径由模型级
// providerOverwrite.baseUrl 承载（findModel 已在请求构建期整体替换父供应商）。

import { fetchWithTimeout } from "../foundation/net";
import type { JsonValue, Model, NonChatModelType, Provider } from "../foundation/types";
import { addLog } from "../api/logs";
import { applyModelCustomBody, applyModelRequestHeaders, jsonBody, textBody } from "./index";
import { resolveProviderAuthForProvider } from "./auth";
import { upstreamHttpError } from "../inference-engine/providers";

/** 单次检测/小批量嵌入的总时长上限：嵌入服务通常在秒级，60s 足够且不掩护永挂连接。 */
const NON_CHAT_TIMEOUT_MS = 60_000;

export const EMBEDDINGS_PATH = "/embeddings";
export const RERANK_PATH = "/rerank";

/** 运行期的非聊天类型判定（类型定义在 foundation/types，那里只放类型不放值）。 */
export function isNonChatModelType(value: unknown): value is NonChatModelType {
  const upper = String(value ?? "").toUpperCase();
  return upper === "EMBEDDING" || upper === "RERANK";
}

/** 只有 OpenAI 兼容协议有这两条线路：claude/google 没有 /embeddings 与 /rerank，
 *  报错要说清「换一个 openai 型供应商」而不是打出裸 404。 */
export function assertOpenAiCompatible(providerItem: Provider, kind: NonChatModelType): void {
  if (providerItem.type !== "openai") {
    throw new Error(
      `${kind === "EMBEDDING" ? "嵌入" : "重排"}只支持 OpenAI 兼容供应商（当前 ${providerItem.name} 是 ${providerItem.type} 型）。` +
        `硅基流动、火山方舟、阿里云百炼、MiniMax、Jina、Voyage 等都用 OpenAI 兼容形态添加即可。`,
    );
  }
}

function baseOf(providerItem: Provider, baseUrlOverride?: string): string {
  return (baseUrlOverride?.trim() || providerItem.baseUrl || "").replace(/\/+$/, "");
}

/** 嵌入端点：`${base}/embeddings`。base 取 provider.baseUrl（或订阅凭据派生的 override）。 */
export function embeddingsEndpointFor(providerItem: Provider, baseUrlOverride?: string): string {
  return `${baseOf(providerItem, baseUrlOverride)}${EMBEDDINGS_PATH}`;
}

/** 重排端点：`${base}/rerank`。各家实际路径都由 baseUrl 承载——
 *  SiliconFlow/Jina/Voyage 填 …/v1、Cohere 填 https://api.cohere.com/v2，拼出来即真值。 */
export function rerankEndpointFor(providerItem: Provider, baseUrlOverride?: string): string {
  return `${baseOf(providerItem, baseUrlOverride)}${RERANK_PATH}`;
}

export function nonChatEndpointFor(
  providerItem: Provider,
  kind: NonChatModelType,
  baseUrlOverride?: string,
): string {
  return kind === "EMBEDDING"
    ? embeddingsEndpointFor(providerItem, baseUrlOverride)
    : rerankEndpointFor(providerItem, baseUrlOverride);
}

// ── 请求体（纯函数，可单测） ────────────────────────────────────────────────

export function embeddingsRequestBody(modelId: string, texts: string[]): Record<string, JsonValue> {
  const input = (texts ?? []).map((text) => String(text ?? "")).filter((text) => text.length > 0);
  if (input.length === 0) throw new Error("嵌入请求体缺少有效文本（input 为空）");
  return { model: modelId, input };
}

export function rerankRequestBody(
  modelId: string,
  query: string,
  documents: string[],
  topN?: number,
): Record<string, JsonValue> {
  const docs = (documents ?? []).map((doc) => String(doc ?? "")).filter((doc) => doc.length > 0);
  if (!String(query ?? "").trim()) throw new Error("重排请求体缺少查询（query 为空）");
  if (docs.length === 0) throw new Error("重排请求体缺少候选文档（documents 为空）");
  const body: Record<string, JsonValue> = { model: modelId, query: String(query), documents: docs };
  // top_n 缺省不写：多数服务默认返回全部，写了反而被部分网关当成「只要前 N」而丢数据。
  const n = Number(topN);
  if (Number.isFinite(n) && n > 0) body.top_n = Math.min(Math.floor(n), docs.length);
  return body;
}

// ── 响应解析（纯函数，可单测） ──────────────────────────────────────────────

export interface EmbeddingsResult {
  /** 与请求 input 同序的向量（按 data[].index 归位）。 */
  vectors: number[][];
  dim: number;
  usage: { promptTokens?: number; totalTokens?: number };
}

function finiteNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === "number" ? item : Number(item);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  // 空数组原样返回（不是 null）：让下游报「向量长度为 0」这种说得出原因的错误，
  // 而不是把它伪装成「形态不认识」。
  return out;
}

/** 解析 /embeddings 响应。形态差异只认这三处：data[].embedding（OpenAI 系）、
 *  data[].embedding 为字符串（个别网关把数组序列化成 JSON 串）、embeddings[]（Voyage/Jina 旧形态）。
 *  解析不出向量一律抛可读错误——让检测页显示「响应形态不认识」而不是「测试失败」。 */
export function parseEmbeddingsPayload(raw: any, expectedCount?: number): EmbeddingsResult {
  const rows: any[] = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.embeddings)
      ? raw.embeddings
      : Array.isArray(raw?.output?.embeddings)
        ? raw.output.embeddings
        : [];
  if (rows.length === 0) throw new Error("嵌入响应里没有 data[].embedding：供应商返回了非预期形态（检查模型类型是否真是嵌入模型）");
  const indexed = rows
    .map((row, i) => {
      const parsed = typeof row?.embedding === "string" ? safeJsonArray(row.embedding) : row?.embedding;
      const vector = finiteNumbers(parsed ?? row);
      const idxRaw = Number(row?.index);
      return { i: Number.isFinite(idxRaw) ? idxRaw : i, vector };
    })
    .sort((a, b) => a.i - b.i);
  const parsed = indexed.map((item) => item.vector);
  if (parsed.some((vector) => vector === null)) {
    throw new Error("嵌入响应中的向量不是数字数组：供应商返回了非预期形态");
  }
  const vectors = parsed.filter((vector): vector is number[] => vector !== null);
  const dims = new Set(vectors.map((vector) => vector.length));
  if (dims.size > 1) {
    throw new Error(`嵌入响应中各条向量维度不一致（${[...dims].join(" / ")}）：供应商返回异常`);
  }
  const dim = vectors[0]?.length ?? 0;
  if (!dim) throw new Error("嵌入响应中的向量长度为 0");
  if (expectedCount !== undefined && vectors.length !== expectedCount) {
    throw new Error(`嵌入响应条数不符：请求 ${expectedCount} 条，返回 ${vectors.length} 条`);
  }
  return {
    vectors,
    dim,
    usage: {
      promptTokens: numberOrUndefined(raw?.usage?.prompt_tokens),
      totalTokens: numberOrUndefined(raw?.usage?.total_tokens),
    },
  };
}

export interface RerankResult {
  /** 按相关度降序；index 指向请求 documents 的下标。 */
  results: { index: number; score: number }[];
}

function safeJsonArray(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析 /rerank 响应。三家形态并存：OpenAI 兼容与 Cohere/Jina/SiliconFlow 用
 *  results[].relevance_score（个别写作 score / relevanceScore），Xinference 等只给
 *  scores[]（下标即文档序）。全部归一为 {index, score} 并按分数降序。 */
export function parseRerankPayload(raw: any, documentCount?: number): RerankResult {
  const rows: any[] = Array.isArray(raw?.results) ? raw.results : [];
  let scored: { index: number; score: number }[] = [];
  if (rows.length > 0) {
    scored = rows
      .map((row, i) => {
        const idxRaw = Number(row?.index);
        const scoreRaw = row?.relevance_score ?? row?.relevanceScore ?? row?.score;
        const score = numberOrUndefined(scoreRaw);
        return { index: Number.isFinite(idxRaw) ? idxRaw : i, score: score ?? Number.NEGATIVE_INFINITY, valid: score != null };
      })
      .filter((item) => item.valid)
      .map((item) => ({ index: item.index, score: item.score }))
      .sort((a, b) => b.score - a.score);
  } else if (Array.isArray(raw?.scores)) {
    scored = raw.scores
      .map((value: unknown, index: number) => ({ index, score: numberOrUndefined(value) ?? Number.NEGATIVE_INFINITY }))
      .filter((item: { score: number }) => Number.isFinite(item.score))
      .sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  }
  if (scored.length === 0) {
    throw new Error("重排响应里没有 results[].relevance_score：供应商返回了非预期形态（检查模型类型是否真是重排模型）");
  }
  if (documentCount !== undefined && scored.some((item) => item.index < 0 || item.index >= documentCount)) {
    throw new Error(`重排响应中的 index 越界（文档共 ${documentCount} 条）：供应商返回异常`);
  }
  return { results: scored };
}

// ── 出站调用 ────────────────────────────────────────────────────────────────

interface NonChatCallInput {
  provider: Provider;
  model: Model;
  kind: NonChatModelType;
  body: Record<string, JsonValue>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 两条线路共用一次出站：凭据解析（订阅轨锁内刷新）→ 模型级 customBodies →
 *  provider/model 两级 customHeaders + 主机特例 + 会话身份头 → 请求日志。
 *  日志 kind 为 provider:embeddings / provider:rerank，与 chat 的 provider:test 同进「模型请求」分组。 */
async function callNonChat(input: NonChatCallInput): Promise<any> {
  const { provider: providerItem, model: modelItem, kind, body } = input;
  assertOpenAiCompatible(providerItem, kind);
  const resolved = await resolveProviderAuthForProvider(providerItem, { signal: input.signal });
  const endpoint = nonChatEndpointFor(providerItem, kind, resolved.baseUrl);
  const finalBody = applyModelCustomBody(body, modelItem);
  const headers = applyModelRequestHeaders(
    { "Content-Type": "application/json", ...resolved.headers },
    providerItem,
    modelItem,
  );
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      timeoutMs: input.timeoutMs ?? NON_CHAT_TIMEOUT_MS,
      signal: input.signal,
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addLog({
      providerId: providerItem.id,
      providerName: providerItem.name,
      url: endpoint,
      ok: false,
      status: 0,
      kind: `provider:${kind === "EMBEDDING" ? "embeddings" : "rerank"}`,
      durationMs: Date.now() - started,
      method: "POST",
      requestHeaders: headers,
      requestBody: jsonBody(finalBody),
      responseBody: "",
      error: detail,
    });
    throw new Error(
      `${kind === "EMBEDDING" ? "嵌入" : "重排"}请求未能发送到供应商。\n${detail}\n\n请检查 Base URL、API 路径、API Key、代理或供应商服务状态。`,
    );
  }
  const text = await response.text();
  let raw: any = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  addLog({
    providerId: providerItem.id,
    providerName: providerItem.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: `provider:${kind === "EMBEDDING" ? "embeddings" : "rerank"}`,
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    requestBody: jsonBody(finalBody),
    responseHeaders: Object.fromEntries(response.headers.entries()),
    responseBody: textBody(text),
    error: response.ok ? undefined : textBody(text),
  });
  if (!response.ok) {
    // 把 HTTP 状态挂在错误对象上：检测面板要显示状态码，而 upstreamHttpError 只产出文案。
    const error = upstreamHttpError(providerItem, endpoint, response.status, text || response.statusText);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return raw;
}

/** 真实嵌入调用：texts 与返回向量同序。 */
export async function callEmbeddings(
  providerItem: Provider,
  modelItem: Model,
  texts: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<EmbeddingsResult> {
  const body = embeddingsRequestBody(modelItem.modelId, texts);
  const raw = await callNonChat({
    provider: providerItem,
    model: modelItem,
    kind: "EMBEDDING",
    body,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
  });
  return parseEmbeddingsPayload(raw, texts.length);
}

/** 真实重排调用：返回按相关度降序的 {index, score}。 */
export async function callRerank(
  providerItem: Provider,
  modelItem: Model,
  query: string,
  documents: string[],
  opts?: { signal?: AbortSignal; topN?: number; timeoutMs?: number },
): Promise<RerankResult> {
  const body = rerankRequestBody(modelItem.modelId, query, documents, opts?.topN);
  const raw = await callNonChat({
    provider: providerItem,
    model: modelItem,
    kind: "RERANK",
    body,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
  });
  return parseRerankPayload(raw, documents.length);
}

// ── 模型检测用的一次性极小请求 ──────────────────────────────────────────────
// 检测会打到真实供应商，但只送一句话/两条文档（量级：个位数 token），与聊天连通性
// 测试送 "hello" 同纪律。成本可忽略，仍需用户主动点「测试」才发。

export const PROBE_EMBEDDING_TEXT = "rikkahub connectivity check";
export const PROBE_RERANK_QUERY = "rikkahub connectivity check";
export const PROBE_RERANK_DOCUMENTS = [
  "RikkaHub Desktop keeps a local memory store.",
  "The weather is mild today.",
];

export interface NonChatProbeOk {
  kind: NonChatModelType;
  endpoint: string;
  /** 嵌入：向量维度；重排：参与打分的文档数。 */
  dim?: number;
  documentCount?: number;
  scores?: { index: number; score: number }[];
  durationMs: number;
  /** 首条向量的前若干个分量，供人眼确认「真是向量」而不是全 0。 */
  sample?: number[];
  usage?: EmbeddingsResult["usage"];
}

/** 一次极小真实请求验证模型可用；把结果折算成人能读懂的一句话。 */
export async function probeNonChatModel(
  providerItem: Provider,
  modelItem: Model,
  kind: NonChatModelType,
  opts?: { signal?: AbortSignal },
): Promise<NonChatProbeOk> {
  const started = Date.now();
  const endpoint = nonChatEndpointFor(providerItem, kind);
  if (kind === "EMBEDDING") {
    const result = await callEmbeddings(providerItem, modelItem, [PROBE_EMBEDDING_TEXT], opts);
    return {
      kind,
      endpoint,
      dim: result.dim,
      durationMs: Date.now() - started,
      sample: result.vectors[0]?.slice(0, 4),
      usage: result.usage,
    };
  }
  const result = await callRerank(providerItem, modelItem, PROBE_RERANK_QUERY, PROBE_RERANK_DOCUMENTS, opts);
  return {
    kind,
    endpoint,
    documentCount: PROBE_RERANK_DOCUMENTS.length,
    durationMs: Date.now() - started,
    scores: result.results,
  };
}

/** 探测结果 → 界面可读的一行。放在服务端是为了 PC 自己的检测面板与 API 返回同一句话。 */
export function describeNonChatProbe(result: NonChatProbeOk): string {
  const seconds = (result.durationMs / 1000).toFixed(2);
  if (result.kind === "EMBEDDING") {
    const sample = result.sample?.length
      ? `，首维前 4 项 ${result.sample.map((n) => n.toFixed(4)).join(", ")}`
      : "";
    const tokens = result.usage?.totalTokens ? `，消耗 ${result.usage.totalTokens} token` : "";
    return `嵌入可用：维度 ${result.dim}，耗时 ${seconds}s${sample}${tokens}`;
  }
  const scores = result.scores?.length
    ? `，相关度 ${result.scores.map((item) => `#${item.index}=${item.score.toFixed(4)}`).join(" ")}`
    : "";
  return `重排可用：对 ${result.documentCount} 条文档打分，耗时 ${seconds}s${scores}`;
}
