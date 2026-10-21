// memory/sqlite.test.ts — 记忆结构化存储的行为锁。
// 纪律：一条记忆一行；全局归属写 __global__；整份写入单事务；迁移标记决定启动读库还是读 JSON。
// 注：memoryStore 与活库的接线在独立子进程里跑（scripts/memory-sql-migration-smoke.ts），
// 避免 bun test 多文件共享 paths 模块缓存、互相污染数据目录。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureMemoryTables, memorySqlReady, readMemorySql, writeMemorySql } from "./sqlite";

describe("pc_memory 表：结构化读写", () => {
  test("全局与助手记忆落成独立行，顺序与来源保留", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemorySql(db, {
      memories: [
        { id: 1, assistantId: "__global__", content: "全局偏好", source: "manual", createdAt: 10, updatedAt: 11 },
        { id: 2, assistantId: "a1", content: "常用 Python", source: "ai", createdAt: 12, updatedAt: 13 },
      ],
      pending: [
        { pendingId: "p-1", conversationId: "c1", assistantId: "a1", assistantName: "助手", content: "待确认", proposedAt: 14 },
      ],
      nextMemoryId: 3,
    }, true);

    expect(memorySqlReady(db)).toBe(true);
    const snapshot = readMemorySql(db);
    expect(snapshot.memories.map((m) => [m.id, m.assistantId, m.content, m.source])).toEqual([
      [1, "__global__", "全局偏好", "manual"],
      [2, "a1", "常用 Python", "ai"],
    ]);
    expect(snapshot.pending).toEqual([
      { pendingId: "p-1", conversationId: "c1", assistantId: "a1", assistantName: "助手", content: "待确认", proposedAt: 14 },
    ]);
    expect(snapshot.nextMemoryId).toBe(3);
  });

  test("整份覆盖是单事务：写入失败不留半份数据", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemorySql(db, {
      memories: [{ id: 1, assistantId: "__global__", content: "旧", source: "manual", createdAt: 1, updatedAt: 1 }],
      pending: [],
      nextMemoryId: 2,
    }, true);
    // 重复主键触发约束错误，事务整体回滚 —— 旧快照必须原样保留。
    expect(() => writeMemorySql(db, {
      memories: [
        { id: 2, assistantId: "__global__", content: "新", source: "manual", createdAt: 2, updatedAt: 2 },
        { id: 2, assistantId: "a1", content: "冲突", source: "manual", createdAt: 2, updatedAt: 2 },
      ],
      pending: [],
      nextMemoryId: 3,
    })).toThrow();
    expect(readMemorySql(db).memories.map((m) => m.content)).toEqual(["旧"]);
  });

  test("id 计数器独立保存：删掉最大 id 后不复用编号", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemorySql(db, {
      memories: [{ id: 7, assistantId: "__global__", content: "七", source: "manual", createdAt: 1, updatedAt: 1 }],
      pending: [],
      nextMemoryId: 9,
    }, true);
    writeMemorySql(db, { memories: [], pending: [], nextMemoryId: 9 });
    expect(readMemorySql(db).nextMemoryId).toBe(9);
  });
});
