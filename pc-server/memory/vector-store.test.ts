// memory/vector-store.test.ts — 特性 C 向量行原语的行为锁。
// 纪律：Float32 小端 BLOB 可跨平台回读；向量不随记忆表格整快照重写；删记忆/替换后不留孤儿行。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureMemoryTables, ensureMemoryVectorTables } from "./sqlite";
import {
  VECTOR_META_KEYS,
  clearMemoryVectors,
  contentHash,
  decodeVector,
  deleteMemoryVector,
  encodeVector,
  loadMemoryVectors,
  modelKeyOf,
  pruneMemoryVectors,
  readVectorMeta,
  upsertMemoryVectors,
  writeVectorMeta,
} from "./vector-store";

function memoryDb(): Database {
  const db = new Database(":memory:");
  ensureMemoryTables(db);
  ensureMemoryVectorTables(db);
  return db;
}

describe("hash 与模型键", () => {
  test("contentHash 稳定、取前 32 位十六进制", () => {
    const hash = contentHash("用户喜欢简洁回复");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(contentHash("用户喜欢简洁回复")).toBe(hash);
    expect(contentHash("用户喜欢简洁回复。")).not.toBe(hash);
  });

  test("modelKey 由 provider::model 组成,不同模型不同键", () => {
    expect(modelKeyOf("p1", "text-embedding-3-small")).toBe("p1::text-embedding-3-small");
    expect(modelKeyOf("p1", "bge-m3")).not.toBe(modelKeyOf("p1", "text-embedding-3-small"));
  });
});

describe("Float32 BLOB 编解码", () => {
  test("往返保留数值(含负数与小数)", () => {
    const input = [1, -2.5, 0.125, 0];
    const decoded = decodeVector(encodeVector(input));
    expect(decoded).not.toBeNull();
    expect([...decoded!]).toEqual(input);
  });

  test("显式小端:1.0 的首字节为 0x00、末字节为 0x3F", () => {
    const bytes = encodeVector([1]);
    expect([...bytes]).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });

  test("非法 BLOB 返回 null(空、长度不整除 4、非字节输入)", () => {
    expect(decodeVector(new Uint8Array())).toBeNull();
    expect(decodeVector(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeVector(undefined)).toBeNull();
    expect(decodeVector([1, 2, 3, 4])).toBeNull();
  });

  test("ArrayBuffer 也接受", () => {
    const bytes = encodeVector([0.5, -0.5]);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect([...decodeVector(buffer)!]).toEqual([0.5, -0.5]);
  });

  test("NaN/非数值按 0 写入,不产生脏位", () => {
    expect([...decodeVector(encodeVector([Number.NaN, "x" as unknown as number, 2]))!]).toEqual([0, 0, 2]);
  });
});

describe("行级读写", () => {
  test("批量 upsert 后按模型加载;不同模型的向量互不串", () => {
    const db = memoryDb();
    upsertMemoryVectors(db, "p::a", [
      { memoryId: 1, contentHash: contentHash("一"), vector: Float32Array.from([1, 0]) },
      { memoryId: 2, contentHash: contentHash("二"), vector: Float32Array.from([0, 1]) },
    ]);
    upsertMemoryVectors(db, "p::b", [
      { memoryId: 3, contentHash: contentHash("三"), vector: Float32Array.from([0.5, 0.5]) },
    ]);

    const a = loadMemoryVectors(db, "p::a");
    expect([...a.keys()].sort()).toEqual([1, 2]);
    expect([...a.get(1)!.vector]).toEqual([1, 0]);
    expect(a.get(1)!.modelKey).toBe("p::a");
    expect(a.get(1)!.contentHash).toBe(contentHash("一"));
    expect(a.get(1)!.dim).toBe(2);
    expect(typeof a.get(1)!.embeddedAt).toBe("number");

    const b = loadMemoryVectors(db, "p::b");
    expect([...b.keys()]).toEqual([3]);
  });

  test("同 id 再次 upsert 覆盖内容与模型(换模型即失效)", () => {
    const db = memoryDb();
    upsertMemoryVectors(db, "p::a", [{ memoryId: 1, contentHash: "old", vector: Float32Array.from([1]) }]);
    upsertMemoryVectors(db, "p::b", [{ memoryId: 1, contentHash: "new", vector: Float32Array.from([0, 1]) }]);
    expect(loadMemoryVectors(db, "p::a").size).toBe(0);
    const b = loadMemoryVectors(db, "p::b").get(1)!;
    expect(b.contentHash).toBe("new");
    expect([...b.vector]).toEqual([0, 1]);
  });

  test("prune 只删不再存在的记忆,保留有效行", () => {
    const db = memoryDb();
    upsertMemoryVectors(db, "p::a", [
      { memoryId: 1, contentHash: "a", vector: Float32Array.from([1]) },
      { memoryId: 2, contentHash: "b", vector: Float32Array.from([2]) },
      { memoryId: 3, contentHash: "c", vector: Float32Array.from([3]) },
    ]);
    expect(pruneMemoryVectors(db, new Set([1, 3]))).toBe(1);
    expect([...loadMemoryVectors(db, "p::a").keys()].sort()).toEqual([1, 3]);
    expect(pruneMemoryVectors(db, new Set([1, 3]))).toBe(0);
  });

  test("单条删除后其他行不受影响", () => {
    const db = memoryDb();
    upsertMemoryVectors(db, "p::a", [
      { memoryId: 1, contentHash: "a", vector: Float32Array.from([1]) },
      { memoryId: 2, contentHash: "b", vector: Float32Array.from([2]) },
    ]);
    deleteMemoryVector(db, 2);
    expect([...loadMemoryVectors(db, "p::a").keys()]).toEqual([1]);
  });
});

describe("meta 与清空", () => {
  test("meta 写入/读取/清除", () => {
    const db = memoryDb();
    expect(readVectorMeta(db)).toEqual({ modelKey: null, dim: null, indexedAt: null, lastError: null });

    writeVectorMeta(db, { modelKey: "p::a", dim: 1024, indexedAt: 123, lastError: "boom" });
    expect(readVectorMeta(db)).toEqual({ modelKey: "p::a", dim: 1024, indexedAt: 123, lastError: "boom" });

    writeVectorMeta(db, { lastError: null, indexedAt: null });
    expect(readVectorMeta(db)).toEqual({ modelKey: "p::a", dim: 1024, indexedAt: null, lastError: null });
  });

  test("非法 meta 数值读取为 null", () => {
    const db = memoryDb();
    writeVectorMeta(db, { dim: 0, indexedAt: -1 });
    expect(readVectorMeta(db).dim).toBeNull();
    expect(readVectorMeta(db).indexedAt).toBeNull();
  });

  test("clear 同时清向量行与 meta", () => {
    const db = memoryDb();
    upsertMemoryVectors(db, "p::a", [{ memoryId: 1, contentHash: "a", vector: Float32Array.from([1]) }]);
    writeVectorMeta(db, { modelKey: "p::a", dim: 1, indexedAt: 1 });
    clearMemoryVectors(db);
    expect(loadMemoryVectors(db, "p::a").size).toBe(0);
    expect(readVectorMeta(db)).toEqual({ modelKey: null, dim: null, indexedAt: null, lastError: null });
    // 四个 meta 键都被删干净
    const rows = db.query("SELECT key FROM pc_meta WHERE key IN (?, ?, ?, ?)").all(
      VECTOR_META_KEYS.modelKey,
      VECTOR_META_KEYS.dim,
      VECTOR_META_KEYS.indexedAt,
      VECTOR_META_KEYS.lastError,
    );
    expect(rows).toEqual([]);
  });
});
