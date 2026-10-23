// scripts/kelivo-sync-smoke.ts — Kelivo 双向同步的独立子进程冒烟。
// 用法：
//   bun run scripts/kelivo-sync-smoke.ts export <zipPath>
//   KELIVO_OPTIONS=conversations,assistants bun run scripts/kelivo-sync-smoke.ts import <zipPath>
//   bun run scripts/kelivo-sync-smoke.ts validate <zipPath>
// 由 backup/kelivo/roundtrip.test.ts 调用；独立进程是为了让 foundation/paths 拿到干净的
// RIKKAHUB_PC_DATA_DIR（同进程改 env 无效）。

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadState } from "../persistence/state-load";
import { flushSaveState, saveState, setState, state } from "../persistence/json-store";
import { getConversationsDb, resetConversationsDbTo } from "../conversations";
import { countConversations } from "../conversations/read-queries";
import { memoryStore } from "../memory";
import { defaultAssistant } from "../assistants/index";
import { model, provider } from "../model-providers";
import { applyAndroidZipBackupFromPath } from "../backup/import";
import { normalizeKelivoSyncOptions } from "../backup/kelivo/options";
import { createKelivoBackupZipToPath } from "../backup/kelivo/encode";
import { tempDir } from "../foundation/platform";
import { isRecord } from "../foundation/utils";

const [mode, zipPath] = process.argv.slice(2);
if (!mode || !zipPath) throw new Error("usage: kelivo-sync-smoke.ts <export|import|validate> <zip>");

function emit(payload: unknown) {
  console.log("RESULT " + JSON.stringify(payload));
}

function prepareSyntheticState() {
  const p = provider({
    id: "kelivo-test-provider",
    name: "Kelivo Test Provider",
    baseUrl: "https://example.invalid/v1",
    enabled: true,
    type: "openai",
    apiKey: "sk-test",
    builtIn: false,
  });
  p.models = [model("test-model", "Test Model")];
  state.settings.providers.push(p);
  state.settings.chatModelId = p.models[0].id;

  const assistant = {
    ...defaultAssistant(),
    id: "assistant-kelivo-test",
    name: "同步测试助手",
    systemPrompt: "你是测试助手",
    chatModelId: p.models[0].id,
    lorebookIds: ["book-test"],
    modeInjectionIds: ["inject-test"],
    quickMessageIds: ["quick-test"],
    presetMessages: [{ role: "USER", content: "预设" }],
  };
  state.settings.assistants.push(assistant);
  state.settings.assistantId = assistant.id;
  state.settings.lorebooks.push({
    id: "book-test",
    name: "测试世界书",
    description: "d",
    enabled: true,
    entries: [{
      id: "entry-test",
      name: "e",
      enabled: true,
      priority: 1,
      position: "after_system_prompt",
      role: "user",
      injectDepth: 4,
      content: "世界书内容",
      keywords: ["测试"],
      useRegex: false,
      caseSensitive: false,
      scanDepth: 4,
      constantActive: false,
    }],
  });
  state.settings.modeInjections.push({
    type: "mode",
    id: "inject-test",
    name: "测试注入",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    content: "注入内容",
    injectDepth: 4,
    role: "user",
  });
  state.settings.quickMessages.push({ id: "quick-test", title: "快捷", content: "快捷内容" });
  state.settings.searchServices.push({ id: "search-test", type: "tavily", apiKey: "tvly-test", depth: "advanced" });
  state.settings.enableWebSearch = true;
  state.settings.exportKelivoBackup = true;
  // Kelivo 兼容备份开启即锁定为逐项导出，不能让「全部数据」并行开启。
  state.settings.backupAllData = false;
  // 可选：用统一同步选项裁剪导出（KELIVO_EXPORT_SCOPE=assistants,memories）。
  // 未设置时 12 项保持默认全开。
  const scopeEnv = process.env.KELIVO_EXPORT_SCOPE;
  if (scopeEnv) {
    const enabled = new Set(scopeEnv.split(",").map((key) => key.trim()).filter(Boolean));
    for (const key of Object.keys(state.settings.backupScope)) {
      (state.settings.backupScope as unknown as Record<string, boolean>)[key] = enabled.has(key);
    }
  }
  saveState();

  const at = 1_700_000_000_000;
  resetConversationsDbTo([{
    id: "conv-kelivo-test",
    assistantId: assistant.id,
    systemPrompt: null,
    title: "测试对话",
    chatSuggestions: ["建议1"],
    isPinned: true,
    createAt: at,
    updateAt: at + 100_000,
    messages: [
      {
        id: "node-u1",
        selectIndex: 0,
        messages: [{
          id: "msg-u1",
          role: "USER",
          parts: [{ type: "text", text: "你好" }],
          annotations: [],
          createdAt: new Date(at).toISOString(),
          finishedAt: null,
          modelId: null,
          usage: null,
          translation: null,
        }],
      },
      {
        id: "node-a1",
        selectIndex: 0,
        messages: [{
          id: "msg-a1",
          role: "ASSISTANT",
          parts: [
            { type: "reasoning", reasoning: "想一想", createdAt: new Date(at + 50_000).toISOString(), finishedAt: new Date(at + 60_000).toISOString() },
            { type: "text", text: "你好，世界" },
            { type: "tool", toolCallId: "tc1", toolName: "get_time_info", input: "{}", output: [{ type: "text", text: "ok" }], approvalState: { type: "auto" } },
          ],
          annotations: [],
          createdAt: new Date(at + 50_000).toISOString(),
          finishedAt: new Date(at + 100_000).toISOString(),
          modelId: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 0, durationMs: 500 },
          translation: null,
        }],
      },
    ],
  }], []);

  memoryStore.importFlatMemories([
    { id: 0, assistantId: "__global__", content: "全局记忆内容", createdAt: at, updatedAt: at },
    { id: 0, assistantId: assistant.id, content: "助手记忆内容", createdAt: at + 1000, updatedAt: at + 1000 },
  ], "replace");
}

function unzipTo(zip: string, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 跨平台解压，与 backup/zip.ts createZipFromDirectory、backup/import.ts 的分支对称：
  // Windows 只有 PowerShell 稳（zip/unzip 不保证在 PATH，且非 ASCII 名会坏），Linux/macOS
  // 用 unzip（CI 与 NAS 容器都走这条）。此前这里无条件 spawn powershell.exe，Linux CI
  // 上直接 ENOENT，validate 模式的两个契约测试全红。
  const proc =
    process.platform === "win32"
      ? Bun.spawnSync({
          cmd: [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            [
              "Add-Type -AssemblyName System.IO.Compression.FileSystem",
              `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zip.replace(/'/g, "''")}', '${dir.replace(/'/g, "''")}')`,
            ].join("; "),
          ],
          timeout: 60_000,
        })
      : Bun.spawnSync({ cmd: ["unzip", "-q", "-o", zip, "-d", dir], timeout: 60_000 });
  if (proc.exitCode !== 0) {
    throw new Error(`unzipTo failed (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 500)}`);
  }
}

if (mode === "export") {
  setState(await loadState());
  prepareSyntheticState();
  await flushSaveState();
  const result = createKelivoBackupZipToPath(zipPath);
  emit(result);
  process.exit(0);
}

if (mode === "import") {
  setState(await loadState());
  const options = normalizeKelivoSyncOptions(process.env.KELIVO_OPTIONS ?? "");
  const summary = applyAndroidZipBackupFromPath(zipPath, options);
  await flushSaveState();
  const db = getConversationsDb();
  emit({
    summary,
    options,
    conversations: db ? countConversations(db) : -1,
    assistants: state.settings.assistants.map((assistant) => ({
      id: assistant.id,
      name: assistant.name,
      hasPrompt: assistant.systemPrompt.trim().length > 0,
      model: assistant.chatModelId,
      injections: assistant.modeInjectionIds,
      lorebooks: assistant.lorebookIds,
      quick: assistant.quickMessageIds,
    })),
    providers: state.settings.providers
      .filter((item) => item.id.startsWith("kelivo:"))
      .map((item) => ({ name: item.name, models: item.models.map((entry) => entry.modelId), apiKey: item.apiKey })),
    lorebooks: state.settings.lorebooks.flatMap((item) => (isRecord(item) ? [String(item.id)] : [])),
    injections: state.settings.modeInjections.flatMap((item) => (isRecord(item) ? [String(item.id)] : [])),
    quickMessages: state.settings.quickMessages.flatMap((item) => (isRecord(item) ? [String(item.id)] : [])),
    searchTypes: state.settings.searchServices.flatMap((item) => (isRecord(item) ? [String(item.type)] : [])),
    selectedModel: state.settings.chatModelId,
    memories: memoryStore.exportFlat().map((memory) => [memory.assistantId, memory.content]),
  });
  process.exit(0);
}

if (mode === "validate") {
  const extractDir = join(tempDir(), `kelivo-validate-${Date.now()}`);
  try {
    unzipTo(zipPath, extractDir);
    const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf-8"));
    const entries: Record<string, { bytes: number; sha256: string }> = manifest.entries ?? {};
    const hashes: Record<string, boolean> = {};
    for (const [name, meta] of Object.entries(entries)) {
      const bytes = readFileSync(join(extractDir, name));
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      hashes[name] = bytes.length === meta.bytes && digest === meta.sha256;
    }
    const settingsJson = JSON.parse(readFileSync(join(extractDir, "settings.json"), "utf-8"));
    const entityKeys = [
      "assistants_v1", "provider_configs_v1", "provider_groups_v1", "mcp_servers_v1",
      "world_books_v1", "assistant_memories_v1", "quick_phrases_v1", "search_services_v1",
      "tts_services_v1", "instruction_injections_v1", "assistant_tags_v1", "memory_entries_v1",
      "workspaces_v1", "skills_v1", "user_profile_fields_v1",
    ];
    const entitiesAreStrings = Object.fromEntries(entityKeys.map((key) => [key, typeof settingsJson[key] === "string"]));
    const parsedEntities = Object.fromEntries(entityKeys.map((key) => {
      try { return [key, JSON.parse(settingsJson[key])]; } catch { return [key, null]; }
    }));
    const db = new Database(join(extractDir, "database", "kelivo.db"), { readonly: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      const counts = {
        assistants: (db.query("SELECT count(*) c FROM assistant_rows").get() as { c: number }).c,
        providers: (db.query("SELECT count(*) c FROM provider_rows").get() as { c: number }).c,
        conversations: (db.query("SELECT count(*) c FROM conversation_rows").get() as { c: number }).c,
        messages: (db.query("SELECT count(*) c FROM message_rows").get() as { c: number }).c,
        parts: (db.query("SELECT count(*) c FROM message_part_rows").get() as { c: number }).c,
        memories: (db.query("SELECT count(*) c FROM memory_entry_rows").get() as { c: number }).c,
        worldBooks: (db.query("SELECT count(*) c FROM world_book_rows").get() as { c: number }).c,
        injections: (db.query("SELECT count(*) c FROM instruction_injection_rows").get() as { c: number }).c,
        quick: (db.query("SELECT count(*) c FROM quick_phrase_rows").get() as { c: number }).c,
        search: (db.query("SELECT count(*) c FROM search_service_rows").get() as { c: number }).c,
      };
      emit({
        manifest: {
          format: manifest.format,
          formatVersion: manifest.formatVersion,
          payloadKind: manifest.payloadKind,
          includeChats: manifest.includeChats,
          includeFiles: manifest.includeFiles,
          secretsIncluded: manifest.secretsIncluded,
          scopeKeys: Object.keys(manifest.scope ?? {}).sort(),
          scope: manifest.scope,
          database: manifest.database,
        },
        hashes,
        tables: tables.map((row) => row.name).sort(),
        userVersion: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
        integrity: (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
        foreignKeyIssues: (db.query("PRAGMA foreign_key_check").all()).length,
        counts,
        entitiesAreStrings,
        entityLengths: Object.fromEntries(entityKeys.map((key) => [key, Array.isArray(parsedEntities[key]) ? parsedEntities[key].length : Object.keys(parsedEntities[key] ?? {}).length])),
        preferences: {
          selectedModel: settingsJson.selected_model_v1,
          searchSelected: settingsJson.search_selected_v1,
          searchEnabled: settingsJson.search_enabled_v1,
          instructionsMap: settingsJson.instruction_injections_active_ids_by_assistant_v1,
          worldBooksMap: settingsJson.world_books_active_ids_by_assistant_v1,
        },
        firstAssistant: parsedEntities.assistants_v1?.find((item: { name?: string }) => item.name === "同步测试助手") ?? null,
        firstProvider: parsedEntities.provider_configs_v1?.["kelivo-test-provider"] ?? null,
      });
    } finally {
      db.close(true);
    }
  } finally {
    try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  process.exit(0);
}

throw new Error(`unknown mode ${mode}`);