// backup/android-import-settings.test.ts — D3 回归:安卓设置导入必须保 PC-only 配置
//
// 背景:`...app` 浅合并 + normalizeState 的默认回填会静默冲掉 PC 的本机配置——
// chatAutoCompact 回 false、memorySettings 被 M1 推断覆盖、备份范围回默认;
// 手改/旧格式 zip 还能直接夹带 webPasswordHash / sshDevices 等敏感值。
// 现在统一由 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT 清单接管:
//   1) defaultSettings() 的每个顶层键必须显式分类(PC-only 或安卓共享),漏登记即红;
//   2) 所有 PC-only 键写入非默认哨兵值,安卓 settings 带着冲突值导入后逐字段不变;
//   3) 安卓导出仍剥离敏感/机器级字段,同时保留 APP 靠 ignoreUnknownKeys 无视的 PC 独占键。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-android-import-settings-"));
const zipRoot = mkdtempSync(join(tmpdir(), "rkh-android-import-settings-zip-"));

const jsonStore = await import("../persistence/json-store");
const { defaultSettings } = await import("../app-config/defaults");
const { normalizeState } = await import("../persistence/state-load");
const { defaultImAccess } = await import("../foundation/types/settings/im-access");
const { defaultSubagentConfig } = await import("../foundation/types/settings/subagent-config");
const {
  PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT,
  applyAndroidZipBackupFromPath,
} = await import("./import");
const { PC_AVATAR_TYPE_TO_ANDROID, PC_ONLY_DISPLAY_SETTING_FIELDS, rewriteAvatarsInSettings } = await import("./export");

import type { Settings } from "../foundation/types/settings";

const priorState = jsonStore.state;
afterAll(() => {
  jsonStore.setState(priorState);
  for (const dir of [zipRoot, process.env.RIKKAHUB_PC_DATA_DIR!]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未尽 */ }
  }
});

/** 安卓 settings 完整拥有的顶层键。与 PC-only 清单互为补集——新增 Settings 字段时
 *  必须在这里或 PC-only 清单里二选一,否则下方的分类测试报错。 */
const ANDROID_SHARED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "dynamicColor", "themeId", "developerMode", "displaySetting",
  "enableWebSearch", "favoriteModels",
  "chatModelId", "fastModelId", "enableSuggestion",
  "translateModeId", "translateThinkingBudget",
  "imageGenerationModelId", "ocrModelId", "compressModelId",
  "titlePrompt", "translatePrompt", "suggestionPrompt", "ocrPrompt", "compressPrompt",
  "asrProviders", "selectedASRProviderId", "ttsProviders", "selectedTTSProviderId",
  "mediaGenerationProviders", "uploadS3Config",
  "assistantId", "providers", "assistants", "assistantTags",
  "searchServices", "searchCommonOptions", "searchServiceSelected",
  "mcpServers", "modeInjections", "lorebooks", "quickMessages",
  "webDavConfig", "s3Config",
]);

// ── 最小 stored zip 构造器(仅测试用;readZipEntries/PowerShell 都不校验 CRC) ─────────
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += 30 + nameBuf.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function pcSentinelSettings(): Settings {
  const settings = defaultSettings();
  settings.proxyConfig = { mode: "manual", url: "http://127.0.0.1:7890", username: "pc-proxy-user", password: "pc-proxy-pass", bypassRules: "localhost" };
  settings.webServerJwtEnabled = true;
  settings.preferredPort = 18099;
  settings.sandboxRestricted = true;
  settings.workspaceLastPermissionPreset = "full_access";
  settings.keybindings = { ...settings.keybindings, newConversation: { keys: ["Ctrl", "Shift", "K"], enabled: false } };
  settings.webPasswordHash = "pc-hash-sentinel";
  settings.shellPath = "C:\\pc-tools\\bash.exe";
  settings.chatAutoCompact = true;
  settings.titleGenerationEnabled = false;
  settings.promptOptimizeModelId = "pc-prompt-optimize-model";
  settings.promptOptimizePrompt = "PC 专属提示词优化指令 <!-- sentinel -->";
  settings.embeddingModelId = "pc-embedding-model";
  settings.rerankModelId = "pc-rerank-model";
  settings.memoryModelId = "pc-memory-model";
  settings.mediaPromptRewriteModelId = "pc-media-rewrite-model";
  settings.defaultMediaImageModel = { providerId: "pc-media-provider", modelId: "pc-image" };
  settings.defaultMediaVideoModel = { providerId: "pc-media-provider", modelId: "pc-video" };
  settings.memorySettings = {
    globalEnabled: false,
    writeStrategy: "readonly",
    dedupEnabled: false,
    memoryModelThinkingEnabled: true,
  };
  settings.memoryVectorSettings = {
    enabled: true,
    autoIndex: true,
    topK: 50,
    minMemories: 0,
    expandNeighbors: true,
    rerankEnabled: true,
    rerankTopN: 100,
  };
  settings.subagent = {
    enabled: true,
    maxConcurrency: 5,
    maxTasksPerCall: 10,
    tokenBudget: 500_000,
    allowedTools: ["read", "bash"],
  };
  settings.sshDevices = [{
    id: "pc-ssh-device",
    name: "PC 编译机",
    host: "10.0.0.5",
    port: 22,
    username: "pc-root",
    authType: "password",
    password: "pc-ssh-password",
    privateKey: "",
    passphrase: "",
    hostKey: null,
    dirs: [],
  }];
  const imAccess = defaultImAccess();
  imAccess.qq.enabled = true;
  imAccess.qq.appId = "pc-qq-app-id";
  imAccess.qq.appSecret = "pc-qq-app-secret";
  imAccess.pairing.code = "PC-ONLY-CODE";
  settings.imAccess = imAccess;
  settings.exportKelivoBackup = true;
  settings.backupAllData = false;
  settings.backupScope = {
    ...settings.backupScope,
    conversations: false,
    models: false,
    attachments: false,
  };
  // displaySetting 的 PC-only 子项同样用哨兵值。
  settings.displaySetting = {
    ...settings.displaySetting,
    chatFontFamilyCss: "pc-css-sentinel",
    uiFontSize: 1.2,
    chatInputHeight: 320,
    pcPasteLongTextAsFile: true,
    pcPasteLongTextThreshold: 4321,
    themeMode: "dark",
    collapseAllSteps: true,
  };
  settings.dismissedProviderIds = ["pc-dismissed-provider"];
  settings.dismissedAssistantIds = ["pc-dismissed-assistant"];
  settings.dismissedSearchServiceTypes = ["pc-dismissed-search"];
  return settings;
}

const androidDefaults = defaultSubagentConfig();

function androidConflictPayload(): Record<string, unknown> {
  const imAccess = defaultImAccess();
  imAccess.qq.enabled = true;
  imAccess.qq.appId = "android-qq-app-id";
  imAccess.qq.appSecret = "android-qq-app-secret";
  return {
    // 共享字段:用于证明合并仍在工作(PC 出厂默认 → 采纳 APP)。
    themeId: "android-theme",
    enableSuggestion: false,
    // 共享显示项采纳 APP;PC-only 显示项即便夹带也不接管。
    displaySetting: {
      showDateTimeInMessage: true,
      chatFontFamilyCss: "android-injected-css",
      uiFontSize: 0.8,
      chatInputHeight: 120,
      pcPasteLongTextAsFile: false,
      pcPasteLongTextThreshold: 100,
      themeMode: "light",
      collapseAllSteps: false,
    },
    // 以下全部是 PC-only 键的冲突值:导入后必须一个都看不到。
    proxyConfig: { mode: "direct", url: "http://android.invalid:1", username: "android", password: "android", bypassRules: "" },
    webServerJwtEnabled: false,
    preferredPort: 19999,
    sandboxRestricted: false,
    workspaceLastPermissionPreset: "balanced",
    keybindings: {},
    webPasswordHash: "android-injected-hash",
    shellPath: "C:\\android-injected\\bash.exe",
    chatAutoCompact: false,
    titleGenerationEnabled: true,
    promptOptimizeModelId: "android-prompt-optimize-model",
    promptOptimizePrompt: "android injected prompt",
    embeddingModelId: "android-embedding-model",
    rerankModelId: "android-rerank-model",
    memoryModelId: "android-memory-model",
    mediaPromptRewriteModelId: "android-media-rewrite-model",
    defaultMediaImageModel: { providerId: "android-provider", modelId: "android-image" },
    defaultMediaVideoModel: { providerId: "android-provider", modelId: "android-video" },
    memorySettings: { globalEnabled: true, writeStrategy: "always_global", dedupEnabled: true, memoryModelThinkingEnabled: false },
    memoryVectorSettings: { enabled: false, autoIndex: false, topK: 5, minMemories: 200, expandNeighbors: false, rerankEnabled: false, rerankTopN: 10 },
    subagent: { ...androidDefaults, enabled: false, maxConcurrency: 1, maxTasksPerCall: 1, tokenBudget: 16_000 },
    sshDevices: [{
      id: "android-ssh-device",
      name: "Android 设备",
      host: "10.0.0.6",
      port: 22,
      username: "android-root",
      authType: "password",
      password: "android-ssh-password",
      privateKey: "",
      passphrase: "",
      hostKey: null,
      dirs: [],
    }],
    imAccess,
    exportKelivoBackup: false,
    kelivoSyncOptions: {
      conversations: true, assistants: true, memories: true, models: true,
      worldBooks: true, promptInjections: true, quickMessages: true, searchServices: true,
    },
    backupAllData: true,
    backupScope: {
      conversations: true, assistants: true, memories: true, models: true,
      worldBooks: true, promptInjections: true, quickMessages: true, searchServices: true,
      attachments: true, skills: true, fonts: true, globalAgents: true,
    },
    dismissedProviderIds: ["android-dismissed-provider"],
    dismissedAssistantIds: ["android-dismissed-assistant"],
    dismissedSearchServiceTypes: ["android-dismissed-search"],
  };
}

describe("安卓导入的 PC-only 保留清单", () => {
  test("defaultSettings 的每个顶层键都必须二选一分类", () => {
    const pcOnly = new Set<string>(PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT);
    for (const key of Object.keys(defaultSettings())) {
      expect(
        pcOnly.has(key) || ANDROID_SHARED_SETTINGS_KEYS.has(key),
        `设置字段 "${key}" 未分类:安卓共享 → 加入 ANDROID_SHARED_SETTINGS_KEYS;PC-only → 加入 PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT。二选一,不许不选。`,
      ).toBe(true);
    }
    for (const key of pcOnly) {
      expect(ANDROID_SHARED_SETTINGS_KEYS.has(key), `"${key}" 同时出现在 PC-only 与安卓共享清单`).toBe(false);
    }
    // 可选字段不在 defaultSettings 里,单独钉住它们仍属于 PC-only。
    expect(pcOnly.has("webPasswordHash")).toBe(true);
  });

  test("所有 PC-only 哨兵值经安卓 settings 导入逐字段不变(APP 夹带冲突值也不接管)", () => {
    jsonStore.setState(normalizeState({ settings: pcSentinelSettings() }));
    const pcBefore = structuredClone(jsonStore.state.settings);

    const zipPath = join(zipRoot, "android-backup.zip");
    writeFileSync(
      zipPath,
      buildStoredZip([{ name: "settings.json", data: Buffer.from(JSON.stringify(androidConflictPayload()), "utf8") }]),
    );
    const result = applyAndroidZipBackupFromPath(zipPath);
    expect(result.settingsImported).toBe(true);

    const after = jsonStore.state.settings as unknown as Record<string, unknown>;
    const before = pcBefore as unknown as Record<string, unknown>;
    for (const key of PC_ONLY_SETTINGS_PRESERVED_ON_ANDROID_IMPORT) {
      expect(after[key], `PC-only 字段 "${key}" 被安卓导入覆盖`).toEqual(before[key]);
    }
    // PC-only 显示项同样不被 APP 夹带值覆盖;共享显示项照常采纳 APP。
    const display = after.displaySetting as Record<string, unknown>;
    for (const field of PC_ONLY_DISPLAY_SETTING_FIELDS) {
      expect(display[field], `PC-only 显示项 "${field}" 被安卓导入覆盖`).toEqual(
        (before.displaySetting as Record<string, unknown>)[field],
      );
    }
    expect(display.showDateTimeInMessage).toBe(true);
    // 共享字段合并仍按七层策略工作。
    expect(after.themeId).toBe("android-theme");
    expect(after.enableSuggestion).toBe(false);
    // 敏感值没有从 APP 侧漏进来。
    expect(JSON.stringify(after)).not.toContain("android-injected-hash");
    expect(JSON.stringify(after)).not.toContain("android-ssh-password");
    expect(JSON.stringify(after)).not.toContain("android-qq-app-secret");
  }, 30_000);

  test("安卓导出仍剥离敏感/机器级字段,APP 可忽略的 PC 独占键按契约透传", () => {
    jsonStore.setState(normalizeState({ settings: pcSentinelSettings() }));
    const exported = rewriteAvatarsInSettings(
      structuredClone(jsonStore.state.settings),
      PC_AVATAR_TYPE_TO_ANDROID,
      "to-android",
    ) as Record<string, unknown>;
    for (const key of [
      "proxyConfig", "preferredPort", "sandboxRestricted", "subagent", "keybindings",
      "webPasswordHash", "sshDevices", "imAccess", "shellPath",
      "exportKelivoBackup", "kelivoSyncOptions", "backupScope", "backupAllData",
    ]) {
      expect(key in exported, `安卓导出未剥离敏感/机器级字段 "${key}"`).toBe(false);
    }
    const display = exported.displaySetting as Record<string, unknown>;
    for (const field of PC_ONLY_DISPLAY_SETTING_FIELDS) {
      expect(field in display, `安卓导出未剥离 PC-only 显示项 "${field}"`).toBe(false);
    }
    // 非敏感、APP 靠 ignoreUnknownKeys 无视的 PC 独占键保留跨端往返(与既有契约一致)。
    expect(exported.chatAutoCompact).toBe(true);
    expect(exported.embeddingModelId).toBe("pc-embedding-model");
    expect(exported.memorySettings).toEqual({
      globalEnabled: false,
      writeStrategy: "readonly",
      dedupEnabled: false,
      memoryModelThinkingEnabled: true,
    });
  });
});
