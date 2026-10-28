// labeling.test.ts — 完整性标签管理单测(全程免提权,临时目录,Windows 专用其余跳过)
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  collectFolderWorkspaceRoots,
  readIntegrityLabel,
  readSandboxLabelRecord,
  restoreLabelsFromRecord,
  sandboxLabelsPath,
  setIntegrityLabels,
  writeSandboxLabelRecord,
} from "./labeling";

const onWindows = process.platform === "win32";
const suite = onWindows ? describe : describe.skip;

// 每个用例自建临时目录;afterAll 统一还原成 Medium 再删(Low 标签虽无害,
// 但不把测试痕迹留在用户临时目录的标签上)。
const labeledDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rikkahub-label-test-"));
  labeledDirs.push(dir);
  return dir;
}

function labelLow(dir: string): void {
  const outcome = setIntegrityLabels([dir], "low");
  expect(outcome.labeled).toEqual([dir]);
  expect(outcome.failed).toEqual([]);
}

afterAll(() => {
  setIntegrityLabels(labeledDirs, "medium");
  for (const dir of labeledDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 残留无害
    }
  }
});

suite("setIntegrityLabels / readIntegrityLabel", () => {
  test("降 Low 后可读回,还原 Medium 后同样可读回", () => {
    const dir = makeDir();
    // 全新目录没有显式标签(Medium 是隐式默认,icacls 不打印标签行)⇒ unknown。
    // 这里只要求"不是 low":绝不能把未标注目录误读成 Low。
    expect(readIntegrityLabel(dir)).not.toBe("low");
    labelLow(dir);
    expect(readIntegrityLabel(dir)).toBe("low");
    const outcome = setIntegrityLabels([dir], "medium");
    expect(outcome.labeled).toEqual([dir]);
    expect(readIntegrityLabel(dir)).toBe("medium");
  });

  test("(OI)(CI) 继承:标注后新建的子目录自动带 Low", () => {
    const dir = makeDir();
    labelLow(dir);
    const child = join(dir, "child", "grandchild");
    mkdirSync(child, { recursive: true });
    expect(readIntegrityLabel(child)).toBe("low");
  });

  test("不存在的目录记失败,不影响其余目录", () => {
    const ok = makeDir();
    const missing = join(tmpdir(), "rikkahub-label-test-definitely-missing");
    const outcome = setIntegrityLabels([ok, missing], "low");
    expect(outcome.labeled).toEqual([ok]);
    expect(outcome.failed).toEqual([{ dir: missing, error: "directory does not exist" }]);
  });

  test("大小写去重:同一目录不同大小写只标一次", () => {
    const dir = makeDir();
    const outcome = setIntegrityLabels([dir, dir.toUpperCase() === dir ? dir.toLowerCase() : dir.toUpperCase()], "low");
    expect(outcome.labeled).toHaveLength(1);
  });
});

suite("sandbox-labels.json 记录", () => {
  test("读写往返", () => {
    const dataDir = makeDir();
    expect(readSandboxLabelRecord(dataDir)).toBeNull();
    writeSandboxLabelRecord(dataDir, ["C:\\a", "C:\\b"]);
    const record = readSandboxLabelRecord(dataDir);
    expect(record?.version).toBe(1);
    expect(record?.dirs).toEqual(["C:\\a", "C:\\b"]);
    expect(record?.at).toBeGreaterThan(0);
  });

  test("损坏/缺字段的记录读回 null", () => {
    const dataDir = makeDir();
    const { writeFileSync } = require("node:fs");
    writeFileSync(sandboxLabelsPath(dataDir), "{ not json", "utf8");
    expect(readSandboxLabelRecord(dataDir)).toBeNull();
    writeFileSync(sandboxLabelsPath(dataDir), JSON.stringify({ version: 2, dirs: ["x"] }), "utf8");
    expect(readSandboxLabelRecord(dataDir)).toBeNull();
  });

  test("restoreLabelsFromRecord:全部还原成功后删除记录文件", () => {
    const dataDir = makeDir();
    const dir = makeDir();
    labelLow(dir);
    writeSandboxLabelRecord(dataDir, [dir]);
    const outcome = restoreLabelsFromRecord(dataDir);
    expect(outcome?.labeled).toEqual([dir]);
    expect(readIntegrityLabel(dir)).toBe("medium");
    expect(readSandboxLabelRecord(dataDir)).toBeNull();
  });

  test("restoreLabelsFromRecord:部分失败的目录留在记录里", () => {
    const dataDir = makeDir();
    const ok = makeDir();
    const gone = makeDir();
    labelLow(ok);
    labelLow(gone);
    rmSync(gone, { recursive: true, force: true });
    writeSandboxLabelRecord(dataDir, [ok, gone]);
    const outcome = restoreLabelsFromRecord(dataDir);
    expect(outcome?.labeled).toEqual([ok]);
    expect(outcome?.failed).toHaveLength(1);
    const record = readSandboxLabelRecord(dataDir);
    expect(record?.dirs).toEqual([gone]);
  });

  test("restoreLabelsFromRecord:无记录返回 null", () => {
    const dataDir = makeDir();
    expect(restoreLabelsFromRecord(dataDir)).toBeNull();
  });
});

suite("collectFolderWorkspaceRoots", () => {
  test("只返回 folder 型的 Windows 绝对路径根", () => {
    const dbDir = makeDir();
    const dbPath = join(dbDir, "conversations.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE pc_workspace (id TEXT PRIMARY KEY, name TEXT, type TEXT, root TEXT)`);
    db.exec(`INSERT INTO pc_workspace VALUES ('a', '甲', 'folder', 'C:\\work\\alpha')`);
    db.exec(`INSERT INTO pc_workspace VALUES ('b', '乙', 'folder', 'D:/work/beta')`);
    db.exec(`INSERT INTO pc_workspace VALUES ('c', '丙', 'folder', '')`);
    db.exec(`INSERT INTO pc_workspace VALUES ('d', '丁', 'folder', 'relative/path')`);
    db.exec(`INSERT INTO pc_workspace VALUES ('e', '戊', 'managed', 'C:\\work\\should-not-appear')`);
    db.exec(`INSERT INTO pc_workspace VALUES ('f', '己', 'ssh', '/remote/root')`);
    db.close();
    const roots = collectFolderWorkspaceRoots(dbPath);
    expect(roots.sort()).toEqual(["C:\\work\\alpha", "D:/work/beta"].sort());
  });

  test("库文件不存在返回空表", () => {
    expect(collectFolderWorkspaceRoots(join(makeDir(), "missing.db"))).toEqual([]);
  });

  test("表不存在返回空表", () => {
    const dbDir = makeDir();
    const dbPath = join(dbDir, "empty.db");
    const db = new Database(dbPath);
    db.close();
    expect(collectFolderWorkspaceRoots(dbPath)).toEqual([]);
  });
});
