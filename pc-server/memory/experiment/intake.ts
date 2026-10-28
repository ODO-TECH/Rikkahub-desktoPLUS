// 结构化断言的统一入口：门控 → 幂等占位 → 写入策略 → 审计收尾。
// 不直接改记忆数组：写入仍走 writeAssistantMemory，去重 / 待确认 / 只读策略保持不变。
// dry-run 只限制破坏性维护（合并、失真、清除），不拦新增记忆——新增本身是可审计的。
import type { Assistant } from "../../foundation/types";
import { memoryExperimentFeature } from "./gate";
import { getAuditByIdempotencyKey, openExperimentDb, recordAudit, updateAuditResult, type MemoryAuditStatus } from "./store";
import type { MemoryAssertion } from "./assertions";
import { writeAssistantMemory, type AssistantMemoryWriteResult } from "../write";

export interface MemoryIntakeResult {
  status: AssistantMemoryWriteResult["status"] | "disabled";
  scope?: "global" | "assistant";
  memoryId?: number;
  pendingId?: string;
  assertion: MemoryAssertion;
  warnings: string[];
}

function describe(assertion: MemoryAssertion): Record<string, unknown> {
  return {
    origin: assertion.origin,
    kind: assertion.kind,
    explicitRemember: assertion.explicitRemember,
    facets: assertion.facets,
    requestedScope: assertion.requestedScope,
    contentPreview: assertion.content.slice(0, 200),
    rawContentChars: assertion.rawContent?.length ?? 0,
    messageNodeId: assertion.messageNodeId,
    sourceCutMessageId: assertion.sourceCutMessageId,
  };
}

function auditStatusFor(status: MemoryIntakeResult["status"]): MemoryAuditStatus {
  switch (status) {
    case "saved":
    case "merged":
      return "applied";
    case "queued":
      return "proposed";
    case "deduped":
      return "info";
    default:
      return "failed";
  }
}

/**
 * 执行一次结构化断言写入。
 * - structuredIntake 关闭：status="disabled"，零副作用（调用方应保持旧路径）。
 * - 提供 idempotencyKey：先原子占位审计；已应用 / 排队中的同键请求返回 deduped。
 *   上次失败（failed）允许用同一个键重试。
 * - 写入异常：审计标记 failed 后原样抛出（工具层转 tool_result；HTTP 层转 500/400）。
 */
export async function runMemoryIntake(input: {
  assistant: Assistant;
  assertion: MemoryAssertion;
  context?: { conversationId?: string; conversationTitle?: string; messageNodeId?: string };
}): Promise<MemoryIntakeResult> {
  const { assistant, assertion } = input;
  if (!memoryExperimentFeature("structuredIntake")) {
    return { status: "disabled", assertion, warnings: assertion.warnings };
  }

  const db = openExperimentDb();
  const conversationId = input.context?.conversationId ?? assertion.conversationId ?? null;
  let auditId: string | null = null;
  let retryOfFailed = false;

  if (db && assertion.idempotencyKey) {
    const existing = getAuditByIdempotencyKey(db, assertion.idempotencyKey);
    if (existing && existing.status !== "failed") {
      return {
        status: "deduped",
        assertion,
        warnings: [...assertion.warnings, "idempotency key already handled"],
      };
    }
    if (existing) {
      retryOfFailed = true;
      auditId = existing.auditId;
      updateAuditResult(db, auditId, "proposed", { ...describe(assertion), retryOfFailed: true });
    } else {
      const rec = recordAudit(db, {
        action: "intake",
        status: "proposed",
        conversationId,
        idempotencyKey: assertion.idempotencyKey,
        detail: describe(assertion),
      });
      if (!rec.inserted) {
        return {
          status: "deduped",
          assertion,
          warnings: [...assertion.warnings, "idempotency key already handled"],
        };
      }
      auditId = rec.auditId;
    }
  }

  let result: AssistantMemoryWriteResult;
  try {
    result = await writeAssistantMemory({
      assistant,
      content: assertion.content,
      ...(assertion.requestedScope ? { requestedScope: assertion.requestedScope } : {}),
      source: assertion.origin === "manual" ? "manual" : "ai",
      context: input.context,
      experiment: {
        kind: assertion.kind,
        facets: assertion.facets,
        explicitRemember: assertion.explicitRemember,
        rawContent: assertion.rawContent,
        sourceCutMessageId: assertion.sourceCutMessageId,
        idempotencyKey: assertion.idempotencyKey,
        origin: assertion.origin,
      },
    });
  } catch (err) {
    if (db) {
      const detail = { ...describe(assertion), error: err instanceof Error ? err.message : String(err) };
      if (auditId) updateAuditResult(db, auditId, "failed", detail);
      else {
        recordAudit(db, {
          action: "intake",
          status: "failed",
          conversationId,
          idempotencyKey: assertion.idempotencyKey,
          detail,
        });
      }
    }
    throw err;
  }

  const intake: MemoryIntakeResult = {
    status: result.status,
    ...(result.scope ? { scope: result.scope } : {}),
    ...(result.memory ? { memoryId: result.memory.id } : {}),
    ...(result.pendingId ? { pendingId: result.pendingId } : {}),
    assertion,
    warnings: assertion.warnings,
  };

  if (db) {
    const detail = {
      ...describe(assertion),
      ...(retryOfFailed ? { retryOfFailed: true } : {}),
      resultStatus: intake.status,
      scope: intake.scope ?? null,
      memoryId: intake.memoryId ?? null,
      pendingId: intake.pendingId ?? null,
    };
    if (auditId) updateAuditResult(db, auditId, auditStatusFor(intake.status), detail);
    else {
      recordAudit(db, {
        action: "intake",
        status: auditStatusFor(intake.status),
        memoryId: intake.memoryId ?? null,
        conversationId,
        idempotencyKey: assertion.idempotencyKey,
        detail,
      });
    }
  }
  return intake;
}
