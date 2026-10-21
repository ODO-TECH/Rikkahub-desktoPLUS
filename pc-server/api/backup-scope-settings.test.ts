// api/backup-scope-settings.test.ts — settings/backup-scope 的字段级持久化锁。
// 同步选项的十二个开关必须按布尔落库;非布尔值/未知键都不得覆盖现值(前端乐观更新回滚
// 与老客户端部分调用都走这条合并语义)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-backup-scope-test-"));

import type { State } from "../foundation/types";
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

beforeAll(() => {
  setState({
    settings: {
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
