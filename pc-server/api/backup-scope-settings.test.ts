// api/backup-scope-settings.test.ts — settings/backup-scope 的字段级持久化锁。
// 同步选项的十二个开关必须按布尔落库;非布尔值/未知键都不得覆盖现值(前端乐观更新回滚
// 与老客户端部分调用都走这条合并语义)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-backup-scope-test-"));

import type { State } from "../foundation/types";
import { normalizeState } from "../persistence/state-load";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function post(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/backup-scope");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/backup-scope");
}

async function postKelivo(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/kelivo-sync");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/kelivo-sync");
}

beforeAll(() => {
  setState({
    settings: {
      // 下面主要是逐项开关的合并语义；「全部数据」模式单独在末尾的 describe 覆盖。
      backupAllData: false,
      backupScope: {
        conversations: true,
        assistants: true,
        memories: true,
        models: true,
        worldBooks: true,
        promptInjections: true,
        quickMessages: true,
        searchServices: true,
        attachments: true,
        skills: true,
        fonts: true,
        globalAgents: true,
      },
    },
  } as unknown as State);
});

describe("settings/backup-scope 持久化", () => {
  test("按字段合并,未提交的开关保持", async () => {
    const res = await post({ scope: { attachments: false, fonts: false } });
    expect(res?.status).toBe(200);
    expect(state.settings.backupScope.attachments).toBe(false);
    expect(state.settings.backupScope.fonts).toBe(false);
    expect(state.settings.backupScope.conversations).toBe(true);
    expect(state.settings.backupScope.skills).toBe(true);
    expect(state.settings.backupScope.globalAgents).toBe(true);
  });

  test("非布尔值与未知键被忽略,不覆盖现值也不新增键", async () => {
    await post({ scope: { conversations: 0, skills: "false", nope: true } });
    expect(state.settings.backupScope.conversations).toBe(true);
    expect(state.settings.backupScope.skills).toBe(true);
    expect(Object.keys(state.settings.backupScope)).toHaveLength(12);
  });

  test("实体开关同步派生 Kelivo 导入范围(同一份选择,不再两处各存)", async () => {
    await post({ scope: { models: false } });
    expect(state.settings.kelivoSyncOptions.models).toBe(false);
    expect(state.settings.kelivoSyncOptions.conversations).toBe(true);
    await post({ scope: { models: true } });
    expect(state.settings.kelivoSyncOptions.models).toBe(true);
  });

  test("scope 缺省时整组不动", async () => {
    await post({});
    expect(state.settings.backupScope).toEqual({
      conversations: true,
      assistants: true,
      memories: true,
      models: true,
      worldBooks: true,
      promptInjections: true,
      quickMessages: true,
      searchServices: true,
      attachments: false,
      skills: true,
      fonts: false,
      globalAgents: true,
    });
  });
});

describe("「全部数据」备份模式", () => {
  test("allData 独立落库，不依赖逐项开关，也不改写逐项选择", async () => {
    await post({ scope: { models: false } });
    await post({ allData: true });
    expect(state.settings.backupAllData).toBe(true);
    expect(state.settings.backupScope.models).toBe(false);
    // 模式开关走独立字段，不会把 12 项偷偷勾满
    expect(state.settings.backupScope.attachments).toBe(false);
    await post({ allData: false });
    expect(state.settings.backupAllData).toBe(false);
    expect(state.settings.backupScope.models).toBe(false);
  });

  test("全部数据模式派生 Kelivo 视图全开，关闭后回到逐项选择", async () => {
    await post({ allData: false });
    await post({ scope: { models: false, memories: false } });
    expect(state.settings.kelivoSyncOptions.models).toBe(false);
    expect(state.settings.kelivoSyncOptions.memories).toBe(false);
    await post({ allData: true });
    expect(state.settings.kelivoSyncOptions.models).toBe(true);
    expect(state.settings.kelivoSyncOptions.memories).toBe(true);
    await post({ allData: false });
    expect(state.settings.kelivoSyncOptions.models).toBe(false);
    expect(state.settings.kelivoSyncOptions.memories).toBe(false);
    await post({ scope: { models: true, memories: true } });
  });

  test("非布尔 allData 被忽略，模式保持现值", async () => {
    await post({ allData: false });
    await post({ allData: "true" });
    expect(state.settings.backupAllData).toBe(false);
    await post({ allData: 1 });
    expect(state.settings.backupAllData).toBe(false);
  });
});

describe("Kelivo 兼容备份与「全部数据」互锁", () => {
  test("Kelivo 兼容备份默认关闭；全量模式默认开启", () => {
    const fresh = normalizeState({ settings: {} as never });
    expect(fresh.settings.exportKelivoBackup).toBe(false);
    expect(fresh.settings.backupAllData).toBe(true);
  });

  test("老 state 里 Kelivo 为开时，加载即锁定为逐项模式", () => {
    const restored = normalizeState({
      settings: { exportKelivoBackup: true, backupAllData: true } as never,
    });
    expect(restored.settings.exportKelivoBackup).toBe(true);
    expect(restored.settings.backupAllData).toBe(false);
  });

  test("开启 Kelivo 兼容备份会关闭并锁住全部数据，关闭后才解锁", async () => {
    setState({
      settings: {
        exportKelivoBackup: false,
        backupAllData: true,
        backupScope: {
          conversations: true,
          assistants: true,
          memories: true,
          models: true,
          worldBooks: true,
          promptInjections: true,
          quickMessages: true,
          searchServices: true,
          attachments: true,
          skills: true,
          fonts: true,
          globalAgents: true,
        },
        kelivoSyncOptions: {
          conversations: true,
          assistants: true,
          memories: true,
          models: true,
          worldBooks: true,
          promptInjections: true,
          quickMessages: true,
          searchServices: true,
        },
      },
    } as unknown as State);

    const enabled = await postKelivo({ exportKelivoBackup: true });
    expect(enabled?.status).toBe(200);
    expect(state.settings.exportKelivoBackup).toBe(true);
    expect(state.settings.backupAllData).toBe(false);

    const denied = await post({ allData: true });
    expect(denied?.status).toBe(400);
    expect(state.settings.backupAllData).toBe(false);

    await postKelivo({ exportKelivoBackup: false });
    const unlocked = await post({ allData: true });
    expect(unlocked?.status).toBe(200);
    expect(state.settings.backupAllData).toBe(true);
  });
});
