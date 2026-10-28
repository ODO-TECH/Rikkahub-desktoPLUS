// 第一轮合并的执行与拒绝。
// 执行只改状态与内容，不物理删除：覆盖源 → superseded，合并源 → archived，完成提醒 → tombstone。
// 原文保留在 rawContent；边与审计留下可追溯链；向量立即失效，目标内容变化交索引队列重建。
import { memoryStore } from "../index";
import { isProtectedMemory, normalizeMemoryStatus } from "./entry";
import { memoryExperimentFeature, memoryExperimentMutates } from "./gate";
import type { MergeProposal } from "./merge-plan";
import {
  getAudit,
  openExperimentDb,
  recordAudit,
  recordMemoryEdge,
  updateAuditResult,
} from "./store";

export interface MergeApplyResult {
  auditId: string;
  op: MergeProposal["op"];
  targetId: number;
  statusChanged: Array<{ id: number; status: string }>;
  edges: number;
}

function parseProposal(detail: Record<string, unknown>): MergeProposal {
  const op = detail.op;
  if (op !== "overwrite" && op !== "complete" && op !== "merge") throw new Error("无效的合并提案类型");
  const targetId = Number(detail.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new Error("合并提案缺少目标记忆");
  const deleteIds = Array.isArray(detail.deleteIds)
    ? detail.deleteIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const sourceIds = Array.isArray(detail.sourceIds)
    ? detail.sourceIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return {
    op,
    targetId,
    deleteIds,
    sourceIds,
    content: String(detail.content ?? ""),
    reason: String(detail.reason ?? ""),
    confidence: Number(detail.confidence) || 0,
    scopeKey: String(detail.scopeKey ?? ""),
    scopeLabel: String(detail.scopeLabel ?? ""),
    protectedIds: Array.isArray(detail.protectedIds) ? detail.protectedIds.map(Number) : [],
    involved: Array.isArray(detail.involved) ? detail.involved as MergeProposal["involved"] : [],
    key: String(detail.key ?? ""),
  };
}

function scopeKeyOf(memoryId: number): string | null {
  const scope = memoryStore.scopeOfMemory(memoryId);
  if (!scope) return null;
  return "assistantId" in scope ? `assistant:${scope.assistantId}` : "global";
}

function statusFor(op: MergeProposal["op"]): "superseded" | "archived" | "tombstone" {
  if (op === "overwrite") return "superseded";
  if (op === "merge") return "archived";
  return "tombstone";
}

/**
 * 执行一条已批准的合并提案。
 * 守卫：mergeProposals 开启、非试运行、提案仍为 proposed、目标与删除项都存在且同作用域。
 */
export function applyMergeProposal(auditId: string): MergeApplyResult {
  if (!memoryExperimentFeature("mergeProposals")) throw new Error("第一轮合并提案未开启");
  if (!memoryExperimentMutates()) throw new Error("试运行中只能生成提案，关闭试运行后才能执行");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");

  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "merge_plan") throw new Error("合并提案不存在");
  if (audit.status !== "proposed") throw new Error(`提案当前状态为 ${audit.status}，不能执行`);
  const proposal = parseProposal(audit.detail);

  const target = memoryStore.findEntryById(proposal.targetId);
  if (!target) throw new Error(`目标记忆 #${proposal.targetId} 不存在`);
  if (normalizeMemoryStatus(target.status) !== "active") throw new Error("目标记忆已不是有效状态，提案已过期");
  const targetScope = scopeKeyOf(proposal.targetId);
  if (!targetScope) throw new Error("无法确认目标记忆的作用域");
  if (proposal.scopeKey && proposal.scopeKey !== targetScope) {
    throw new Error("提案作用域与当前记忆不一致");
  }
  for (const id of proposal.deleteIds) {
    const entry = memoryStore.findEntryById(id);
    if (!entry) throw new Error(`待处理记忆 #${id} 不存在`);
    if (normalizeMemoryStatus(entry.status) !== "active") throw new Error(`记忆 #${id} 已不是有效状态，提案已过期`);
    const scope = scopeKeyOf(id);
    if (scope !== targetScope) throw new Error(`记忆 #${id} 与目标不在同一作用域`);
  }
  if (proposal.op === "complete") {
    for (const id of proposal.deleteIds) {
      const entry = memoryStore.findEntryById(id);
      if (entry && isProtectedMemory(entry)) throw new Error(`记忆 #${id} 受保护，不能按完成提醒删除`);
    }
  }

  const status = statusFor(proposal.op);
  const statusChanged: Array<{ id: number; status: string }> = [];
  let edges = 0;

  // 合并 / 覆盖：目标内容以提案为准，旧内容先落到 rawContent（仅当还没有原文时）。
  if ((proposal.op === "merge" || proposal.op === "overwrite")
    && proposal.content.trim()
    && proposal.content.trim() !== target.content) {
    memoryStore.updateMemory(target.id, proposal.content, "ai", {
      ...(proposal.op === "merge" && target.rawContent == null ? { rawContent: target.content } : {}),
    });
  }

  // 摘要重写继承提及分数：取参与条目的最大值，不求和——同一条事实的多次改写
  // 不应把计数叠成虚高。目标自身被墓碑化（单条完成提醒）时不继承。
  if (proposal.op !== "complete" || !proposal.deleteIds.includes(target.id)) {
    const involved = [target, ...proposal.deleteIds
      .map((id) => memoryStore.findEntryById(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)];
    const inheritedCount = Math.max(...involved.map((entry) => Math.max(0, Number(entry.mentionCount) || 0)));
    const inheritedScore = Math.max(...involved.map((entry) => Number(entry.mentionScore) || 0));
    const inheritedLast = Math.max(...involved.map((entry) => Number(entry.lastMentionedAt) || 0));
    if (
      inheritedCount > Math.max(0, Number(target.mentionCount) || 0)
      || inheritedScore > (Number(target.mentionScore) || 0)
      || inheritedLast > (Number(target.lastMentionedAt) || 0)
    ) {
      memoryStore.recordMemoryMention(target.id, {
        mentionCount: inheritedCount,
        lastMentionedAt: inheritedLast,
        mentionScore: inheritedScore,
      }, false);
    }
  }

  for (const id of proposal.deleteIds) {
    if (id === target.id) {
      // 单条已完成提醒：目标自身墓碑化。
      statusChanged.push({ id, status });
      continue;
    }
    statusChanged.push({ id, status });
    recordMemoryEdge(db, {
      sourceId: id,
      targetId: target.id,
      kind: proposal.op === "overwrite" ? "supersedes" : "merged_into",
      meta: { reason: proposal.reason, auditId, op: proposal.op },
    });
    edges += 1;
  }
  // 状态离开 active 时由 setMemoryStatuses 统一删除向量；目标内容变化在
  // updateMemory 内立即作废旧向量，随后 autoIndex 按 memory_id 重嵌。
  memoryStore.setMemoryStatuses(statusChanged.map((item) => ({ id: item.id, status: normalizeMemoryStatus(item.status) })), false);
  void memoryStore.persistAll();

  const appliedAt = Date.now();
  updateAuditResult(db, auditId, "applied", {
    appliedAt,
    applied: {
      op: proposal.op,
      targetId: proposal.targetId,
      statusChanged,
      edges,
    },
  });
  recordAudit(db, {
    action: "merge_apply",
    status: "applied",
    memoryId: proposal.targetId,
    idempotencyKey: `${auditId}:apply`,
    detail: { auditId, op: proposal.op, targetId: proposal.targetId, statusChanged, edges, reason: proposal.reason },
  });

  return { auditId, op: proposal.op, targetId: proposal.targetId, statusChanged, edges };
}

/** 拒绝提案：只改审计状态，保留记忆原样；试运行中也可拒绝（安全操作）。 */
export function rejectMergeProposal(auditId: string): { auditId: string; status: "rejected" } {
  if (!memoryExperimentFeature("mergeProposals")) throw new Error("第一轮合并提案未开启");
  const db = openExperimentDb();
  if (!db) throw new Error("数据库尚未就绪");
  const audit = getAudit(db, auditId);
  if (!audit || audit.action !== "merge_plan") throw new Error("合并提案不存在");
  if (audit.status !== "proposed") throw new Error(`提案当前状态为 ${audit.status}，不能拒绝`);
  updateAuditResult(db, auditId, "rejected", { rejectedAt: Date.now() });
  recordAudit(db, {
    action: "merge_reject",
    status: "info",
    memoryId: audit.memoryId ?? null,
    idempotencyKey: `${auditId}:reject`,
    detail: { auditId, reason: audit.detail.reason ?? "" },
  });
  return { auditId, status: "rejected" };
}
