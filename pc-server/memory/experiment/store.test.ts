// memory/experiment/store.test.ts — 记忆边与审计的持久化原语。
// 用 :memory: 库直接测行级行为，不拉起活库 / 全量记忆仓库。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  deleteMemoryEdgesForMemory,
  getAuditByIdempotencyKey,
  listAudit,
  listMemoryEdges,
  recordAudit,
  recordMemoryEdge,
  updateAuditResult,
} from "./store";

describe("记忆边", () => {
  test("同三元组重复写入只更新 meta；按目标/来源/类型过滤", () => {
    const db = new Database(":memory:");
    recordMemoryEdge(db, { sourceId: 1, targetId: 2, kind: "supersedes", meta: { reason: "旧值" } });
    recordMemoryEdge(db, { sourceId: 1, targetId: 2, kind: "supersedes", meta: { reason: "新值" } });
    recordMemoryEdge(db, { sourceId: 2, targetId: 3, kind: "related" });

    const all = listMemoryEdges(db);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ sourceId: 1, targetId: 2, kind: "supersedes", meta: { reason: "新值" } });
    expect(listMemoryEdges(db, { targetId: 2 }).map((e) => e.kind)).toEqual(["supersedes"]);
    expect(listMemoryEdges(db, { sourceId: 2 }).map((e) => e.kind)).toEqual(["related"]);
  });

  test("删除某条记忆时两端边一起清掉", () => {
    const db = new Database(":memory:");
    recordMemoryEdge(db, { sourceId: 1, targetId: 2, kind: "supersedes" });
    recordMemoryEdge(db, { sourceId: 2, targetId: 3, kind: "related" });
    recordMemoryEdge(db, { sourceId: 4, targetId: 5, kind: "merged_into" });
    deleteMemoryEdgesForMemory(db, 2);
    expect(listMemoryEdges(db).map((e) => [e.sourceId, e.targetId])).toEqual([[4, 5]]);
  });
});

describe("审计", () => {
  test("idempotencyKey 幂等占位：第二次插入被忽略", () => {
    const db = new Database(":memory:");
    const first = recordAudit(db, {
      action: "intake",
      status: "proposed",
      idempotencyKey: "k-1",
      detail: { a: 1 },
    });
    const second = recordAudit(db, {
      action: "intake",
      status: "proposed",
      idempotencyKey: "k-1",
      detail: { a: 2 },
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(listAudit(db)).toHaveLength(1);
    const found = getAuditByIdempotencyKey(db, "k-1");
    expect(found?.auditId).toBe(first.auditId);
    expect(found?.detail).toEqual({ a: 1 });
  });

  test("updateAuditResult 合并 detail 并改状态", () => {
    const db = new Database(":memory:");
    const { auditId } = recordAudit(db, { action: "intake", status: "proposed", detail: { keep: true } });
    expect(updateAuditResult(db, auditId, "applied", { memoryId: 7 })).toBe(true);
    const entry = listAudit(db)[0];
    expect(entry.status).toBe("applied");
    expect(entry.memoryId).toBeNull();
    expect(entry.detail).toEqual({ keep: true, memoryId: 7 });
  });

  test("按状态 / 动作过滤，limit 生效", () => {
    const db = new Database(":memory:");
    recordAudit(db, { action: "intake", status: "applied", detail: {} });
    recordAudit(db, { action: "merge_plan", status: "proposed", detail: {} });
    recordAudit(db, { action: "merge_plan", status: "applied", detail: {} });
    expect(listAudit(db, { action: "merge_plan" })).toHaveLength(2);
    expect(listAudit(db, { status: "applied" })).toHaveLength(2);
    expect(listAudit(db, { status: "proposed", action: "merge_plan" })).toHaveLength(1);
    expect(listAudit(db, { limit: 1 })).toHaveLength(1);
  });
});
