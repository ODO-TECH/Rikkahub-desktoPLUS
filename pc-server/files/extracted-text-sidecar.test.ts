// 1-7/3-4 回归:抽取全文旁车缓存(不再驻留 state.json)。
// 注意:extractedTextPath 固定指向运行时 filesDir,单测直接用真实 filesDir 下的
// 高位假 id,结束后清理——避免为可注入目录参数而复杂化生产签名。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";

import type { StoredFile } from "../foundation/types";
import { extractedTextPath, readExtractedTextSync, writeExtractedTextSidecar } from "./index";

const TEST_ID = 987654321;

function entry(id: number, extractedText?: string): StoredFile {
  return { id, path: "", fileName: "doc.pdf", mime: "application/pdf", size: 1, extractedText };
}

afterAll(() => {
  rmSync(extractedTextPath(TEST_ID), { force: true });
});

describe("抽取全文旁车缓存(1-7)", () => {
  test("写入后可读回,文件落在 files/<id>.extracted.txt", () => {
    writeExtractedTextSidecar(TEST_ID, "全文内容 ABC");
    const sidecar = extractedTextPath(TEST_ID);
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf8")).toBe("全文内容 ABC");
    expect(readExtractedTextSync(entry(TEST_ID))).toBe("全文内容 ABC");
  });

  test("旁车优先于老内存字段;无旁车时兜底老字段(迁移窗口)", () => {
    expect(readExtractedTextSync(entry(TEST_ID, "老字段"))).toBe("全文内容 ABC");
    rmSync(extractedTextPath(TEST_ID), { force: true });
    expect(readExtractedTextSync(entry(TEST_ID, "老字段"))).toBe("老字段");
  });

  test("双无 → 空串(编码路径据此走 fallback+后台补抽)", () => {
    expect(readExtractedTextSync(entry(TEST_ID))).toBe("");
  });

  test("空文本不产生旁车文件", () => {
    writeExtractedTextSidecar(TEST_ID, "");
    expect(existsSync(extractedTextPath(TEST_ID))).toBe(false);
  });
});
