// 实验数据的外挂存储原语：记忆边（supersedes / merged_into / related）与审计。
// 只做行级读写；不持有内存状态，不发网络请求。记忆整快照重写不会清掉审计；
// 指向已删除记忆的边由 writeMemorySql 的孤儿清理统一收口。
import type { Database } from "bun:sqlite";
import { getConversationsDb } from "../../conversations";
import { ensureMemoryExperimentTables } from "../sqlite";

export type MemoryEdgeKind = "supersedes" | "merged_into" | "related";

export interface MemoryEdge {
  id: number;
  sourceId: number;
  targetId: number;
  kind: MemoryEdgeKind;
  createdAt: number;
  meta: Record<string, unknown>;
}

export type MemoryAuditAction =
  | "merge_plan"
  | "merge_apply"
  | "merge_reject"
  | "distill_plan"
  | "distill_apply"
  | "purge"
  | "tombstone"
  | "restore"
  | "compaction_candidates"
  | "mention"
  | "promotion"
  | "intake";

export type MemoryAuditStatus = "proposed" | "applied" | "rejected" | "failed" | "info";

export interface MemoryAuditEntry {
  auditId: string;
  at: number;
  action: MemoryAuditAction;
  status: MemoryAuditStatus;
  memoryId: number | null;
  conversationId: string | null;
  idempotencyKey: string | null;
  detail: Record<string, unknown>;
}

export function openExperimentDb(): Database | null {
  const db = getConversationsDb();
  if (!db) return null;
  ensureMemoryExperimentTables(db);
  return db;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function recordMemoryEdge(
  db: Database,
  edge: { sourceId: number; targetId: number; kind: MemoryEdgeKind; meta?: Record<string, unknown> },
): void {
  ensureMemoryExperimentTables(db);
  db.query(
    `INSERT INTO pc_memory_edge (source_id, target_id, kind, created_at, meta)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_id, target_id, kind) DO UPDATE SET meta = excluded.meta`,
  ).run(
    edge.sourceId,
    edge.targetId,
    edge.kind,
    Date.now(),
    JSON.stringify(edge.meta ?? {}),
  );
}

export function listMemoryEdges(
  db: Database,
  options: { targetId?: number; sourceId?: number; kind?: MemoryEdgeKind } = {},
): MemoryEdge[] {
  ensureMemoryExperimentTables(db);
  const clauses: string[] = [];
  const args: Array<number | string> = [];
  if (options.targetId != null) { clauses.push("target_id = ?"); args.push(options.targetId); }
  if (options.sourceId != null) { clauses.push("source_id = ?"); args.push(options.sourceId); }
  if (options.kind) { clauses.push("kind = ?"); args.push(options.kind); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(
    `SELECT id, source_id, target_id, kind, created_at, meta
       FROM pc_memory_edge ${where} ORDER BY id ASC`,
  ).all(...args) as Array<{
    id: number;
    source_id: number;
    target_id: number;
    kind: string;
    created_at: number;
    meta: string | null;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    sourceId: Number(row.source_id),
    targetId: Number(row.target_id),
    kind: row.kind as MemoryEdgeKind,
    createdAt: Number(row.created_at),
    meta: parseMeta(row.meta),
  }));
}

export function deleteMemoryEdgesForMemory(db: Database, memoryId: number): void {
  ensureMemoryExperimentTables(db);
  db.query("DELETE FROM pc_memory_edge WHERE source_id = ? OR target_id = ?").run(memoryId, memoryId);
}

/** 撤销一次维护执行时，删除该次执行写入的边（meta.auditId 标记）。
 *  只扫 supersedes / merged_into——related 是独立召回关系，不随一次执行回滚。 */
export function deleteMemoryEdgesByAudit(db: Database, auditId: string): number {
  ensureMemoryExperimentTables(db);
  const rows = db.query(
    "SELECT id, meta FROM pc_memory_edge WHERE kind IN ('supersedes', 'merged_into')",
  ).all() as Array<{ id: number; meta: string | null }>;
  const remove = db.prepare("DELETE FROM pc_memory_edge WHERE id = ?");
  let deleted = 0;
  for (const row of rows) {
    if (String(parseMeta(row.meta).auditId ?? "") !== auditId) continue;
    deleted += remove.run(row.id).changes;
  }
  return deleted;
}

/**
 * 写审计。提供 idempotencyKey 时重复写入被忽略（同一段压缩、同一个提案只记一次）。
 * 返回 auditId 与是否真正插入——调用方据此做幂等占位、随后 updateAuditResult 收尾。
 */
export function recordAudit(
  db: Database,
  entry: {
    action: MemoryAuditAction;
    status: MemoryAuditStatus;
    memoryId?: number | null;
    conversationId?: string | null;
    idempotencyKey?: string | null;
    detail?: Record<string, unknown>;
  },
): { inserted: boolean; auditId: string } {
  ensureMemoryExperimentTables(db);
  const auditId = `a-${crypto.randomUUID()}`;
  const result = db.query(
    `INSERT OR IGNORE INTO pc_memory_audit
       (audit_id, at, action, status, memory_id, conversation_id, idempotency_key, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    auditId,
    Date.now(),
    entry.action,
    entry.status,
    entry.memoryId ?? null,
    entry.conversationId ?? null,
    entry.idempotencyKey ?? null,
    JSON.stringify(entry.detail ?? {}),
  );
  return { inserted: result.changes > 0, auditId };
}

/** 收尾一条已占位的审计：更新状态并把结果字段合并进 detail。 */
export function updateAuditResult(
  db: Database,
  auditId: string,
  status: MemoryAuditStatus,
  detailPatch: Record<string, unknown> = {},
): boolean {
  ensureMemoryExperimentTables(db);
  const row = db.query("SELECT detail FROM pc_memory_audit WHERE audit_id = ?").get(auditId) as { detail: string | null } | null;
  if (!row) return false;
  const detail = { ...parseMeta(row.detail), ...detailPatch };
  return db.query(
    "UPDATE pc_memory_audit SET status = ?, detail = ? WHERE audit_id = ?",
  ).run(status, JSON.stringify(detail), auditId).changes > 0;
}

/** 直接替换审计 detail（不改状态）。到期清除时用它抹掉审计里保留的原文。 */
export function updateAuditDetail(db: Database, auditId: string, detail: Record<string, unknown>): boolean {
  ensureMemoryExperimentTables(db);
  return db.query(
    "UPDATE pc_memory_audit SET detail = ? WHERE audit_id = ?",
  ).run(JSON.stringify(detail), auditId).changes > 0;
}

export function getAudit(db: Database, auditId: string): MemoryAuditEntry | null {
  ensureMemoryExperimentTables(db);
  const row = db.query(
    `SELECT audit_id, at, action, status, memory_id, conversation_id, idempotency_key, detail
       FROM pc_memory_audit WHERE audit_id = ? LIMIT 1`,
  ).get(auditId) as {
    audit_id: string;
    at: number;
    action: string;
    status: string;
    memory_id: number | null;
    conversation_id: string | null;
    idempotency_key: string | null;
    detail: string | null;
  } | null;
  if (!row) return null;
  return {
    auditId: String(row.audit_id),
    at: Number(row.at),
    action: row.action as MemoryAuditAction,
    status: row.status as MemoryAuditStatus,
    memoryId: row.memory_id == null ? null : Number(row.memory_id),
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    detail: parseMeta(row.detail),
  };
}

export function getAuditByIdempotencyKey(db: Database, idempotencyKey: string): MemoryAuditEntry | null {
  ensureMemoryExperimentTables(db);
  const row = db.query(
    `SELECT audit_id, at, action, status, memory_id, conversation_id, idempotency_key, detail
       FROM pc_memory_audit WHERE idempotency_key = ? LIMIT 1`,
  ).get(idempotencyKey) as {
    audit_id: string;
    at: number;
    action: string;
    status: string;
    memory_id: number | null;
    conversation_id: string | null;
    idempotency_key: string | null;
    detail: string | null;
  } | null;
  if (!row) return null;
  return {
    auditId: String(row.audit_id),
    at: Number(row.at),
    action: row.action as MemoryAuditAction,
    status: row.status as MemoryAuditStatus,
    memoryId: row.memory_id == null ? null : Number(row.memory_id),
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    detail: parseMeta(row.detail),
  };
}

export function listAudit(
  db: Database,
  options: { limit?: number; status?: MemoryAuditStatus; action?: MemoryAuditAction; memoryId?: number } = {},
): MemoryAuditEntry[] {
  ensureMemoryExperimentTables(db);
  const clauses: string[] = [];
  const args: Array<number | string> = [];
  if (options.status) { clauses.push("status = ?"); args.push(options.status); }
  if (options.action) { clauses.push("action = ?"); args.push(options.action); }
  if (options.memoryId != null) { clauses.push("memory_id = ?"); args.push(options.memoryId); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, Math.round(options.limit ?? 100)));
  const rows = db.query(
    `SELECT audit_id, at, action, status, memory_id, conversation_id, idempotency_key, detail
       FROM pc_memory_audit ${where} ORDER BY at DESC, audit_id DESC LIMIT ${limit}`,
  ).all(...args) as Array<{
    audit_id: string;
    at: number;
    action: string;
    status: string;
    memory_id: number | null;
    conversation_id: string | null;
    idempotency_key: string | null;
    detail: string | null;
  }>;
  return rows.map((row) => ({
    auditId: String(row.audit_id),
    at: Number(row.at),
    action: row.action as MemoryAuditAction,
    status: row.status as MemoryAuditStatus,
    memoryId: row.memory_id == null ? null : Number(row.memory_id),
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    detail: parseMeta(row.detail),
  }));
}

export function updateAuditStatus(db: Database, auditId: string, status: MemoryAuditStatus): boolean {
  ensureMemoryExperimentTables(db);
  return db.query("UPDATE pc_memory_audit SET status = ? WHERE audit_id = ?").run(status, auditId).changes > 0;
}

/** 保留最近 90 天审计；由维护任务调用。 */
export function pruneAudit(db: Database, keepDays = 90): number {
  ensureMemoryExperimentTables(db);
  const cutoff = Date.now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
  return db.query("DELETE FROM pc_memory_audit WHERE at < ?").run(cutoff).changes;
}
