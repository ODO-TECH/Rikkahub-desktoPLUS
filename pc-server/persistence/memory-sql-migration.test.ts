// persistence/memory-sql-migration.test.ts — 旧记忆 JSON 一次性灌库的行为锁。
// 纪律：首次启动迁移后库为权威源；再次启动从库读，JSON 快照里的旧内容不得复活已删记忆。
// 用独立子进程跑真实启动路径（paths 模块会缓存数据目录，同进程内改 env 无效）。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "rkh-mem-migrate-"));
mkdirSync(join(dataDir, "memory"), { recursive: true });
writeFileSync(join(dataDir, "memory", "global_memory.json"), JSON.stringify({
  version: 1,
  nextMemoryId: 2,
  memories: [{ id: 1, content: "全局旧记忆", createdAt: 10, updatedAt: 11, source: "manual" }],
}));
writeFileSync(join(dataDir, "memory", "assistant_memory.json"), JSON.stringify({
  version: 1,
  assistants: [{ assistantId: "a1", assistantName: "旧助手", memories: [{ id: 2, content: "助手旧记忆", createdAt: 12, updatedAt: 13, source: "ai" }] }],
}));
writeFileSync(join(dataDir, "memory", "pending_memory.json"), JSON.stringify({ version: 1, pending: [] }));

describe("记忆 JSON → SQLite 迁移", () => {
  test("首次启动灌库并标记；清空后重启不复活旧 JSON", async () => {
    const script = join(import.meta.dir, "..", "scripts", "memory-sql-migration-smoke.ts");
    const proc = Bun.spawn([process.execPath, "run", script], {
      env: { ...process.env, RIKKAHUB_PC_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`smoke exited ${exitCode}\n${stderr}\n${stdout}`);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("SMOKE "));
    if (!line) throw new Error(`no SMOKE output\n${stderr}\n${stdout}`);
    const result = JSON.parse(line.slice("SMOKE ".length)) as {
      first: { ready: boolean; rows: string[][]; global: string[]; assistant: string[] };
      second: { rows: number; global: number; assistant: number };
    };

    expect(result.first.ready).toBe(true);
    expect(result.first.rows).toEqual([
      ["__global__", "全局旧记忆", "manual"],
      ["a1", "助手旧记忆", "ai"],
    ]);
    expect(result.first.global).toEqual(["全局旧记忆"]);
    expect(result.first.assistant).toEqual(["助手旧记忆"]);
    expect(result.second).toEqual({ rows: 0, global: 0, assistant: 0 });
  }, 30000);
});
