// backup/memory-experiment-restore.test.ts — S14 闸门:完整备份往返必须保留「未到期实验状态」。
//
// 链路:执行失真 → rawContent + purgeAfter 落库 → 全量备份 zip → 清空本机 → 恢复 →
// 宽限期字段原样回来,且到期清除仍按原 purgeAfter 生效(原文真删 / L3 转墓碑)。
// 防回归点:恢复端若把 memories 交给 normalizeState 的瘦身映射(只留 id/内容/时间),
// rawContent 与 purgeAfter 会被静默丢掉,用户以为备份能救回来,实际到期状态无从判断。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const dataDir = mkdtempSync(join(tmpdir(), "rkh-s14-backup-"));
process.env.RIKKAHUB_PC_DATA_DIR = dataDir;

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { createSettingsBackupZipToPath, FULL_BACKUP_SCOPE } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { openConversationsDb } = await import("../conversations");
const { applyAndroidZipBackupFromPath, applyBackupPayload } = await import("./import");
const { memoryStore } = await import("../memory/index");
const { runForgettingPurge } = await import("../memory/experiment/forget");
const { DEFAULT_MEMORY_EXPERIMENT_SETTINGS } = await import("../memory/experiment/config");

const priorState = jsonStore.state;

function armMutatingExperiment(): void {
  (jsonStore.state.settings as unknown as { memoryExperimentSettings: unknown }).memoryExperimentSettings = {
    ...DEFAULT_MEMORY_EXPERIMENT_SETTINGS,
    enabled: true,
    dryRun: false,
    maintenance: true,
  };
}

beforeAll(() => {
  jsonStore.setState(defaultState() as unknown as typeof jsonStore.state);
  openConversationsDb();
});

afterAll(() => {
  memoryStore.clearAll();
  jsonStore.setState(priorState);
  // 临时目录留给系统清理:恢复链路仍持有会话库 / zip 句柄,Windows 下立即删目录会 EBUSY。
});

describe("完整备份恢复未到期实验状态", () => {
  test("备份带 rawContent/purgeAfter,恢复后到期清除照常生效", () => {
    const purgeAfter = NOW + 5 * DAY_MS;
    const memory = memoryStore.addMemory(
      {
        scope: "global",
        content: "吃饭：共 2 次同类事件，时间地点已粗化",
        kind: "event",
        facets: { event: "吃饭" },
      } as Parameters<typeof memoryStore.addMemory>[0],
      false,
    );
    memoryStore.patchMemoryExperimentFields(
      memory.id,
      { rawContent: "上周五和朋友去吃了川味火锅，很辣", generation: 2, distilledAt: NOW - DAY_MS, purgeAfter },
      false,
    );

    // 1) 全量备份:pc-backup.json 的记忆段必须携带实验扩展。
    const zipPath = join(dataDir, "s14-roundtrip.zip");
    createSettingsBackupZipToPath(zipPath, undefined, FULL_BACKUP_SCOPE);
    const entries = readZipEntries(readFileSync(zipPath));
    const payload = JSON.parse(entries.find((entry) => entry.name === "pc-backup.json")!.data.toString("utf8")) as {
      state: { memories: Array<Record<string, unknown>> };
    };
    const backed = payload.state.memories.find((item) => String(item.content).startsWith("吃饭"))!;
    expect(backed.kind).toBe("event");
    expect(backed.generation).toBe(2);
    expect(backed.rawContent).toBe("上周五和朋友去吃了川味火锅，很辣");
    expect(backed.purgeAfter).toBe(purgeAfter);

    // 2) 模拟换机 / 数据丢失后恢复。
    memoryStore.clearAll();
    const result = applyAndroidZipBackupFromPath(zipPath);
    expect(result.settingsImported).toBe(true);

    const restored = memoryStore.exportFlatWithExperiment().find((item) => item.content.startsWith("吃饭"))!;
    expect(restored.kind).toBe("event");
    expect(restored.status).toBe("active");
    expect(restored.generation).toBe(2);
    expect(restored.rawContent).toBe("上周五和朋友去吃了川味火锅，很辣");
    expect(restored.purgeAfter).toBe(purgeAfter);
    expect(restored.facets).toEqual({ event: "吃饭" });

    // 3) 恢复后的到期清除仍按备份里的 purgeAfter 执行:L3 事件连正文转墓碑。
    armMutatingExperiment();
    const purge = runForgettingPurge({ now: purgeAfter + 1 });
    expect(purge.tombstoned).toBe(1);
    const after = memoryStore.findEntryById(restored.id)!;
    expect(after.status).toBe("tombstone");
    expect(after.content).toBe("");
    expect(after.rawContent ?? null).toBeNull();
    expect(after.purgeAfter ?? null).toBeNull();
  }, 20_000);

  test("JSON 备份恢复(applyBackupPayload)同样保留实验扩展", () => {
    const purgeAfter = NOW + 3 * DAY_MS;
    const memory = memoryStore.addMemory(
      {
        scope: "global",
        content: "最近去看了电影",
        kind: "event",
        facets: { event: "看电影" },
      } as Parameters<typeof memoryStore.addMemory>[0],
      false,
    );
    memoryStore.patchMemoryExperimentFields(
      memory.id,
      { rawContent: "昨天下午去看了电影（影院很吵，中途还停电了）", generation: 1, distilledAt: NOW, purgeAfter },
      false,
    );
    // 与 data/import 的 PC JSON 路径同构:settings + memories 直接进 applyBackupPayload。
    const body = {
      state: {
        settings: JSON.parse(JSON.stringify(jsonStore.state.settings)),
        memories: memoryStore.exportFlatWithExperiment(),
      },
    };
    memoryStore.clearAll();
    applyBackupPayload(body);

    const restored = memoryStore.exportFlatWithExperiment().find((item) => item.content === "最近去看了电影")!;
    expect(restored.kind).toBe("event");
    expect(restored.generation).toBe(1);
    expect(restored.rawContent).toBe("昨天下午去看了电影（影院很吵，中途还停电了）");
    expect(restored.purgeAfter).toBe(purgeAfter);
    expect(restored.facets).toEqual({ event: "看电影" });
  }, 20_000);
});
