// memory/write.ts — 助手提议记忆的统一落库入口
// 职责：写入策略解析 → 去重判定 → 落库 / 入待确认队列。工具层只负责参数与返回值。

import type { Assistant, MemoryEntry, MemoryFacets, MemoryKind, PendingEntry } from "../foundation/types";
import { decideMemoryWrite } from "./dedup";
import { memoryStore } from "./index";
import { mergeMemoryFacets, strongerMemoryKind } from "./experiment/entry";
import { resolveMemoryWriteTarget, type MemoryWriteTarget } from "./write-policy";

/** 实验扩展：结构化断言随内容一起落库。未提供时写入路径与旧实现逐字节一致。 */
export interface AssistantMemoryExperimentInput {
  kind?: MemoryKind;
  facets?: MemoryFacets | null;
  explicitRemember?: boolean;
  rawContent?: string | null;
  sourceCutMessageId?: string | null;
  idempotencyKey?: string | null;
  origin?: PendingEntry["origin"];
}

export interface AssistantMemoryWriteResult {
  status: "saved" | "merged" | "deduped" | "queued" | "overflow" | "readonly";
  scope?: MemoryWriteTarget;
  memory?: MemoryEntry;
  pendingId?: string;
}

export async function writeAssistantMemory(input: {
  assistant: Assistant;
  content: string;
  requestedScope?: unknown;
  source?: "ai" | "manual";
  context?: { conversationId?: string; conversationTitle?: string; messageNodeId?: string };
  experiment?: AssistantMemoryExperimentInput;
}): Promise<AssistantMemoryWriteResult> {
  const content = String(input.content ?? "").trim();
  if (!content) throw new Error("content is required");

  const resolved = resolveMemoryWriteTarget(input.assistant, input.requestedScope);
  if ("readonly" in resolved) return { status: "readonly" };

  if ("pending" in resolved) {
    const queued = await memoryStore.enqueuePending({
      conversationId: input.context?.conversationId ?? "",
      conversationTitle: input.context?.conversationTitle,
      assistantId: input.assistant.id,
      assistantName: input.assistant.name,
      content,
      messageNodeId: input.context?.messageNodeId,
      ...(input.experiment ? {
        kind: input.experiment.kind,
        facets: input.experiment.facets,
        explicitRemember: input.experiment.explicitRemember,
        rawContent: input.experiment.rawContent,
        sourceCutMessageId: input.experiment.sourceCutMessageId,
        idempotencyKey: input.experiment.idempotencyKey,
        origin: input.experiment.origin,
      } : {}),
    });
    if (queued === null) return { status: "deduped" };
    if (queued === "overflow") return { status: "overflow" };
    return { status: "queued", pendingId: queued.pendingId };
  }

  const target = resolved.scope;
  const decision = await decideMemoryWrite({
    content,
    targetScope: target,
    assistant: input.assistant,
    conversationId: input.context?.conversationId,
  });

  if (decision.action === "skip") {
    return { status: "deduped", scope: target };
  }
  if (decision.action === "merge" && decision.targetId != null && decision.mergedContent) {
    // 合并时分类只升不降、显式记住取或、标签取并集；新原文优先（旧的已被压缩过）。
    const existing = memoryStore.findEntryById(decision.targetId);
    const patch = existing && input.experiment
      ? {
        kind: strongerMemoryKind(existing.kind, input.experiment.kind),
        explicitRemember: existing.explicitRemember === true || input.experiment.explicitRemember === true,
        facets: mergeMemoryFacets(existing.facets, input.experiment.facets),
        ...(input.experiment.rawContent != null ? { rawContent: input.experiment.rawContent } : {}),
      }
      : undefined;
    const memory = memoryStore.updateMemory(
      decision.targetId,
      decision.mergedContent,
      input.source ?? "ai",
      patch,
    );
    return { status: "merged", scope: target, memory };
  }

  const memory = memoryStore.addMemory({
    scope: target,
    ...(target === "assistant" ? { assistantId: input.assistant.id } : {}),
    content,
    source: input.source ?? "ai",
    ...(input.experiment ? {
      kind: input.experiment.kind,
      facets: input.experiment.facets,
      explicitRemember: input.experiment.explicitRemember,
      rawContent: input.experiment.rawContent,
      sourceConversationId: input.context?.conversationId ?? null,
      sourceCutMessageId: input.experiment.sourceCutMessageId ?? null,
    } : {}),
  });
  return { status: "saved", scope: target, memory };
}
