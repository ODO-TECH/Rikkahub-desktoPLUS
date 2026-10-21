// 1-6 回归:数据目录搬家后附件路径修正。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoredFile } from "../foundation/types";
import { repairRelocatedFilePathsIn } from "./state-load";

function makeFilesDir(): string {
  return mkdtempSync(join(tmpdir(), "rikka-files-"));
}

function entry(id: number, path: string, fileName = `doc${id}.pdf`): StoredFile {
  return { id, path, fileName, mime: "application/pdf", size: 1 };
}

describe("附件路径搬家修正(1-6)", () => {
  // 注意:失效路径不能用假盘符(如 Z:\)——Windows 对不存在盘符的 existsSync 会走
  // SMB 网络解析,偶发阻塞 21s(TCP SYN 重传超时),曾导致本文件测试偶发超时。
  test("旧路径失效(原目录已不存在)但 basename 在当前 files/ → 改指新路径", () => {
    const dir = makeFilesDir();
    try {
      writeFileSync(join(dir, "7.pdf"), "x");
      const files = [entry(7, join(tmpdir(), "rikka-gone-dir", "old-files", "7.pdf"))];
      expect(repairRelocatedFilePathsIn(files, dir)).toBe(1);
      expect(files[0]!.path).toBe(join(dir, "7.pdf"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("path 为空但 <id><ext> 命中(ext 取自 fileName)→ 修正", () => {
    const dir = makeFilesDir();
    try {
      writeFileSync(join(dir, "3.pdf"), "x");
      const files = [entry(3, "")];
      expect(repairRelocatedFilePathsIn(files, dir)).toBe(1);
      expect(files[0]!.path).toBe(join(dir, "3.pdf"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("原路径仍有效 → 不动(用户拷贝而非移动,旧盘还在)", () => {
    const dir = makeFilesDir();
    try {
      const livePath = join(dir, "5.pdf");
      writeFileSync(livePath, "x");
      const files = [entry(5, livePath)];
      expect(repairRelocatedFilePathsIn(files, dir)).toBe(0);
      expect(files[0]!.path).toBe(livePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("字节确实丢失 → 不改写(读取侧 404 是正确行为)", () => {
    const dir = makeFilesDir();
    try {
      const gonePath = join(tmpdir(), "rikka-gone-dir", "9.pdf");
      const files = [entry(9, gonePath)];
      expect(repairRelocatedFilePathsIn(files, dir)).toBe(0);
      expect(files[0]!.path).toBe(gonePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
