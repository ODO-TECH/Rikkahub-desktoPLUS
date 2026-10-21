// memory/sqlite.ts — 记忆的结构化 SQLite 存储（与对话同库 rikka_hub.db）
// 纪律：只负责建表与整快照读写，不持有内存状态、不碰 JSON 文件。
// 一条记忆一行：assistant_id 表达归属（__global__ = 全局），source / 时间戳落成真实列，
// 不再把整份记忆塞进一个 JSON 文件。pending 队列独立成表，字段与 PendingEntry 一一对应。
// 读写都走单事务：一次 persist 要么整份生效，要么整份回滚，不会留下半份记忆。

import type { Database } from "bun:sqlite";
import type { MemoryEntry, PendingEntry } from "../foundation/types";

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
  `);
}

export function memorySqlReady(db: Database): boolean {
  const row = db.query("SELECT value FROM pc_meta WHERE key = ?").get(MEMORY_SQL_MARKER_KEY) as { value?: string } | null;
  return row?.value === "1";
}

/** 读整份记忆快照。库损坏/表缺失由调用方 catch 后回退 JSON 快照。 */
export function readMemorySql(db: Database): MemorySqlSnapshot {
  ensureMemoryTables(db);
  const rows = db.query(
    "SELECT id, assistant_id, content, source, created_at, updated_at FROM pc_memory ORDER BY id ASC",
  ).all() as Array<{
    id: number;
    assistant_id: string;
    content: string;
    source: string;
    created_at: number;
    updated_at: number;
  }>;
  const memories: MemorySqlRow[] = rows.map((row) => ({
    id: Number(row.id),
    assistantId: String(row.assistant_id),
    content: String(row.content ?? ""),
    source: row.source === "ai" ? "ai" : "manual",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));

  const pendingRows = db.query(
    `SELECT pending_id, conversation_id, conversation_title, assistant_id, assistant_name,
            content, proposed_at, message_node_id
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
  }>;
  const pending: PendingEntry[] = pendingRows.map((row) => ({
    pendingId: String(row.pending_id),
    conversationId: String(row.conversation_id ?? ""),
    ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
    assistantId: String(row.assistant_id ?? ""),
    assistantName: String(row.assistant_name ?? ""),
    content: String(row.content ?? ""),
    proposedAt: Number(row.proposed_at),
    ...(row.message_node_id ? { messageNodeId: row.message_node_id } : {}),
  }));

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
  ensureMemoryTables(db);
  const insertMemory = db.prepare(
    `INSERT INTO pc_memory (id, assistant_id, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPending = db.prepare(
    `INSERT INTO pc_memory_pending
       (pending_id, conversation_id, conversation_title, assistant_id, assistant_name, content, proposed_at, message_node_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    "INSERT INTO pc_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  const run = db.transaction(() => {
    db.exec("DELETE FROM pc_memory");
    for (const memory of snapshot.memories) {
      insertMemory.run(
        memory.id,
        memory.assistantId,
        memory.content,
        memory.source,
        memory.createdAt,
        memory.updatedAt,
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
      );
    }
    upsertMeta.run(MEMORY_NEXT_ID_KEY, String(snapshot.nextMemoryId));
    if (markMigrated) upsertMeta.run(MEMORY_SQL_MARKER_KEY, "1");
  });
  run();
}
