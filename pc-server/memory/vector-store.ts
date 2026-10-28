// memory/vector-store.ts — pc_memory_vector 的读写原语（同库 rikka_hub.db）
// 纪律：只做行级读写、hash、BLOB 编解码与 meta；不持有缓存、不发网络请求。
// 向量不参与 writeMemorySql 的整快照重写——记忆表格重写不会误删向量。

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getConversationsDb } from "../conversations";
import { ensureMemoryVectorTables } from "./sqlite";

export const VECTOR_META_KEYS = {
  modelKey: "memory_vector_model_key",
  dim: "memory_vector_dim",
  indexedAt: "memory_vector_indexed_at",
  lastError: "memory_vector_last_error",
} as const;

export interface StoredMemoryVector {
  memoryId: number;
  modelKey: string;
  contentHash: string;
  dim: number;
  vector: Float32Array;
  embeddedAt: number;
}

export interface VectorMeta {
  modelKey: string | null;
  dim: number | null;
  indexedAt: number | null;
  lastError: string | null;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
}

export function modelKeyOf(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Float32Array → 小端 BLOB。显式按小端写，跨平台/跨架构恢复不会读成乱码。 */
export function encodeVector(vector: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(vector.length * 4);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, Number(vector[i]) || 0, true);
  return out;
}

export function decodeVector(blob: unknown): Float32Array | null {
  const bytes = blob instanceof Uint8Array
    ? blob
    : blob instanceof ArrayBuffer
      ? new Uint8Array(blob)
      : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function openVectorDb(): Database | null {
  const db = getConversationsDb();
  if (!db) return null;
  ensureMemoryVectorTables(db);
  return db;
}

export function loadMemoryVectors(db: Database, modelKey: string): Map<number, StoredMemoryVector> {
  ensureMemoryVectorTables(db);
  const rows = db.query(
    `SELECT memory_id, model_key, content_hash, dim, vector, embedded_at
       FROM pc_memory_vector WHERE model_key = ?`,
  ).all(modelKey) as Array<{
    memory_id: number;
    model_key: string;
    content_hash: string;
    dim: number;
    vector: Uint8Array;
    embedded_at: number;
  }>;
  const map = new Map<number, StoredMemoryVector>();
  for (const row of rows) {
    const vector = decodeVector(row.vector);
    if (!vector) continue;
    map.set(Number(row.memory_id), {
      memoryId: Number(row.memory_id),
      modelKey: String(row.model_key),
      contentHash: String(row.content_hash),
      dim: Number(row.dim),
      vector,
      embeddedAt: Number(row.embedded_at),
    });
  }
  return map;
}

export interface VectorUpsertRow {
  memoryId: number;
  contentHash: string;
  vector: Float32Array;
}

/** 批量 upsert 单事务：一批要么全落，要么全不落（取消/崩溃最多丢当前批）。 */
export function upsertMemoryVectors(db: Database, modelKey: string, rows: VectorUpsertRow[]): void {
  if (rows.length === 0) return;
  ensureMemoryVectorTables(db);
  const stmt = db.prepare(
    `INSERT INTO pc_memory_vector (memory_id, model_key, content_hash, dim, vector, embedded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       model_key = excluded.model_key,
       content_hash = excluded.content_hash,
       dim = excluded.dim,
       vector = excluded.vector,
       embedded_at = excluded.embedded_at`,
  );
  const now = Date.now();
  const run = db.transaction(() => {
    for (const row of rows) {
      stmt.run(
        row.memoryId,
        modelKey,
        row.contentHash,
        row.vector.length,
        encodeVector(row.vector),
        now,
      );
    }
  });
  run();
}

export function deleteMemoryVector(db: Database, memoryId: number): void {
  ensureMemoryVectorTables(db);
  db.query("DELETE FROM pc_memory_vector WHERE memory_id = ?").run(memoryId);
}

/** 删除不再对应任何现存记忆的向量行。替换/导入/删助手后调用。返回删除行数。 */
export function pruneMemoryVectors(db: Database, validIds: ReadonlySet<number>): number {
  ensureMemoryVectorTables(db);
  const rows = db.query("SELECT memory_id FROM pc_memory_vector").all() as Array<{ memory_id: number }>;
  const stale = rows.map((row) => Number(row.memory_id)).filter((id) => !validIds.has(id));
  if (stale.length === 0) return 0;
  const stmt = db.prepare("DELETE FROM pc_memory_vector WHERE memory_id = ?");
  const run = db.transaction(() => {
    for (const id of stale) stmt.run(id);
  });
  run();
  return stale.length;
}

export function clearMemoryVectors(db: Database): void {
  ensureMemoryVectorTables(db);
  db.exec("DELETE FROM pc_memory_vector");
  const del = db.prepare("DELETE FROM pc_meta WHERE key = ?");
  const run = db.transaction(() => {
    for (const key of Object.values(VECTOR_META_KEYS)) del.run(key);
  });
  run();
}

export function readVectorMeta(db: Database): VectorMeta {
  ensureMemoryVectorTables(db);
  const rows = db.query("SELECT key, value FROM pc_meta WHERE key IN (?, ?, ?, ?)").all(
    VECTOR_META_KEYS.modelKey,
    VECTOR_META_KEYS.dim,
    VECTOR_META_KEYS.indexedAt,
    VECTOR_META_KEYS.lastError,
  ) as Array<{ key: string; value: string }>;
  const byKey = new Map(rows.map((row) => [String(row.key), String(row.value)]));
  const dim = Number(byKey.get(VECTOR_META_KEYS.dim));
  const indexedAt = Number(byKey.get(VECTOR_META_KEYS.indexedAt));
  return {
    modelKey: byKey.get(VECTOR_META_KEYS.modelKey) || null,
    dim: Number.isFinite(dim) && dim > 0 ? dim : null,
    indexedAt: Number.isFinite(indexedAt) && indexedAt > 0 ? indexedAt : null,
    lastError: byKey.get(VECTOR_META_KEYS.lastError) || null,
  };
}

export function writeVectorMeta(
  db: Database,
  patch: Partial<Record<keyof typeof VECTOR_META_KEYS, string | number | null>>,
): void {
  ensureMemoryVectorTables(db);
  const upsert = db.prepare(
    "INSERT INTO pc_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const run = db.transaction(() => {
    for (const [name, value] of Object.entries(patch)) {
      const key = VECTOR_META_KEYS[name as keyof typeof VECTOR_META_KEYS];
      if (!key) continue;
      if (value === null || value === undefined || value === "") {
        db.query("DELETE FROM pc_meta WHERE key = ?").run(key);
      } else {
        upsert.run(key, String(value));
      }
    }
  });
  run();
}
