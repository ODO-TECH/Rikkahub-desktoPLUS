// api/kelivo-sync-settings.test.ts — settings/kelivo-sync 的字段级持久化锁。
// 开关与 8 项同步范围都必须在布尔值时落库；非布尔值/缺省键不得覆盖现值。

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-kelivo-settings-test-"));

import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function post(body: Record<string, unknown>): Promise<Response | null> {
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
      exportKelivoBackup: true,
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
});

describe("settings/kelivo-sync 持久化", () => {
  test("开关可关闭并可重新打开", async () => {
    expect((await post({ exportKelivoBackup: false }))?.status).toBe(200);
    expect(state.settings.exportKelivoBackup).toBe(false);
    await post({ exportKelivoBackup: true });
    expect(state.settings.exportKelivoBackup).toBe(true);
  });

  test("同步范围按字段合并，缺省项保持", async () => {
    await post({ options: { models: false, worldBooks: false } });
    expect(state.settings.kelivoSyncOptions.models).toBe(false);
    expect(state.settings.kelivoSyncOptions.worldBooks).toBe(false);
    expect(state.settings.kelivoSyncOptions.conversations).toBe(true);
    expect(state.settings.kelivoSyncOptions.searchServices).toBe(true);
  });

  test("非布尔值被忽略，不覆盖现值", async () => {
    await post({ exportKelivoBackup: "yes", options: { conversations: 0, memories: "false" } });
    expect(state.settings.exportKelivoBackup).toBe(true);
    expect(state.settings.kelivoSyncOptions.conversations).toBe(true);
    expect(state.settings.kelivoSyncOptions.memories).toBe(true);
  });
});