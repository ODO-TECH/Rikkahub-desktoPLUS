// memory/sqlite.test.ts — 记忆结构化存储的行为锁。
// 纪律：一条记忆一行；全局归属写 __global__；整份写入单事务；迁移标记决定启动读库还是读 JSON。
// 注：memoryStore 与活库的接线在独立子进程里跑（scripts/memory-sql-migration-smoke.ts），
// 避免 bun test 多文件共享 paths 模块缓存、互相污染数据目录。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureMemoryTables, memorySqlReady, readMemoryOrganizeState, readMemorySql, writeMemoryOrganizeState, writeMemorySql } from "./sqlite";

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

describe("实验扩展字段：增量 schema 往返", () => {
  test("记忆的分类 / 状态 / 标签 / 原文宽限期原样读回", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemorySql(db, {
      memories: [{
        id: 1,
        assistantId: "__global__",
        content: "用户喜欢帕秋莉",
        source: "ai",
        createdAt: 10,
        updatedAt: 20,
        kind: "setting",
        status: "active",
        rawContent: "用户原话：我更喜欢帕秋莉",
        facets: { person: "帕秋莉", tags: ["东方"] },
        explicitRemember: true,
        mentionCount: 3,
        lastMentionedAt: 30,
        generation: 1,
        distilledAt: 25,
        purgeAfter: 60,
        sourceConversationId: "c1",
        sourceCutMessageId: "m9",
      }],
      pending: [{
        pendingId: "p-1",
        conversationId: "c1",
        assistantId: "a1",
        assistantName: "助手",
        content: "上周去上海吃火锅",
        proposedAt: 40,
        kind: "event",
        facets: { time: "上周", place: "上海" },
        explicitRemember: true,
        rawContent: "原始段落",
        sourceCutMessageId: "m9",
        idempotencyKey: "cut:c1:m9",
        origin: "compaction",
      }],
      nextMemoryId: 2,
    }, true);

    const snapshot = readMemorySql(db);
    expect(snapshot.memories[0]).toMatchObject({
      kind: "setting",
      status: "active",
      rawContent: "用户原话：我更喜欢帕秋莉",
      facets: { person: "帕秋莉", tags: ["东方"] },
      explicitRemember: true,
      mentionCount: 3,
      lastMentionedAt: 30,
      generation: 1,
      distilledAt: 25,
      purgeAfter: 60,
      sourceConversationId: "c1",
      sourceCutMessageId: "m9",
    });
    expect(snapshot.pending[0]).toMatchObject({
      kind: "event",
      facets: { time: "上周", place: "上海" },
      explicitRemember: true,
      rawContent: "原始段落",
      sourceCutMessageId: "m9",
      idempotencyKey: "cut:c1:m9",
      origin: "compaction",
    });
  });

  test("老备份（无实验键）读出 unclassified / active，pending 不沾新字段", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemorySql(db, {
      memories: [{ id: 1, assistantId: "__global__", content: "旧记忆", source: "manual", createdAt: 1, updatedAt: 1 }],
      pending: [{
        pendingId: "p-old",
        conversationId: "c1",
        assistantId: "a1",
        assistantName: "助手",
        content: "待确认",
        proposedAt: 2,
      }],
      nextMemoryId: 2,
    }, true);
    const snapshot = readMemorySql(db);
    expect(snapshot.memories[0].kind).toBe("unclassified");
    expect(snapshot.memories[0].status).toBe("active");
    expect(snapshot.memories[0].explicitRemember).toBe(false);
    // pending 的实验字段只在非默认时输出，旧契约对象保持逐字节一致。
    expect(snapshot.pending[0]).toEqual({
      pendingId: "p-old",
      conversationId: "c1",
      assistantId: "a1",
      assistantName: "助手",
      content: "待确认",
      proposedAt: 2,
    });
  });
});

describe("pc_memory_organize：整理水位", () => {
  test("按会话记录水位与状态；水位只前进不后退", () => {    const db = new Database(":memory:");
    ensureMemoryTables(db);
    expect(readMemoryOrganizeState(db, "c1")).toEqual({ watermark: 0, lastRunAt: null, lastStatus: null });
    writeMemoryOrganizeState(db, "c1", { watermark: 10, lastStatus: "merged:1 deleted:0" });
    expect(readMemoryOrganizeState(db, "c1")).toEqual({
      watermark: 10,
      lastRunAt: expect.any(Number),
      lastStatus: "merged:1 deleted:0",
    });
    // 旧水位不覆盖新水位（乱序任务 / 并发写）
    writeMemoryOrganizeState(db, "c1", { watermark: 4, lastStatus: "no_operations" });
    const state = readMemoryOrganizeState(db, "c1");
    expect(state?.watermark).toBe(10);
    expect(state?.lastStatus).toBe("no_operations");
  });

  test("不同会话的水位互不影响", () => {
    const db = new Database(":memory:");
    ensureMemoryTables(db);
    writeMemoryOrganizeState(db, "c1", { watermark: 3 });
    writeMemoryOrganizeState(db, "c2", { watermark: 7 });
    expect(readMemoryOrganizeState(db, "c1")?.watermark).toBe(3);
    expect(readMemoryOrganizeState(db, "c2")?.watermark).toBe(7);
  });
});
