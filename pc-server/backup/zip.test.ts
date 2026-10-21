// backup/zip.ts 单元测试(专题3 Z-1)。
// 锁死三件事:
// 1. createZipFromDirectory 产物条目名永远是正斜杠(安卓端按 "upload/" 前缀匹配,
//    反斜杠 = 附件/skills/fonts 全部静默丢失);
// 2. normalizeZipEntrySeparators 能把 PowerShell 风格的反斜杠条目名原地修好
//    (中央目录与 local header 成对),修完仍可被导入链解析;
// 3. 解析器 zip64 感知(多 GB 备份的 EOCD/offset 占位符走 64 位真值)。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readZipEntries } from "../files/index";
import { createZipFromDirectory, listZipEntryNames, normalizeZipEntrySeparators } from "./zip";

function makeStage(): string {
  const stage = mkdtempSync(join(tmpdir(), "zip-test-stage-"));
  writeFileSync(join(stage, "settings.json"), '{"a":1}');
  mkdirSync(join(stage, "upload", "nested"), { recursive: true });
  writeFileSync(join(stage, "upload", "图 片.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(stage, "upload", "nested", "b.txt"), "deep");
  return stage;
}

// ── 最小 zip 构造器(仅测试用):可指定反斜杠条目名与 zip64 布局 ────────────────
function buildZipFile(path: string, entries: { name: string; data: Buffer }[], opts?: { zip64?: boolean }): void {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  const localOffsets: number[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, entry.data);
    localOffsets.push(offset);
    offset += 30 + nameBuf.length + entry.data.length;
  }
  entries.forEach((entry, i) => {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const zip64Extra = opts?.zip64
      ? (() => {
          const extra = Buffer.alloc(12);
          extra.writeUInt16LE(0x0001, 0);
          extra.writeUInt16LE(8, 2);
          extra.writeBigUInt64LE(BigInt(localOffsets[i]), 4);
          return extra;
        })()
      : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(zip64Extra.length, 30);
    central.writeUInt32LE(opts?.zip64 ? 0xffffffff : localOffsets[i], 42);
    centralChunks.push(central, nameBuf, zip64Extra);
  });
  const centralDir = Buffer.concat(centralChunks);
  const tail: Buffer[] = [];
  if (opts?.zip64) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4); // size of remaining record
    eocd64.writeBigUInt64LE(BigInt(entries.length), 24);
    eocd64.writeBigUInt64LE(BigInt(entries.length), 32);
    eocd64.writeBigUInt64LE(BigInt(centralDir.length), 40);
    eocd64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + centralDir.length), 8);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    tail.push(eocd64, locator, eocd);
  } else {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    tail.push(eocd);
  }
  writeFileSync(path, Buffer.concat([...localChunks, centralDir, ...tail]));
}

describe("createZipFromDirectory(Z-1 载体契约)", () => {
  test("产物条目名全部正斜杠、无 ./ 前缀,upload/ 前缀可被安卓式匹配命中,内容完整", () => {
    const stage = makeStage();
    const zipPath = join(mkdtempSync(join(tmpdir(), "zip-test-out-")), "backup.zip");
    try {
      createZipFromDirectory(stage, zipPath, 60_000);
      const names = listZipEntryNames(zipPath);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name).not.toContain("\\");
        expect(name.startsWith("./")).toBe(false);
      }
      // 安卓 WebDavSync/本地恢复的匹配方式:zipEntry.name.startsWith("upload/")
      const uploadFiles = names.filter((n) => n.startsWith("upload/") && !n.endsWith("/"));
      expect(uploadFiles.sort()).toEqual(["upload/nested/b.txt", "upload/图 片.png"]);
      const entries = readZipEntries(Buffer.from(require("node:fs").readFileSync(zipPath)));
      const deep = entries.find((e) => e.name === "upload/nested/b.txt");
      expect(deep?.data.toString()).toBe("deep");
      const settings = entries.find((e) => e.name === "settings.json");
      expect(settings?.data.toString()).toBe('{"a":1}');
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(join(zipPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("normalizeZipEntrySeparators", () => {
  test("反斜杠条目名被成对修补(中央目录+local header),数据仍可解出", () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-test-norm-"));
    const zipPath = join(dir, "bad.zip");
    try {
      buildZipFile(zipPath, [
        { name: "settings.json", data: Buffer.from("{}") },
        { name: "upload\\a.txt", data: Buffer.from("hello") },
        { name: "upload\\nested\\b.txt", data: Buffer.from("deep") },
      ]);
      expect(normalizeZipEntrySeparators(zipPath)).toBe(2);
      const names = listZipEntryNames(zipPath);
      expect(names).toEqual(["settings.json", "upload/a.txt", "upload/nested/b.txt"]);
      const entries = readZipEntries(Buffer.from(require("node:fs").readFileSync(zipPath)));
      expect(entries.find((e) => e.name === "upload/a.txt")?.data.toString()).toBe("hello");
      expect(entries.find((e) => e.name === "upload/nested/b.txt")?.data.toString()).toBe("deep");
      // 幂等:再跑一次无事发生
      expect(normalizeZipEntrySeparators(zipPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")("真实 PowerShell CreateFromDirectory 产物可被归一化并解析", () => {
    const stage = makeStage();
    const dir = mkdtempSync(join(tmpdir(), "zip-test-ps-"));
    const zipPath = join(dir, "ps.zip");
    try {
      const script = [
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}')`,
      ].join("; ");
      const proc = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
      expect(proc.exitCode).toBe(0);
      normalizeZipEntrySeparators(zipPath);
      const names = listZipEntryNames(zipPath);
      for (const name of names) expect(name).not.toContain("\\");
      expect(names.filter((n) => n.startsWith("upload/") && !n.endsWith("/")).sort()).toEqual([
        "upload/nested/b.txt",
        "upload/图 片.png",
      ]);
      const entries = readZipEntries(Buffer.from(require("node:fs").readFileSync(zipPath)));
      expect(entries.find((e) => e.name === "upload/nested/b.txt")?.data.toString()).toBe("deep");
    } finally {
      rmSync(stage, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zip64 感知", () => {
  test("EOCD 占位符 + 0x0001 扩展字段里的 local offset 都走 64 位真值", () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-test-64-"));
    const zipPath = join(dir, "big.zip");
    try {
      buildZipFile(zipPath, [{ name: "upload\\big.bin", data: Buffer.from("payload") }], { zip64: true });
      expect(listZipEntryNames(zipPath)).toEqual(["upload\\big.bin"]);
      expect(normalizeZipEntrySeparators(zipPath)).toBe(1);
      expect(listZipEntryNames(zipPath)).toEqual(["upload/big.bin"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
