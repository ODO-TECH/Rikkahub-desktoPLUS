// 9-1/6-3 回归:记忆文件损坏时隔离原件而非留在原地等着被空数据覆写。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryStore } from "./index";

describe("记忆损坏隔离(6-3)", () => {
  test("解析失败 → 返回 fallback,原件改名 .corrupt-<ts> 保住字节", () => {
    const dir = mkdtempSync(join(tmpdir(), "rikka-mem-"));
    try {
      const filePath = join(dir, "global_memory.json");
      writeFileSync(filePath, "{broken json!!");
      const result = memoryStore.readFile(filePath, { memories: [] as unknown[] });
      expect(result).toEqual({ memories: [] });
      const quarantined = readdirSync(dir).filter((name) => name.startsWith("global_memory.json.corrupt-"));
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(dir, quarantined[0]!), "utf8")).toBe("{broken json!!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件缺失 → 直接 fallback,不产生隔离文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "rikka-mem-"));
    try {
      const result = memoryStore.readFile(join(dir, "missing.json"), { ok: true });
      expect(result).toEqual({ ok: true });
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
