// backup/selective-scope.test.ts — 桌面端「同步选项」(backupScope)的内容门控锁。
// 契约:开关只决定「该类别是否进包」;settings.json 与 pc-backup.json 永远在场
// (恢复端缺一不可),未勾选的实体在包里剪成空数组,而未勾选的整组文件直接不进 zip。
// 技能一项额外有暗礁——SKILL.md 正文是内联在 pc-backup.json.skills 里的,只删 skills/
// 目录不算关掉,故必须同时断言 payload 被剪空。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-scope-bak-"));

const jsonStore = await import("../persistence/json-store");
const { defaultState } = await import("../app-config/defaults");
const { dataDir, skillsDir } = await import("../foundation/paths");
const { createSettingsBackupZipToPath, FULL_BACKUP_SCOPE } = await import("./export");
const { readZipEntries } = await import("../files/index");
const { openConversationsDb } = await import("../conversations");
const { memoryStore } = await import("../memory/index");

import type { BackupScope } from "../foundation/types/settings/storage-config";
import type { State } from "../foundation/types";

const priorState = jsonStore.state;
const cache = new Map<string, Buffer>();

function zipNames(scope: BackupScope): string[] {
  return readZipEntries(zipBytes(scope)).map((entry) => entry.name);
}

function entryText(scope: BackupScope, name: string): string {
  return readZipEntries(zipBytes(scope)).find((entry) => entry.name === name)!.data.toString("utf8");
}

function zipBytes(scope: BackupScope): Buffer {
  // 一次 zip ≈ 2s(Windows 下借 powershell 打包),同组开关的多种取值各打一次已够本文件用。
  const key = JSON.stringify(scope);
  const cached = cache.get(key);
  if (cached) return cached;
  const zipPath = join(dataDir, `.probe-${Math.random().toString(36).slice(2)}.zip`);
  try {
    createSettingsBackupZipToPath(zipPath, undefined, scope);
    const bytes = readFileSync(zipPath);
    cache.set(key, bytes);
    return bytes;
  } finally {
    rmSync(zipPath, { force: true });
  }
}

beforeAll(() => {
  jsonStore.setState(defaultState() as unknown as State);
  // 实体级开关要能断言「剪掉了」,先往默认 state 播一组可识别条目。
  const settings = jsonStore.state.settings as unknown as Record<string, unknown[]>;
  settings.assistants.push({ id: "scope-assistant", name: "Scope Assistant" });
  settings.providers.push({ id: "scope-provider", name: "Scope Provider", models: [] });
  settings.lorebooks.push({ id: "scope-lorebook", name: "Scope Lorebook" });
  settings.modeInjections.push({ id: "scope-injection", name: "Scope Injection" });
  settings.quickMessages.push({ id: "scope-quick", name: "Scope Quick" });
  settings.searchServices.push({ type: "scope-search", name: "Scope Search" });
  // 记忆单独可关——播一条全局记忆供断言。
  memoryStore.addMemory({ scope: "global", content: "scope-memory" }, false);
  // 活库未打开时 pc dump 直接返回 -1(零落盘),会话组就无从断言——按套件惯例先开库。
  openConversationsDb();
  mkdirSync(join(skillsDir, "demo-skill"), { recursive: true });
  writeFileSync(
    join(skillsDir, "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: A demo skill used only by backup scope tests.\n---\n\n# Demo\n",
    "utf8",
  );
  mkdirSync(join(dataDir, "fonts"), { recursive: true });
  writeFileSync(join(dataDir, "fonts", "demo.ttf"), "not-a-real-font", "utf8");
  writeFileSync(join(dataDir, "AGENTS.md"), "# global rules\n", "utf8");
});

afterAll(() => {
  jsonStore.flushSaveState().catch(() => {});
  jsonStore.setState(priorState);
  // 只清自己播的种子:dataDir 是本进程共享的沙箱(test-preload),整目录删会伤及后跑的文件。
  rmSync(join(dataDir, "AGENTS.md"), { force: true });
  rmSync(join(dataDir, "fonts"), { recursive: true, force: true });
  rmSync(join(skillsDir, "demo-skill"), { recursive: true, force: true });
});

describe("选择性备份的内容门控", () => {
  test("全开:各组条目齐备(与旧版无选择性备份等价)", () => {
    const names = zipNames(FULL_BACKUP_SCOPE);
    expect(names).toContain("settings.json");
    expect(names).toContain("pc-backup.json");
    expect(names).toContain("pc_conversations.db");
    expect(names).toContain("skills/demo-skill/SKILL.md");
    expect(names).toContain("fonts/demo.ttf");
    expect(names).toContain("AGENTS.md");
    expect(JSON.parse(entryText(FULL_BACKUP_SCOPE, "pc-backup.json")).skills).toHaveLength(1);
  }, 30_000);

  test("逐项关:只少自己那一组,其余组与两个必带文件不受牵连", () => {
    const probes: Array<[keyof BackupScope, string, string]> = [
      // [关掉的开关, 该消失的条目, 该存活的兄弟条目]
      ["conversations", "pc_conversations.db", "AGENTS.md"],
      ["skills", "skills/demo-skill/SKILL.md", "fonts/demo.ttf"],
      ["fonts", "fonts/demo.ttf", "skills/demo-skill/SKILL.md"],
      ["globalAgents", "AGENTS.md", "fonts/demo.ttf"],
    ];
    for (const [key, absent, present] of probes) {
      const names = zipNames({ ...FULL_BACKUP_SCOPE, [key]: false });
      expect(names).not.toContain(absent);
      expect(names).toContain(present);
      expect(names).toContain("settings.json");
      expect(names).toContain("pc-backup.json");
    }
  }, 60_000);

  test("关技能时 pc-backup.json.skills 一并剪空(正文内联在此,只删目录不够)", () => {
    expect(JSON.parse(entryText({ ...FULL_BACKUP_SCOPE, skills: false }, "pc-backup.json")).skills).toEqual([]);
    expect(JSON.parse(entryText(FULL_BACKUP_SCOPE, "pc-backup.json")).skills).toHaveLength(1);
  });

  test("实体级开关:只剪自己那一类,兄弟类别原样", () => {
    const full = JSON.parse(entryText(FULL_BACKUP_SCOPE, "pc-backup.json")).state.settings as Record<string, unknown[]>;
    const probes: Array<[keyof BackupScope, string]> = [
      ["assistants", "assistants"],
      ["models", "providers"],
      ["worldBooks", "lorebooks"],
      ["promptInjections", "modeInjections"],
      ["quickMessages", "quickMessages"],
      ["searchServices", "searchServices"],
    ];
    for (const [, field] of probes) expect(full[field].length).toBeGreaterThan(0);
    for (const [key, field] of probes) {
      const scoped = JSON.parse(entryText({ ...FULL_BACKUP_SCOPE, [key]: false }, "pc-backup.json")).state.settings as Record<string, unknown[]>;
      expect(scoped[field]).toEqual([]);
      const sibling = probes.map(([, f]) => f).find((f) => f !== field && full[f].length > 0)!;
      expect(scoped[sibling].length).toBe(full[sibling].length);
    }
  }, 60_000);

  test("记忆开关:关掉后 pc-backup.state.memories 为空", () => {
    const full = JSON.parse(entryText(FULL_BACKUP_SCOPE, "pc-backup.json")).state.memories as Array<{ content: string }>;
    expect(full.some((m) => m.content === "scope-memory")).toBe(true);
    const off = JSON.parse(entryText({ ...FULL_BACKUP_SCOPE, memories: false }, "pc-backup.json")).state.memories;
    expect(off).toEqual([]);
  });

  test("关会话只少数据库,设置与技能照旧(恢复端据此保留本机对话)", () => {
    const scope: BackupScope = { ...FULL_BACKUP_SCOPE, conversations: false };
    const names = zipNames(scope);
    expect(names).not.toContain("pc_conversations.db");
    expect(names.filter((name) => name.startsWith("rikka_hub"))).toEqual([]);
    expect(names).toContain("skills/demo-skill/SKILL.md");
    expect(JSON.parse(entryText(scope, "settings.json"))).toBeDefined();
  });

  test("备份包不携带 backupScope 本身(它是本机偏好,不参与跨机迁移)", () => {
    expect(JSON.parse(entryText(FULL_BACKUP_SCOPE, "settings.json")).backupScope).toBeUndefined();
  });
});
