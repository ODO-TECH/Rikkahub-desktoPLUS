// 结构化记忆断言：候选的校验与归一化。
// 只做纯数据变换，不读全局状态、不落库。工具参数、HTTP 入口、压缩后置共用同一个
// 校验器，保证三处写出的 kind / facets / 幂等键形状一致。
import type { MemoryFacets, MemoryKind } from "../../foundation/types";
import { normalizeMemoryFacets, normalizeMemoryKind } from "./entry";

export const ASSERTION_CONTENT_MAX = 2000;
export const ASSERTION_RAW_CONTENT_MAX = 12000;
export const ASSERTION_IDEMPOTENCY_MAX = 200;
export const ASSERTION_CONTEXT_ID_MAX = 200;

export type MemoryAssertionOrigin = "manual" | "tool" | "compaction";

export interface MemoryAssertion {
  content: string;
  kind: MemoryKind;
  facets: MemoryFacets | null;
  explicitRemember: boolean;
  rawContent: string | null;
  origin: MemoryAssertionOrigin;
  conversationId: string | null;
  messageNodeId: string | null;
  sourceCutMessageId: string | null;
  idempotencyKey: string | null;
  requestedScope: "global" | "assistant" | null;
  /** 归一化期间被纠正但不致命的输入（未知 kind、越界截断等），随审计记录。 */
  warnings: string[];
}

const ORIGINS: readonly MemoryAssertionOrigin[] = ["manual", "tool", "compaction"];

function cleanId(value: unknown, limit = ASSERTION_CONTEXT_ID_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.slice(0, limit);
}

/** 原文保留换行与排版，只去掉首尾空白；超长截断并记 warning。 */
function cleanRawContent(value: unknown, warnings: string[]): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= ASSERTION_RAW_CONTENT_MAX) return text;
  warnings.push(`rawContent truncated to ${ASSERTION_RAW_CONTENT_MAX} chars`);
  return text.slice(0, ASSERTION_RAW_CONTENT_MAX);
}

function normalizeOrigin(value: unknown): MemoryAssertionOrigin {
  return ORIGINS.includes(value as MemoryAssertionOrigin) ? (value as MemoryAssertionOrigin) : "manual";
}

function normalizeRequestedScope(value: unknown): "global" | "assistant" | null {
  return value === "global" || value === "assistant" ? value : null;
}

/**
 * 校验并归一化一条结构化断言。
 * content 缺失 / 非字符串 / 全空白 → 抛错（调用方转 400 或 tool_result）。
 * kind 未知不抛错：降级 unclassified 并记 warning——不能因为分类词不标准就吞掉整条记忆。
 * explicitRemember 同时接受 camelCase 与工具参数的 snake_case。
 */
export function normalizeMemoryAssertion(
  raw: unknown,
  defaults: { origin?: MemoryAssertionOrigin; conversationId?: string; messageNodeId?: string } = {},
): MemoryAssertion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("memory assertion must be an object");
  }
  const input = raw as Record<string, unknown>;
  const warnings: string[] = [];

  if (typeof input.content !== "string") throw new Error("content is required");
  const content = input.content.trim();
  if (!content) throw new Error("content is required");
  if (content.length > ASSERTION_CONTENT_MAX) {
    throw new Error(`content exceeds ${ASSERTION_CONTENT_MAX} characters`);
  }

  const rawKind = input.kind;
  let kind = normalizeMemoryKind(rawKind);
  if (rawKind != null && String(rawKind).trim() !== "" && kind === "unclassified" && rawKind !== "unclassified") {
    warnings.push(`unknown kind "${String(rawKind)}" stored as unclassified`);
  }

  const facets = normalizeMemoryFacets(input.facets);
  if (input.facets != null && facets == null) warnings.push("facets dropped: not a non-empty object");

  const explicitRemember = input.explicitRemember === true || input.explicit_remember === true;
  const origin = defaults.origin ?? normalizeOrigin(input.origin);

  return {
    content,
    kind,
    facets,
    explicitRemember,
    rawContent: cleanRawContent(input.rawContent ?? input.raw_content, warnings),
    origin,
    conversationId: cleanId(input.conversationId) ?? cleanId(defaults.conversationId),
    messageNodeId: cleanId(input.messageNodeId) ?? cleanId(defaults.messageNodeId),
    sourceCutMessageId: cleanId(input.sourceCutMessageId ?? input.source_cut_message_id ?? input.cutMessageId),
    idempotencyKey: cleanId(input.idempotencyKey ?? input.idempotency_key, ASSERTION_IDEMPOTENCY_MAX),
    requestedScope: normalizeRequestedScope(input.requestedScope ?? input.scope)
      ?? normalizeRequestedScope(input.requested_scope),
    warnings,
  };
}

/** 工具参数 → 断言。field 名保持 OpenAI schema 的 snake_case。 */
export function assertionFromToolArgs(
  args: Record<string, unknown>,
  context?: { conversationId?: string; messageNodeId?: string },
): MemoryAssertion {
  return normalizeMemoryAssertion(
    {
      content: args.content,
      kind: args.kind,
      facets: args.facets,
      explicit_remember: args.explicit_remember,
      scope: args.scope,
    },
    { origin: "tool", ...context },
  );
}
