// memory/experiment/forget.test.ts — 实验 S14：执行失真、延迟清除、墓碑与撤销
//
// 锁定：试运行只能出计划；执行 = 已展示的预览（不二次改稿）；原文留存并重新计时；
// 延迟期内可按快照完整撤销；到期只删 rawContent（L3 主题连正文转墓碑）；审计同步抹字；
// 墓碑不再进入注入 / 召回；写入阶段异常按快照回滚且计划保持 proposed。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Assistant } from "../../foundation/types";
import type { MemoryExperimentSettings } from "../../foundation/types/settings/memory-experiment-config";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
const dataDir = mkdtempSync(join(tmpdir(), "rkh-forget-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const store = await import("../../persistence/json-store");
const { openConversationsDb } = await import("../../conversations");
openConversationsDb();
const { memoryStore, memoriesForAssistant, allMemoriesForRecall } = await import("../index");
const { DEFAULT_MEMORY_EXPERIMENT_SETTINGS, needsForgettingUnlock } = await import("./config");
const { listMaintenanceProposals, planMaintenance } = await import("./maintenance");
const {
  applyMaintenanceProposal,
  forgettingSummary,
  PURGED_TEXT,
  runForgettingPurge,
  undoDistillApply,
} = await import("./forget");
const {
  getAudit,
  listAudit,
  listMemoryEdges,
  openExperimentDb,
  recordAudit,
} = await import("./store");

function baseSettings(): Record<string, unknown> {
  return {
    assistants: [],
    providers: [],
    chatModelId: "m1",
    displaySetting: { userNickname: "测试用户" },
    lorebooks: [],
    modeInjections: [],
    memorySettings: { globalEnabled: true, writeStrategy: "ask" },
    memoryVectorSettings: {
      enabled: false,
      autoIndex: false,
      topK: 20,
      minMemories: 24,
      expandNeighbors: false,
      rerankEnabled: false,
      rerankTopN: 40,
    },
    memoryExperimentSettings: DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
  };
}

function setExperiment(patch: Partial<MemoryExperimentSettings> = {}): void {
  (store.state.settings as unknown as { memoryExperimentSettings: MemoryExperimentSettings })
    .memoryExperimentSettings = {
      ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
      enabled: true,
      dryRun: true,
      maintenance: true,
      ...patch,
    };
}

function seedMemory(content: string, patch: Record<string, unknown> = {}) {
  return memoryStore.addMemory({
    scope: "global",
    content,
    source: "manual",
    ...patch,
  } as Parameters<typeof memoryStore.addMemory>[0], false);
}

/** 规划一条 coarsen 计划并切到可执行态，返回审计记录。 */
function planCoarsen(content = "今天下午去喝了咖啡", facets: Record<string, unknown> = { time: "今天下午" }) {
  setExperiment();
  const memory = seedMemory(content, { kind: "event", facets, updatedAt: NOW - 8 * DAY_MS });
  planMaintenance({ now: NOW });
  const record = listMaintenanceProposals("proposed").find((item) => item.targetId === memory.id)!;
  return { memory, record };
}

beforeEach(() => {
  store.setState({ settings: baseSettings() } as unknown as typeof store.state);
  memoryStore.clearAll();
  const db = openExperimentDb();
  db?.query("DELETE FROM pc_memory_audit").run();
  db?.query("DELETE FROM pc_memory_edge").run();
});

afterAll(() => {
  memoryStore.clearAll();
});

describe("关闭试运行的确认闸门", () => {
  test("只有进入「可执行」才需要确认，已可执行时改其他开关不重复要", () => {
    const base = { ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS, enabled: true, dryRun: true, maintenance: true };
    expect(needsForgettingUnlock(base, { ...base, dryRun: false })).toBe(true);
    const armed = { ...base, dryRun: false };
    expect(needsForgettingUnlock(armed, { ...armed, hotMentionThreshold: 6 })).toBe(false);
    expect(needsForgettingUnlock(base, { ...base, enabled: false, dryRun: false })).toBe(false);
  });
});

describe("执行闸门与零副作用", () => {
  test("实验 / 维护关闭时执行与清除都不产生副作用", async () => {
    const memory = seedMemory("今天下午去喝了咖啡", { kind: "event", updatedAt: NOW - 8 * DAY_MS });
    await expect(applyMaintenanceProposal("a-missing")).rejects.toThrow("周期维护未开启");
    expect(runForgettingPurge({ now: NOW })).toEqual({
      dryRun: false, scanned: 0, due: 0, purgedRaw: 0, tombstoned: 0, cleaned: 0,
    });
    expect(forgettingSummary().applied).toHaveLength(0);
    expect(memory.content).toBe("今天下午去喝了咖啡");
  });

  test("试运行：执行被拒、清除只统计；记忆与计时原样保留", async () => {
    const { memory, record } = planCoarsen();
    await expect(applyMaintenanceProposal(record.auditId, { now: NOW })).rejects.toThrow("试运行");
    expect(memory.content).toBe("今天下午去喝了咖啡");
    expect(memory.rawContent ?? null).toBeNull();

    // 手动把计时拨到过期：试运行只应报告 due，不删任何东西。
    memory.purgeAfter = NOW - DAY_MS;
    const dry = runForgettingPurge({ now: NOW });
    expect(dry.dryRun).toBe(true);
    expect(dry.due).toBe(1);
    expect(dry.purgedRaw).toBe(0);
    expect(memory.purgeAfter).toBe(NOW - DAY_MS);
  });
});

describe("执行失真计划", () => {
  test("L2 粗化：写入预览内容，原文留存并按 30 天重新计时", async () => {
    const { memory, record } = planCoarsen();
    setExperiment({ dryRun: false });
    const applied = await applyMaintenanceProposal(record.auditId, { now: NOW });

    expect(applied.op).toBe("coarsen");
    expect(applied.generation).toBe(1);
    expect(applied.modelUsed).toBe(false);
    expect(memory.content).toBe(record.content);
    expect(memory.content).not.toContain("下午");
    expect(memory.rawContent).toBe("今天下午去喝了咖啡");
    expect(memory.status).toBe("active");
    expect(memory.generation).toBe(1);
    expect(memory.distilledAt).toBe(NOW);
    expect(memory.purgeAfter).toBe(NOW + 30 * DAY_MS);

    const db = openExperimentDb()!;
    expect(getAudit(db, record.auditId)!.status).toBe("applied");
    expect(listAudit(db, { action: "distill_apply", status: "applied" })).toHaveLength(1);
    // 已执行的计划不能重复执行。
    await expect(applyMaintenanceProposal(record.auditId, { now: NOW })).rejects.toThrow("不能执行");
  });

  test("L3 主题合并：目标改写、成员归档、边带审计 id", async () => {
    setExperiment();
    const a = seedMemory("最近去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 10 * DAY_MS });
    a.generation = 1;
    const b = seedMemory("近期又去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 9 * DAY_MS });
    b.generation = 1;
    planMaintenance({ now: NOW });
    const record = listMaintenanceProposals("proposed").find((item) => item.op === "theme_merge")!;
    expect(record.memberIds.sort()).toEqual([a.id, b.id].sort());

    const target = record.targetId === a.id ? a : b;
    const survivor = target.id === a.id ? b : a;
    const originalContent = target.content;
    setExperiment({ dryRun: false });
    const applied = await applyMaintenanceProposal(record.auditId, { now: NOW });

    expect(applied.op).toBe("theme_merge");
    expect(applied.generation).toBe(2);
    expect(target.content).toBe(record.content);
    expect(target.content).toContain("共 2 次同类事件");
    expect(target.rawContent).toBe(originalContent);
    expect(target.facets).toEqual({ event: "喝咖啡" });
    expect(survivor.status).toBe("archived");

    const db = openExperimentDb()!;
    const edges = listMemoryEdges(db, { targetId: target.id, kind: "merged_into" });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.sourceId).toBe(survivor.id);
    expect(edges[0]!.meta.auditId).toBe(record.auditId);
  });

  test("受保护 / 已失效的目标拒绝执行，记忆与计划保持原样", async () => {
    const { memory, record } = planCoarsen();
    setExperiment({ dryRun: false });
    memory.explicitRemember = true;
    await expect(applyMaintenanceProposal(record.auditId, { now: NOW })).rejects.toThrow("受保护");
    expect(memory.content).toBe("今天下午去喝了咖啡");
    memory.explicitRemember = false;
    memory.status = "stale";
    await expect(applyMaintenanceProposal(record.auditId, { now: NOW })).rejects.toThrow("计划已过期");
    expect(memory.content).toBe("今天下午去喝了咖啡");
    const db = openExperimentDb()!;
    expect(getAudit(db, record.auditId)!.status).toBe("proposed");
  });

  test("保真摘要没有记忆模型时失败：记忆不动、计划仍可重试、留失败审计", async () => {
    setExperiment({ dryRun: false }); // llmAssist 关闭且无供应商 → 无法生成
    const memory = seedMemory("用户上周去了咖啡店", { kind: "habit" });
    const db = openExperimentDb()!;
    const { auditId } = recordAudit(db, {
      action: "distill_plan",
      status: "proposed",
      memoryId: memory.id,
      detail: {
        op: "fidelity",
        targetId: memory.id,
        memberIds: [],
        content: "",
        currentContent: memory.content,
        reason: "测试：热记忆保真",
        confidence: 0.7,
        fromGeneration: 0,
        toGeneration: 0,
        cadenceDays: 14,
        dueAt: NOW,
        scopeKey: "global",
        scopeLabel: "全局记忆",
        estimatedModelCalls: 1,
        estimatedTokens: 100,
        involved: [{ id: memory.id, content: memory.content, role: "target" }],
      },
    });
    await expect(applyMaintenanceProposal(auditId, { now: NOW })).rejects.toThrow("需要记忆场景模型");
    expect(memory.content).toBe("用户上周去了咖啡店");
    expect(memory.purgeAfter).toBeNull();
    expect(getAudit(db, auditId)!.status).toBe("proposed");
    expect(listAudit(db, { action: "distill_apply", status: "failed" })).toHaveLength(1);
  });

  test("写入阶段异常按快照回滚，计划保持 proposed 可重试", async () => {
    const { memory, record } = planCoarsen();
    setExperiment({ dryRun: false });
    const originalUpdatedAt = memory.updatedAt;
    const patched = memoryStore as unknown as { updateMemory: (...args: unknown[]) => unknown };
    const originalUpdate = patched.updateMemory;
    let calls = 0;
    patched.updateMemory = (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error("模拟写入失败");
      return (originalUpdate as (...inner: unknown[]) => unknown).apply(memoryStore, args);
    };
    try {
      await expect(applyMaintenanceProposal(record.auditId, { now: NOW })).rejects.toThrow("已回滚");
    } finally {
      patched.updateMemory = originalUpdate;
    }
    expect(memory.content).toBe("今天下午去喝了咖啡");
    expect(memory.rawContent ?? null).toBeNull();
    expect(memory.generation).toBe(0);
    expect(memory.purgeAfter).toBeNull();
    expect(memory.updatedAt).toBe(originalUpdatedAt);
    const db = openExperimentDb()!;
    const audit = getAudit(db, record.auditId)!;
    expect(audit.status).toBe("proposed");
    expect((audit.detail.applying as Record<string, unknown>).failedAt).toBeGreaterThan(0);
    expect(listAudit(db, { action: "distill_apply", status: "failed" })).toHaveLength(1);
  });
});

describe("延迟清除期内撤销", () => {
  test("coarsen 撤销：内容、原文、代数、来源与时间全部还原", async () => {
    const { memory, record } = planCoarsen();
    memory.source = "ai";
    setExperiment({ dryRun: false });
    const applied = await applyMaintenanceProposal(record.auditId, { now: NOW });
    expect(applied.purgeAfter).toBe(NOW + 30 * DAY_MS);

    const result = undoDistillApply(record.auditId);
    expect(result.restoredIds).toContain(memory.id);
    expect(memory.content).toBe("今天下午去喝了咖啡");
    expect(memory.rawContent).toBeNull();
    expect(memory.status).toBe("active");
    expect(memory.generation).toBe(0);
    expect(memory.distilledAt).toBeNull();
    expect(memory.purgeAfter).toBeNull();
    expect(memory.source).toBe("ai");
    expect(memory.updatedAt).toBe(NOW - 8 * DAY_MS);

    const db = openExperimentDb()!;
    expect(getAudit(db, record.auditId)!.status).toBe("rejected");
    expect(listAudit(db, { action: "restore", status: "info" })).toHaveLength(1);
    expect(() => undoDistillApply(record.auditId)).toThrow("不能撤销");
  });

  test("theme_merge 撤销：成员恢复 active 且该次合并边被删除", async () => {
    setExperiment();
    const a = seedMemory("最近去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 10 * DAY_MS });
    a.generation = 1;
    const b = seedMemory("近期又去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 9 * DAY_MS });
    b.generation = 1;
    planMaintenance({ now: NOW });
    const record = listMaintenanceProposals("proposed").find((item) => item.op === "theme_merge")!;
    const target = record.targetId === a.id ? a : b;
    const survivor = target.id === a.id ? b : a;
    const survivorContent = survivor.content;
    setExperiment({ dryRun: false });
    await applyMaintenanceProposal(record.auditId, { now: NOW });
    const db = openExperimentDb()!;
    expect(listMemoryEdges(db, { kind: "merged_into" })).toHaveLength(1);

    undoDistillApply(record.auditId);
    expect(survivor.status).toBe("active");
    expect(survivor.content).toBe(survivorContent);
    expect(survivor.generation).toBe(1);
    expect(target.generation).toBe(1);
    expect(target.rawContent).toBeNull();
    expect(listMemoryEdges(db, { kind: "merged_into" })).toHaveLength(0);
  });
});

describe("到期清除与墓碑", () => {
  test("L2 到期只删原文：正文保留、审计抹字、此后拒绝撤销", async () => {
    const { memory, record } = planCoarsen();
    setExperiment({ dryRun: false });
    await applyMaintenanceProposal(record.auditId, { now: NOW });
    const purgeAt = memory.purgeAfter!;

    const summary = forgettingSummary({ now: NOW });
    expect(summary.scheduledPurges).toBe(1);
    expect(summary.earliestPurgeAt).toBe(purgeAt);

    const result = runForgettingPurge({ now: purgeAt });
    expect(result.due).toBe(1);
    expect(result.purgedRaw).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(memory.rawContent).toBeNull();
    expect(memory.purgeAfter).toBeNull();
    expect(memory.status).toBe("active");
    expect(memory.content).toBe(record.content);

    const db = openExperimentDb()!;
    const audit = getAudit(db, record.auditId)!;
    expect(audit.detail.currentContent).toBe(PURGED_TEXT);
    const applied = audit.detail.applied as Record<string, unknown>;
    expect(Number(applied.purgedAt)).toBeGreaterThan(0);
    expect((applied.before as { target: { content: string } }).target.content).toBe(PURGED_TEXT);
    expect(() => undoDistillApply(record.auditId)).toThrow("原文已按延迟清除策略删除");

    // 重复扫描不重复记账。
    const again = runForgettingPurge({ now: purgeAt + DAY_MS });
    expect(again.due).toBe(0);
    expect(listAudit(db, { action: "purge", status: "info" })).toHaveLength(1);
  });

  test("L3 主题到期转墓碑：正文清空、注入与召回不可见、只记一次审计", async () => {
    setExperiment();
    const a = seedMemory("最近去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 10 * DAY_MS });
    a.generation = 1;
    const b = seedMemory("近期又去喝了咖啡", { kind: "event", facets: { event: "喝咖啡" }, updatedAt: NOW - 9 * DAY_MS });
    b.generation = 1;
    planMaintenance({ now: NOW });
    const record = listMaintenanceProposals("proposed").find((item) => item.op === "theme_merge")!;
    const target = record.targetId === a.id ? a : b;
    setExperiment({ dryRun: false });
    await applyMaintenanceProposal(record.auditId, { now: NOW });
    const purgeAt = target.purgeAfter!;

    const result = runForgettingPurge({ now: purgeAt });
    expect(result.tombstoned).toBe(1);
    expect(target.status).toBe("tombstone");
    expect(target.content).toBe("");
    expect(target.rawContent).toBeNull();
    expect(target.facets).toBeNull();

    const assistant = { id: "as-1", name: "测试助手", enableMemory: true } as unknown as Assistant;
    expect(memoriesForAssistant(assistant, "inject").some((item) => item.id === target.id)).toBe(false);
    expect(memoriesForAssistant(assistant, "history").some((item) => item.id === target.id)).toBe(false);
    expect(allMemoriesForRecall().some((item) => item.id === target.id)).toBe(false);

    const db = openExperimentDb()!;
    const tombstones = listAudit(db, { action: "tombstone", status: "info" });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.idempotencyKey).toBe(`tombstone:${target.id}:${purgeAt}`);
    expect(() => undoDistillApply(record.auditId)).toThrow("原文已按延迟清除策略删除");

    const again = runForgettingPurge({ now: purgeAt + DAY_MS });
    expect(again.tombstoned).toBe(0);
    expect(listAudit(db, { action: "tombstone", status: "info" })).toHaveLength(1);
  });

  test("墓碑允许空正文批量保存，普通记忆仍拒绝空正文", () => {
    const normal = seedMemory("用户喜欢绿茶", { kind: "habit" });
    expect(() => memoryStore.validateMemoryEntries([{ id: normal.id, content: "  " }])).toThrow("content is required");
    const doomed = seedMemory("上周去喝了咖啡", { kind: "event" });
    memoryStore.tombstoneMemory(doomed.id, false);
    const [entry] = memoryStore.validateMemoryEntries([{ id: doomed.id, content: "试图复活" }]);
    expect(entry!.content).toBe("");
    expect(entry!.status).toBe("tombstone");
  });
});
