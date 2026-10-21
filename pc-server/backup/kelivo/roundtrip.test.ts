// backup/kelivo/roundtrip.test.ts — Kelivo 双向同步的行为锁。
// 用独立子进程跑真实启动路径：export 造一份合成状态 → 校验归档契约 → 按不同选项导入。
// 选项语义是用户要求的一部分，任何一项回退都会让这里变红。

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "scripts", "kelivo-sync-smoke.ts");
const exportDataDir = mkdtempSync(join(tmpdir(), "rkh-kelivo-export-"));
const zipPath = join(exportDataDir, "kelivo-out.zip");

interface SmokeResult {
  summary: {
    conversationsImported: number;
    memoriesImported: number;
    kelivoSummary: Record<string, number>;
  };
  conversations: number;
  assistants: Array<{
    id: string;
    name: string;
    hasPrompt: boolean;
    model: string | null;
    injections: string[];
    lorebooks: string[];
    quick: string[];
  }>;
  providers: Array<{ name: string; models: string[]; apiKey: string }>;
  lorebooks: string[];
  injections: string[];
  quickMessages: string[];
  searchTypes: string[];
  selectedModel: string;
  memories: string[][];
}

async function run(args: string[], dataDir: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", script, ...args], {
    env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`smoke ${args[0]} exited ${exitCode}\n${stderr}\n${stdout}`);
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT "));
  if (!line) throw new Error(`no RESULT output\n${stderr}\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length));
}

async function importWith(options: string): Promise<SmokeResult> {
  const dataDir = mkdtempSync(join(tmpdir(), `rkh-kelivo-import-${options.replace(/,/g, "_")}-`));
  return run(["import", zipPath], dataDir, { KELIVO_OPTIONS: options }) as Promise<SmokeResult>;
}

const ALL = "conversations,assistants,memories,models,worldBooks,promptInjections,quickMessages,searchServices";
const TEST_ASSISTANT = "同步测试助手";

describe("Kelivo 兼容备份导出契约", () => {
  test("导出范围跟随统一同步选项(关掉的类别不进 Kelivo 包)", async () => {
    const scopedZip = join(mkdtempSync(join(tmpdir(), "rkh-kelivo-scope-")), "scoped.zip");
    await run(["export", scopedZip], mkdtempSync(join(tmpdir(), "rkh-kelivo-scope-export-")), {
      KELIVO_EXPORT_SCOPE: "assistants,memories,worldBooks,promptInjections",
    });
    const result = await run(["validate", scopedZip], mkdtempSync(join(tmpdir(), "rkh-kelivo-scope-validate-")));
    // manifest 自述与实际写库必须一致：关对话/模型/快捷/搜索后，库里也不能留残留行。
    expect(result.manifest.includeChats).toBe(false);
    expect(result.manifest.scope).toMatchObject({
      chats: false,
      providers: false,
      memories: true,
      worldBooks: true,
      quickPhrases: false,
      instructions: true,
      searchServices: false,
    });
    expect(result.counts.conversations).toBe(0);
    expect(result.counts.providers).toBe(0);
    expect(result.counts.memories).toBe(2);
    expect(result.counts.worldBooks).toBe(1);
    expect(result.counts.quick).toBe(0);
    expect(result.counts.search).toBe(0);
    expect(result.entityLengths.provider_configs_v1).toBe(0);
    expect(result.entityLengths.quick_phrases_v1).toBe(0);
    expect(result.preferences.searchEnabled).toBe(false);
  }, 60_000);

  test("生成可通过 Kelivo 恢复校验的 manifest / settings / schema v3 数据库", async () => {
    const exported = await run(["export", zipPath], exportDataDir);
    expect(exported.conversationCount).toBe(1);
    expect(exported.messageCount).toBe(2);

    const result = await run(["validate", zipPath], mkdtempSync(join(tmpdir(), "rkh-kelivo-validate-")));
    expect(result.manifest.format).toBe("kelivo-backup");
    expect(result.manifest.formatVersion).toBe(3);
    expect(result.manifest.payloadKind).toBe("sqlite");
    expect(result.manifest.includeChats).toBe(true);
    expect(result.manifest.includeFiles).toBe(false);
    expect(result.manifest.secretsIncluded).toBe(true);
    expect(result.manifest.scopeKeys).toHaveLength(15);
    expect(result.manifest.database).toMatchObject({
      entry: "database/kelivo.db",
      schemaVersion: 3,
      minimumReadableSchemaVersion: 3,
      conversationCount: 1,
      messageCount: 2,
    });
    expect(result.hashes).toEqual({ "database/kelivo.db": true, "settings.json": true });
    expect(result.userVersion).toBe(3);
    expect(result.integrity).toBe("ok");
    expect(result.foreignKeyIssues).toBe(0);
    expect(result.tables).toHaveLength(29);
    expect(result.counts).toMatchObject({
      assistants: 3,
      conversations: 1,
      messages: 2,
      parts: 4,
      memories: 2,
      worldBooks: 1,
      quick: 1,
    });
    expect(Object.values(result.entitiesAreStrings).every(Boolean)).toBe(true);
    expect(result.firstAssistant).toMatchObject({
      name: TEST_ASSISTANT,
      systemPrompt: "你是测试助手",
      chatModelProvider: "kelivo-test-provider",
      chatModelId: "test-model",
    });
    expect(result.firstProvider).toMatchObject({
      id: "kelivo-test-provider",
      name: "Kelivo Test Provider",
      providerType: "openai",
      apiKey: "sk-test",
      models: ["test-model"],
    });
    expect(result.preferences.instructionsMap).toContain("inject-test");
    expect(result.preferences.worldBooksMap).toContain("book-test");
  }, 60000);
});

describe("Kelivo 导入范围选项", () => {
  test("全选：对话/助手/记忆/模型/世界书/注入/快捷消息/搜索全部落地", async () => {
    const result = await importWith(ALL);
    expect(result.conversations).toBe(1);
    expect(result.summary.memoriesImported).toBe(2);
    expect(result.summary.kelivoSummary.providers).toBeGreaterThan(0);
    const assistant = result.assistants.find((item) => item.name === TEST_ASSISTANT);
    expect(assistant).toBeTruthy();
    expect(assistant?.hasPrompt).toBe(true);
    expect(assistant?.model).toBeTruthy();
    expect(assistant?.injections).toContain("inject-test");
    expect(assistant?.lorebooks).toContain("book-test");
    expect(assistant?.quick).toContain("quick-test");
    expect(result.providers).toEqual([{ name: "Kelivo Test Provider", models: ["test-model"], apiKey: "sk-test" }]);
    expect(result.lorebooks).toContain("book-test");
    expect(result.injections).toContain("inject-test");
    expect(result.quickMessages).toContain("quick-test");
    expect(result.searchTypes).toContain("tavily");
    expect(result.selectedModel === assistant?.model).toBe(true);
    expect(result.memories.some(([assistantId, content]) => assistantId === assistant?.id && content === "助手记忆内容")).toBe(true);
  }, 60000);

  test("只选对话：一律建空白助手，不导入提示词/模型/记忆", async () => {
    const result = await importWith("conversations");
    expect(result.conversations).toBe(1);
    expect(result.summary.memoriesImported).toBe(0);
    const assistant = result.assistants.find((item) => item.name === TEST_ASSISTANT);
    expect(assistant).toBeTruthy();
    expect(assistant?.hasPrompt).toBe(false);
    expect(assistant?.model).toBeNull();
    expect(result.providers).toHaveLength(0);
    expect(result.lorebooks).toHaveLength(0);
    expect(result.memories).toHaveLength(0);
  }, 60000);

  test("只选助手：有设置和提示词，但没有对话", async () => {
    const result = await importWith("assistants");
    expect(result.conversations).toBe(0);
    const assistant = result.assistants.find((item) => item.name === TEST_ASSISTANT);
    expect(assistant?.hasPrompt).toBe(true);
    // 没选模型设置 → 不写入 Kelivo 的模型 id，保留本地绑定（新助手为 null）
    expect(assistant?.model).toBeNull();
    expect(result.providers).toHaveLength(0);
  }, 60000);

  test("只选记忆：助手记忆落到同名空白助手", async () => {
    const result = await importWith("memories");
    expect(result.conversations).toBe(0);
    expect(result.summary.memoriesImported).toBe(2);
    const assistant = result.assistants.find((item) => item.name === TEST_ASSISTANT);
    expect(assistant).toBeTruthy();
    expect(assistant?.hasPrompt).toBe(false);
    expect(result.providers).toHaveLength(0);
    expect(result.memories.some((entry) => entry[1] === "助手记忆内容")).toBe(true);
  }, 60000);

  test("只选模型：只写供应商和所选模型，不碰对话/助手", async () => {
    const result = await importWith("models");
    expect(result.conversations).toBe(0);
    expect(result.providers).toEqual([{ name: "Kelivo Test Provider", models: ["test-model"], apiKey: "sk-test" }]);
    expect(result.selectedModel).toBeTruthy();
    expect(result.memories).toHaveLength(0);
  }, 60000);

  test("只选内容类配置：世界书/注入/快捷/搜索导入，但无对话与供应商", async () => {
    const result = await importWith("worldBooks,promptInjections,quickMessages,searchServices");
    expect(result.conversations).toBe(0);
    expect(result.providers).toHaveLength(0);
    expect(result.lorebooks).toContain("book-test");
    expect(result.injections).toContain("inject-test");
    expect(result.quickMessages).toContain("quick-test");
    expect(result.searchTypes).toContain("tavily");
    expect(result.memories).toHaveLength(0);
  }, 60000);
});