// 全面审查 5-1(P0)单元回归:恢复时新文件 id 的安全下界,绝不回到已被占用的 id 空间。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nextFileIdSafeFloor } from "./import";
import { setState, state } from "../persistence/json-store";
import type { State } from "../foundation/types";

const priorState = state;
afterAll(() => setState(priorState));

describe("nextFileIdSafeFloor", () => {
  test("取内存 nextFileId、files 账本、磁盘文件名三者最大", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-fileid-"));
    writeFileSync(join(dir, "12.png"), "x");
    writeFileSync(join(dir, "30"), "x"); // 无扩展名的落盘文件也要认
    writeFileSync(join(dir, "notes.txt"), "x"); // 非数字名忽略
    writeFileSync(join(dir, "restored-999-7.png"), "x"); // 恢复批次文件不算 id 空间
    setState({ nextFileId: 5, files: [{ id: 9 }] } as unknown as State);

    expect(nextFileIdSafeFloor(dir)).toBe(31); // 磁盘 30 号最大 → 31
  });

  test("内存账本比磁盘大时以账本为准", () => {
    const dir = mkdtempSync(join(tmpdir(), "rkh-fileid2-"));
    writeFileSync(join(dir, "3.png"), "x");
    setState({ nextFileId: 100, files: [] } as unknown as State);
    expect(nextFileIdSafeFloor(dir)).toBe(100);
  });

  test("目录不存在/state 为空时回退 1(全新安装)", () => {
    setState(undefined as unknown as State);
    expect(nextFileIdSafeFloor(join(tmpdir(), "rkh-不存在的目录"))).toBe(1);
  });
});
