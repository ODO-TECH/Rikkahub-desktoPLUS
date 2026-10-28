// memory/experiment/maintenance.test.ts — 实验 S13：周期维护计划（7/14 天 dry-run）
//
// 锁定：cold 事件 7 天粗化、L2 同类事件合成 L3、hot 事件 14 天只做保真摘要、
// 习惯/设定不降级、扫描零模型调用与零记忆改动、同签名计划不重复、拒绝后不复发、
// 单次预算封顶、启动补算每天只留一条 info 审计。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryExperimentSettings } from "../../foundation/types/settings/memory-experiment-config";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
const dataDir = mkdtempSync(join(tmpdir(), "rkh-maintenance-test-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const store = await import("../../persistence/json-store");
const { openConversationsDb } = await import("../../conversations");
openConversationsDb();
const { memoryStore } = await import("../index");
const { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } = await import("./config");
const {
  coarsenEventContent,
  listMaintenanceProposals,
  planMaintenance,
  rejectMaintenanceProposal,
} = await import("./maintenance");
const { listAudit, openExperimentDb } = await import("./store");

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

function enableMaintenance(patch: Partial<MemoryExperimentSettings> = {}): void {
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

beforeEach(() => {
  store.setState({ settings: baseSettings() } as unknown as typeof store.state);
  memoryStore.clearAll();
  // 审计与关系边跨用例共享会撞幂等键：每个用例从空审计开始。
  const db = openExperimentDb();
  db?.query("DELETE FROM pc_memory_audit").run();
  db?.query("DELETE FROM pc_memory_edge").run();
});

afterAll(() => {
  memoryStore.clearAll();
});

describe("确定性的 L2 粗化", () => {
  test("时间词降到「最近 / 近期」，去掉括注细节", () => {
    const preview = coarsenEventContent({
      content: "今天下午和朋友去了星巴克（排了很久的队）",
      facets: { time: "今天下午" },
    });
    expect(preview.changed).toBe(true);
    expect(preview.content).toBe("最近和朋友去了星巴克");
    expect(preview.content).not.toContain("下午");
    expect(preview.content).not.toContain("排队");
  });

  test("没有可粗化内容时 changed=false（不制造空计划）", () => {
    const preview = coarsenEventContent({ content: "用户养了一只猫", facets: null });
    expect(preview.changed).toBe(false);
  });
});

describe("周期维护计划", () => {
  test("实验或子开关关闭时零副作用", () => {
    const memory = seedMemory("上周去吃了肯德基", { kind: "event", updatedAt: NOW - 30 * DAY_MS });
    expect(planMaintenance({ now: NOW }).created).toBe(0);
    enableMaintenance({ maintenance: false });
    expect(planMaintenance({ now: NOW }).created).toBe(0);
    expect(memory.kind).toBe("event");
    const db = openExperimentDb();
    expect(listAudit(db!, { action: "distill_plan" })).toHaveLength(0);
  });

  test("cold 事件 7 天生成 L1→L2 计划；重复扫描不重复；拒绝后不复发", () => {
    enableMaintenance();
    const memory = seedMemory("今天下午去喝了咖啡", {
      kind: "event",
      facets: { time: "今天下午", event: "喝咖啡" },
      updatedAt: NOW - 8 * DAY_MS,
    });

    const plan = planMaintenance({ now: NOW, trigger: "startup" });
    expect(plan.created).toBe(1);
    expect(plan.estimatedModelCalls).toBe(0);
    const [proposal] = listMaintenanceProposals("proposed");
    expect(proposal!.op).toBe("coarsen");
    expect(proposal!.targetId).toBe(memory.id);
    expect(proposal!.fromGeneration).toBe(0);
    expect(proposal!.toGeneration).toBe(1);
    expect(proposal!.content).toContain("最近");
    expect(proposal!.content).not.toContain("下午");
    expect(proposal!.cadenceDays).toBe(7);

    // dry-run：记忆本身完全不变。
    expect(memory.content).toBe("今天下午去喝了咖啡");
    expect(memory.generation).toBe(0);
    expect(memory.distilledAt).toBeNull();
    expect(memory.status).toBe("active");

    expect(planMaintenance({ now: NOW }).created).toBe(0);
    rejectMaintenanceProposal(proposal!.auditId);
    expect(planMaintenance({ now: NOW }).created).toBe(0);
  });

  test("未到期的事件不生成计划；到 7 天后才出现", () => {
    enableMaintenance();
    seedMemory("昨天去喝了咖啡", {
      kind: "event",
      facets: { time: "昨天", event: "喝咖啡" },
      updatedAt: NOW - 3 * DAY_MS,
    });
    const early = planMaintenance({ now: NOW });
    expect(early.created).toBe(0);
    expect(early.skipped.notDue).toBe(1);
    const later = planMaintenance({ now: NOW + 5 * DAY_MS });
    expect(later.created).toBe(1);
  });

  test("L2 同类事件合成 L3 主题要旨；hot 成员不参与跨事件合并", () => {
    enableMaintenance();
    const a = seedMemory("最近去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      updatedAt: NOW - 10 * DAY_MS,
    });
    a.generation = 1;
    const b = seedMemory("近期又去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      updatedAt: NOW - 9 * DAY_MS,
    });
    b.generation = 1;
    const hot = seedMemory("最近还是去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      updatedAt: NOW - 20 * DAY_MS,
    });
    hot.generation = 1;
    hot.mentionCount = 6;

    const plan = planMaintenance({ now: NOW, trigger: "startup" });
    const theme = listMaintenanceProposals("proposed").find((item) => item.op === "theme_merge");
    expect(theme).toBeDefined();
    expect(theme!.toGeneration).toBe(2);
    expect(theme!.memberIds.sort()).toEqual([a.id, b.id].sort());
    expect(theme!.memberIds).not.toContain(hot.id);
    expect(theme!.content).toContain("共 2 次同类事件");
    // hot 事件没有模型时只记 noModel，不降级也不合并。
    expect(plan.skipped.noModel).toBeGreaterThanOrEqual(1);
  });

  test("hot 事件 14 天只做保真摘要，且必须有记忆模型", () => {
    enableMaintenance();
    const hot = seedMemory("上周去喝了咖啡", {
      kind: "event",
      facets: { event: "喝咖啡" },
      updatedAt: NOW - 8 * DAY_MS,
    });
    hot.mentionCount = 5;

    // 14 天周期未到：即使模型可用也不生成。
    enableMaintenance({ llmAssist: true });
    expect(planMaintenance({ now: NOW }).created).toBe(0);

    hot.distilledAt = NOW - 15 * DAY_MS;
    hot.updatedAt = NOW - 20 * DAY_MS;
    const plan = planMaintenance({ now: NOW });
    const proposal = plan.proposals.find((item) => item.targetId === hot.id);
    expect(proposal?.op).toBe("fidelity");
    expect(proposal?.fromGeneration).toBe(proposal?.toGeneration);
    expect(proposal?.content).toBe("");
    expect(plan.estimatedModelCalls).toBe(1);
    expect(plan.estimatedTokens).toBeGreaterThan(0);

    // 关闭模型：hot 事件宁可不生成，也不做有损的确定性重写。
    enableMaintenance();
    hot.distilledAt = null;
    const withoutModel = planMaintenance({ now: NOW });
    expect(withoutModel.proposals.some((item) => item.targetId === hot.id)).toBe(false);
    expect(withoutModel.skipped.noModel).toBeGreaterThanOrEqual(1);
  });

  test("习惯只做保真摘要，设定与明确记住永不进入遗忘队列", () => {
    enableMaintenance({ llmAssist: true });
    const habit = seedMemory("用户喜欢喝绿茶", { kind: "habit", updatedAt: NOW - 20 * DAY_MS });
    const setting = seedMemory("用户是左撇子", { kind: "setting", updatedAt: NOW - 100 * DAY_MS });
    const explicit = seedMemory("别忘了给妈妈打电话", {
      kind: "event",
      explicitRemember: true,
      updatedAt: NOW - 100 * DAY_MS,
    });

    const plan = planMaintenance({ now: NOW });
    const ids = plan.proposals.map((item) => item.targetId);
    expect(ids).toContain(habit.id);
    expect(ids).not.toContain(setting.id);
    expect(ids).not.toContain(explicit.id);
    const proposal = plan.proposals.find((item) => item.targetId === habit.id)!;
    expect(proposal.op).toBe("fidelity");
    expect(proposal.cadenceDays).toBe(14);
    expect(setting.kind).toBe("setting");
    expect(explicit.kind).toBe("event");
  });

  test("单次扫描预算封顶，不会一次刷满审计", () => {
    enableMaintenance();
    for (let index = 0; index < 12; index += 1) {
      seedMemory(`上周去喝了咖啡 ${index}`, {
        kind: "event",
        facets: { time: "上周", event: `喝咖啡${index}` },
        updatedAt: NOW - 9 * DAY_MS,
      });
    }
    const plan = planMaintenance({ now: NOW });
    expect(plan.created).toBe(10);
    expect(plan.skipped.budget).toBe(2);
    expect(listMaintenanceProposals("proposed")).toHaveLength(10);
  });

  test("启动补算每天只留一条 info 审计；手动扫描不写运行占位", () => {
    enableMaintenance();
    seedMemory("上周去喝了咖啡", {
      kind: "event",
      facets: { time: "上周", event: "喝咖啡" },
      updatedAt: NOW - 9 * DAY_MS,
    });
    const db = openExperimentDb()!;
    expect(listAudit(db, { action: "distill_plan", status: "info" })).toHaveLength(0);

    planMaintenance({ now: NOW, trigger: "startup" });
    planMaintenance({ now: NOW, trigger: "startup" });
    expect(listAudit(db, { action: "distill_plan", status: "info" })).toHaveLength(1);

    planMaintenance({ now: NOW + 2 * DAY_MS, trigger: "manual" });
    expect(listAudit(db, { action: "distill_plan", status: "info" })).toHaveLength(1);
  });
});
