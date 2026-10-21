// pdf-extract.test.ts — 专题4:PDF 流式提取(fz_stream + fd)的回归防线。
// 程序化构造一份 xref 偏移正确的最小 PDF,真实走 mupdf wasm:验证 Stream 句柄的
// read/seek 回调链路(readSync 直读进 wasm 堆窗口)能解析出文本,且逐页进度回调可用。
// ⚠️ 若本测试失败在 openDocument,大概率是有人把流式打开"简化"回了整文件 buffer。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdfText } from "./index";

function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects: Record<number, string> = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    4: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("extractPdfText(fz_stream 流式打开)", () => {
  test("fd 流式解析出文本并逐页回调进度", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rikka-pdf-"));
    const pdfPath = join(dir, "hello.pdf");
    writeFileSync(pdfPath, buildMinimalPdf("Hello RikkaHub"));
    try {
      const progress: Array<[number, number]> = [];
      const text = await extractPdfText(pdfPath, (done, total) => progress.push([done, total]));
      expect(text).toContain("---Page 1:");
      expect(text).toContain("Hello RikkaHub");
      expect(progress).toEqual([[1, 1]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
