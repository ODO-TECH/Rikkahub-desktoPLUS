// 1-4 回归:启动清扫 state.json.*.tmp 残留(每个都是含全部 apiKey 的完整 state 副本)。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sweepStaleStateTempFilesIn } from "./json-store";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "rikka-tmp-sweep-"));
}

function writeAged(path: string, ageMs: number): void {
  writeFileSync(path, "{}");
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

describe("sweepStaleStateTempFilesIn(1-4)", () => {
  test("清扫三种命名的陈旧 .tmp,保留 state.json 本体与备份", () => {
    const dir = makeDir();
    try {
      const hourOld = 60 * 60 * 1000;
      writeAged(join(dir, "state.json.1234.1700000000000.0.tmp"), hourOld);
      writeAged(join(dir, "state.json.migrate.1234.1700000000000.tmp"), hourOld);
      writeAged(join(dir, "state.json.mem-migrate.1234.1700000000000.tmp"), hourOld);
      writeAged(join(dir, "state.json.pre-sqlite.bak.1234.tmp"), hourOld);
      writeFileSync(join(dir, "state.json"), "{}");
      writeFileSync(join(dir, "state.json.daily.bak"), "{}");
      writeFileSync(join(dir, "other.tmp"), "{}");

      const removed = sweepStaleStateTempFilesIn(dir, "state.json");

      expect(removed).toBe(4);
      expect(existsSync(join(dir, "state.json"))).toBe(true);
      expect(existsSync(join(dir, "state.json.daily.bak"))).toBe(true);
      expect(existsSync(join(dir, "other.tmp"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("年龄护栏:10 分钟内的新 .tmp 不清(可能是并发实例正在写)", () => {
    const dir = makeDir();
    try {
      writeAged(join(dir, "state.json.9999.1700000000000.0.tmp"), 1000);
      const removed = sweepStaleStateTempFilesIn(dir, "state.json");
      expect(removed).toBe(0);
      expect(existsSync(join(dir, "state.json.9999.1700000000000.0.tmp"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("目录不存在时静默返回 0", () => {
    expect(sweepStaleStateTempFilesIn(join(tmpdir(), "rikka-not-exist-xyz"), "state.json")).toBe(0);
  });
});
