// memory/sqlite.ts — 记忆的结构化 SQLite 存储（与对话同库 rikka_hub.db）
// 纪律：只负责建表与整快照读写，不持有内存状态、不碰 JSON 文件。
// 一条记忆一行：assistant_id 表达归属（__global__ = 全局），source / 时间戳落成真实列，
// 不再把整份记忆塞进一个 JSON 文件。pending 队列独立成表，字段与 PendingEntry 一一对应。
// 读写都走单事务：一次 persist 要么整份生效，要么整份回滚，不会留下半份记忆。

import type { Database } from "bun:sqlite";
import type { MemoryEntry, PendingEntry } from "../foundation/types";
import {
  normalizeMemoryFacets,
  withMemoryExperimentDefaults,
} from "./experiment/entry";

/** pc_meta 里的一次性迁移标记：存在即表示「库是权威源」，启动不再回读 JSON 快照。 */
export const MEMORY_SQL_MARKER_KEY = "memory_sqlite_migrated";
/** 记忆 id 计数器。独立于 max(id) 保存，删掉最大 id 后也不会复用编号。 */
export const MEMORY_NEXT_ID_KEY = "memory_next_id";

export interface MemorySqlRow extends MemoryEntry {
  /** 全局记忆写 __global__，与备份契约的 assistantId 字面量一致。 */
  assistantId: string;
}

export interface MemorySqlSnapshot {
  memories: MemorySqlRow[];
  pending: PendingEntry[];
  nextMemoryId: number;
}

export function ensureMemoryTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pc_memory (
      id           INTEGER PRIMARY KEY NOT NULL,
      assistant_id TEXT NOT NULL,
      content      TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'manual',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pc_memory_assistant ON pc_memory(assistant_id, updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS pc_memory_pending (
      pending_id         TEXT PRIMARY KEY NOT NULL,
      conversation_id    TEXT NOT NULL DEFAULT '',
      conversation_title TEXT,
      assistant_id       TEXT NOT NULL DEFAULT '',
      assistant_name     TEXT NOT NULL DEFAULT '',
      content            TEXT NOT NULL,
      proposed_at        INTEGER NOT NULL,
      message_node_id    TEXT
    );
    CREATE TABLE IF NOT EXISTS pc_memory_organize (
      conversation_id TEXT PRIMARY KEY NOT NULL,
      watermark       INTEGER NOT NULL DEFAULT 0,
      last_run_at     INTEGER,
      last_status     TEXT,
      updated_at      INTEGER NOT NULL
    );
  `);
}

/** 特性 C：一条记忆一行向量。刻意不加外键——记忆整快照重写会先 DELETE 再 INSERT，
 *  外键会在这条合法路径上拦写；一致性由 memory 写入钩子的 prune 保证。
 *  同一时刻只保留当前 embedding 模型的一套向量（主键 memory_id）。 */
/**
 * 实验「记忆与上下文」的增量 schema。幂等：老库首次读取时逐列 ALTER，不重建表。
 * 扩展列全部带默认值，未开启实验的旧数据读出来就是 unclassified + active。
 * 边表/审计表独立于整快照 DELETE+INSERT（边只在两端记忆仍存在时保留；审计是历史，永久保留）。
 */
export function ensureMemoryExperimentTables(db: Database): void {
  ensureMemoryTables(db);
  const memoryColumns = new Set(
    (db.query("PRAGMA table_info(pc_memory)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const addMemoryColumn = (name: string, ddl: string) => {
    if (!memoryColumns.has(name)) db.exec(`ALTER TABLE pc_memory ADD COLUMN ${ddl}`);
  };
  addMemoryColumn("kind", "kind TEXT NOT NULL DEFAULT 'unclassified'");
  addMemoryColumn("status", "status TEXT NOT NULL DEFAULT 'active'");
  addMemoryColumn("raw_content", "raw_content TEXT");
  addMemoryColumn("facets", "facets TEXT");
  addMemoryColumn("explicit_remember", "explicit_remember INTEGER NOT NULL DEFAULT 0");
  addMemoryColumn("mention_count", "mention_count INTEGER NOT NULL DEFAULT 0");
  addMemoryColumn("last_mentioned_at", "last_mentioned_at INTEGER");
  addMemoryColumn("mention_score", "mention_score REAL NOT NULL DEFAULT 0");
  addMemoryColumn("generation", "generation INTEGER NOT NULL DEFAULT 0");
  addMemoryColumn("distilled_at", "distilled_at INTEGER");
  addMemoryColumn("purge_after", "purge_after INTEGER");
  addMemoryColumn("source_conversation_id", "source_conversation_id TEXT");
  addMemoryColumn("source_cut_message_id", "source_cut_message_id TEXT");

  const pendingColumns = new Set(
    (db.query("PRAGMA table_info(pc_memory_pending)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const addPendingColumn = (name: string, ddl: string) => {
    if (!pendingColumns.has(name)) db.exec(`ALTER TABLE pc_memory_pending ADD COLUMN ${ddl}`);
  };
  addPendingColumn("kind", "kind TEXT NOT NULL DEFAULT 'unclassified'");
  addPendingColumn("facets", "facets TEXT");
  addPendingColumn("explicit_remember", "explicit_remember INTEGER NOT NULL DEFAULT 0");
  addPendingColumn("raw_content", "raw_content TEXT");
  addPendingColumn("source_cut_message_id", "source_cut_message_id TEXT");
  addPendingColumn("idempotency_key", "idempotency_key TEXT");
  addPendingColumn("origin", "origin TEXT NOT NULL DEFAULT 'manual'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_memory_edge (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id  INTEGER NOT NULL,
      target_id  INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      meta       TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_memory_edge_unique
      ON pc_memory_edge(source_id, target_id, kind);
    CREATE INDEX IF NOT EXISTS idx_pc_memory_edge_target ON pc_memory_edge(target_id, kind);
    CREATE TABLE IF NOT EXISTS pc_memory_audit (
      audit_id         TEXT PRIMARY KEY NOT NULL,
      at               INTEGER NOT NULL,
      action           TEXT NOT NULL,
      status           TEXT NOT NULL,
      memory_id        INTEGER,
      conversation_id  TEXT,
      idempotency_key  TEXT,
      detail           TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_memory_audit_idem
      ON pc_memory_audit(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pc_memory_audit_at ON pc_memory_audit(at DESC);
    CREATE INDEX IF NOT EXISTS idx_pc_memory_audit_status ON pc_memory_audit(status, at DESC);
  `);
}

export function ensureMemoryVectorTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pc_memory_vector (
      memory_id    INTEGER PRIMARY KEY NOT NULL,
      model_key    TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      vector       BLOB NOT NULL,
      embedded_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pc_memory_vector_model ON pc_memory_vector(model_key);
  `);
}

export function memorySqlReady(db: Database): boolean {
  const row = db.query("SELECT value FROM pc_meta WHERE key = ?").get(MEMORY_SQL_MARKER_KEY) as { value?: string } | null;
  return row?.value === "1";
}

export interface MemoryOrganizeState {
  watermark: number;
  lastRunAt: number | null;
  lastStatus: string | null;
}

/** 会话自动整理的进度水印：watermark = 已整理到的消息节点数。 */
export function readMemoryOrganizeState(db: Database, conversationId: string): MemoryOrganizeState {
  ensureMemoryTables(db);
  const row = db.query(
    "SELECT watermark, last_run_at, last_status FROM pc_memory_organize WHERE conversation_id = ?",
  ).get(conversationId) as { watermark?: number; last_run_at?: number | null; last_status?: string | null } | null;
  return {
    watermark: Math.max(0, Number(row?.watermark) || 0),
    lastRunAt: Number(row?.last_run_at) > 0 ? Number(row?.last_run_at) : null,
    lastStatus: row?.last_status ?? null,
  };
}

export function writeMemoryOrganizeState(
  db: Database,
  conversationId: string,
  patch: { watermark?: number; lastStatus?: string | null },
): void {
  ensureMemoryTables(db);
  const existing = readMemoryOrganizeState(db, conversationId);
  const watermark = patch.watermark != null ? Math.max(existing.watermark, Math.round(patch.watermark)) : existing.watermark;
  db.query(
    `INSERT INTO pc_memory_organize (conversation_id, watermark, last_run_at, last_status, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       watermark = excluded.watermark,
       last_run_at = excluded.last_run_at,
       last_status = excluded.last_status,
       updated_at = excluded.updated_at`,
  ).run(conversationId, watermark, Date.now(), patch.lastStatus ?? existing.lastStatus, Date.now());
}

/** 读整份记忆快照。库损坏/表缺失由调用方 catch 后回退 JSON 快照。 */
function parseFacets(raw: string | null): MemoryEntry["facets"] {
  if (!raw) return null;
  try {
    return normalizeMemoryFacets(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readMemorySql(db: Database): MemorySqlSnapshot {
  ensureMemoryExperimentTables(db);
  ensureMemoryVectorTables(db);
  const rows = db.query(
    `SELECT id, assistant_id, content, source, created_at, updated_at,
            kind, status, raw_content, facets, explicit_remember, mention_count,
            last_mentioned_at, mention_score, generation, distilled_at, purge_after,
            source_conversation_id, source_cut_message_id
       FROM pc_memory ORDER BY id ASC`,
  ).all() as Array<{
    id: number;
    assistant_id: string;
    content: string;
    source: string;
    created_at: number;
    updated_at: number;
    kind: string | null;
    status: string | null;
    raw_content: string | null;
    facets: string | null;
    explicit_remember: number | null;
    mention_count: number | null;
    last_mentioned_at: number | null;
    mention_score: number | null;
    generation: number | null;
    distilled_at: number | null;
    purge_after: number | null;
    source_conversation_id: string | null;
    source_cut_message_id: string | null;
  }>;
  const memories: MemorySqlRow[] = rows.map((row) => ({
    ...withMemoryExperimentDefaults({
      id: Number(row.id),
      content: String(row.content ?? ""),
      source: row.source === "ai" ? "ai" : "manual",
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      kind: row.kind as MemoryEntry["kind"],
      status: row.status as MemoryEntry["status"],
      rawContent: row.raw_content,
      facets: parseFacets(row.facets),
      explicitRemember: Number(row.explicit_remember) === 1,
      mentionCount: Number(row.mention_count) || 0,
      lastMentionedAt: row.last_mentioned_at,
      mentionScore: Number(row.mention_score) || 0,
      generation: Number(row.generation) || 0,
      distilledAt: row.distilled_at,
      purgeAfter: row.purge_after,
      sourceConversationId: row.source_conversation_id,
      sourceCutMessageId: row.source_cut_message_id,
    }),
    assistantId: String(row.assistant_id),
  }));

  const pendingRows = db.query(
    `SELECT pending_id, conversation_id, conversation_title, assistant_id, assistant_name,
            content, proposed_at, message_node_id, kind, facets, explicit_remember,
            raw_content, source_cut_message_id, idempotency_key, origin
       FROM pc_memory_pending ORDER BY proposed_at ASC`,
  ).all() as Array<{
    pending_id: string;
    conversation_id: string;
    conversation_title: string | null;
    assistant_id: string;
    assistant_name: string;
    content: string;
    proposed_at: number;
    message_node_id: string | null;
    kind: string | null;
    facets: string | null;
    explicit_remember: number | null;
    raw_content: string | null;
    source_cut_message_id: string | null;
    idempotency_key: string | null;
    origin: string | null;
  }>;
  // 兼容纪律：pending 的旧契约字段保持不变；实验扩展只在**非默认值**时出现，
  // 这样未开启实验的队列读出来与引入前逐字节一致。
  const pending: PendingEntry[] = pendingRows.map((row) => {
    const kind = row.kind as PendingEntry["kind"];
    const facets = parseFacets(row.facets);
    const explicitRemember = Number(row.explicit_remember) === 1;
    const origin = row.origin === "compaction" || row.origin === "tool" ? row.origin : "manual";
    return {
      pendingId: String(row.pending_id),
      conversationId: String(row.conversation_id ?? ""),
      ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
      assistantId: String(row.assistant_id ?? ""),
      assistantName: String(row.assistant_name ?? ""),
      content: String(row.content ?? ""),
      proposedAt: Number(row.proposed_at),
      ...(row.message_node_id ? { messageNodeId: row.message_node_id } : {}),
      ...(kind && kind !== "unclassified" ? { kind } : {}),
      ...(facets ? { facets } : {}),
      ...(explicitRemember ? { explicitRemember: true } : {}),
      ...(row.raw_content ? { rawContent: row.raw_content } : {}),
      ...(row.source_cut_message_id ? { sourceCutMessageId: row.source_cut_message_id } : {}),
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
      ...(origin !== "manual" ? { origin } : {}),
    };
  });

  const counter = db.query("SELECT value FROM pc_meta WHERE key = ?").get(MEMORY_NEXT_ID_KEY) as { value?: string } | null;
  const maxId = memories.reduce((max, item) => Math.max(max, item.id), 0);
  const nextMemoryId = Math.max(Number(counter?.value) || 0, maxId + 1);

  return { memories, pending, nextMemoryId };
}

/** 整份覆盖写入（单事务）。markMigrated=true 时同时写下「库为权威源」标记。 */
export function writeMemorySql(
  db: Database,
  snapshot: MemorySqlSnapshot,
  markMigrated = false,
): void {
  ensureMemoryExperimentTables(db);
  const insertMemory = db.prepare(
    `INSERT INTO pc_memory
       (id, assistant_id, content, source, created_at, updated_at,
        kind, status, raw_content, facets, explicit_remember, mention_count,
        last_mentioned_at, mention_score, generation, distilled_at, purge_after,
        source_conversation_id, source_cut_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPending = db.prepare(
    `INSERT INTO pc_memory_pending
       (pending_id, conversation_id, conversation_title, assistant_id, assistant_name, content, proposed_at, message_node_id,
        kind, facets, explicit_remember, raw_content, source_cut_message_id, idempotency_key, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    "INSERT INTO pc_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  const run = db.transaction(() => {
    db.exec("DELETE FROM pc_memory");
    for (const memory of snapshot.memories) {
      const normalized = withMemoryExperimentDefaults(memory);
      insertMemory.run(
        normalized.id,
        memory.assistantId,
        normalized.content,
        normalized.source,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.kind ?? "unclassified",
        normalized.status ?? "active",
        normalized.rawContent ?? null,
        normalized.facets ? JSON.stringify(normalized.facets) : null,
        normalized.explicitRemember ? 1 : 0,
        normalized.mentionCount ?? 0,
        normalized.lastMentionedAt ?? null,
        normalized.mentionScore ?? 0,
        normalized.generation ?? 0,
        normalized.distilledAt ?? null,
        normalized.purgeAfter ?? null,
        normalized.sourceConversationId ?? null,
        normalized.sourceCutMessageId ?? null,
      );
    }
    db.exec("DELETE FROM pc_memory_pending");
    for (const entry of snapshot.pending) {
      insertPending.run(
        entry.pendingId,
        entry.conversationId,
        entry.conversationTitle ?? null,
        entry.assistantId,
        entry.assistantName,
        entry.content,
        entry.proposedAt,
        entry.messageNodeId ?? null,
        entry.kind ?? "unclassified",
        entry.facets ? JSON.stringify(entry.facets) : null,
        entry.explicitRemember ? 1 : 0,
        entry.rawContent ?? null,
        entry.sourceCutMessageId ?? null,
        entry.idempotencyKey ?? null,
        entry.origin ?? "manual",
      );
    }
    // 整快照重建后，指向已删除记忆的边不再有意义；审计是历史记录，不随记忆删除。
    db.exec(`DELETE FROM pc_memory_edge
             WHERE source_id NOT IN (SELECT id FROM pc_memory)
                OR target_id NOT IN (SELECT id FROM pc_memory)`);
    upsertMeta.run(MEMORY_NEXT_ID_KEY, String(snapshot.nextMemoryId));
    if (markMigrated) upsertMeta.run(MEMORY_SQL_MARKER_KEY, "1");
  });
  run();
}
