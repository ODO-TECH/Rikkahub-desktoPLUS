// zip-file.test.ts — 随机访问 zip 读取器 + 文档解析器(安卓对齐改造)回归
// 用手工构造的合法 zip(store/deflate 混合)验证:中央目录解析、按需解压、
// 以及 DOCX/PPTX/EPUB 解析器只依赖各自需要的条目。

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { ZipFileReader, withZipFile } from "./zip-file";
import { extractDocxText, extractEpubText, extractPptxText } from "./index";

const tempRoot = mkdtempSync(join(tmpdir(), "zipfile-test-"));
afterAll(() => {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
});

type TestEntry = { name: string; data: Buffer | string; method?: 0 | 8; corrupt?: boolean };

function buildZip(entries: TestEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    let packed = method === 8 ? deflateRawSync(raw) : raw;
    if (e.corrupt) packed = Buffer.from(packed.map((b) => b ^ 0xa5)); // 故意破坏压缩流
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    chunks.push(local, nameBuf, packed);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

function writeZip(name: string, entries: TestEntry[]): string {
  const p = join(tempRoot, name);
  writeFileSync(p, buildZip(entries));
  return p;
}

describe("ZipFileReader", () => {
  test("中央目录解析:store/deflate 条目按需读取,目录条目跳过", () => {
    const big = "x".repeat(200_000);
    const p = writeZip("basic.zip", [
      { name: "dir/", data: "", method: 0 },
      { name: "a.txt", data: "hello store", method: 0 },
      { name: "b.txt", data: big, method: 8 },
    ]);
    withZipFile(p, (zip) => {
      expect(zip.entries().map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
      expect(zip.readEntry("a.txt")!.toString("utf8")).toBe("hello store");
      expect(zip.readEntry("b.txt")!.toString("utf8")).toBe(big);
      expect(zip.readEntry("missing.txt")).toBeNull();
      const meta = zip.getEntry("b.txt")!;
      expect(meta.uncompressedSize).toBe(200_000);
      expect(meta.compressedSize).toBeLessThan(5_000);
    });
  });

  test("损坏的单个条目返回 null,不影响其他条目", () => {
    const p = writeZip("corrupt.zip", [
      { name: "good.txt", data: "ok" },
      { name: "bad.bin", data: "should fail", corrupt: true },
    ]);
    withZipFile(p, (zip) => {
      expect(zip.readEntry("bad.bin")).toBeNull();
      expect(zip.readEntry("good.txt")!.toString("utf8")).toBe("ok");
    });
  });

  test("非 zip 文件抛错", () => {
    const p = join(tempRoot, "not-a.zip");
    writeFileSync(p, "just text, no EOCD");
    expect(() => new ZipFileReader(p)).toThrow();
  });
});

describe("文档解析器(只解需要的条目)", () => {
  test("DOCX:只读 word/document.xml,损坏的媒体条目不影响", () => {
    const docXml = `<w:document><w:body><w:p><w:r><w:t>Hello Docx</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p></w:body></w:document>`;
    const p = writeZip("t.docx", [
      { name: "word/media/huge.bin", data: Buffer.alloc(50_000, 7), corrupt: true },
      { name: "word/document.xml", data: docXml },
    ]);
    const text = extractDocxText(p);
    expect(text).toContain("Hello Docx");
    expect(text).toContain("# Title");
  });

  test("PPTX:slide 数字序 + 备注,媒体条目不解压", async () => {
    const slide = (s: string) =>
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const notes = `<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>My note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    const p = writeZip("t.pptx", [
      { name: "ppt/media/image1.png", data: Buffer.alloc(80_000, 3), corrupt: true },
      { name: "ppt/slides/slide10.xml", data: slide("Ten") },
      { name: "ppt/slides/slide2.xml", data: slide("Two") },
      { name: "ppt/slides/slide1.xml", data: slide("One") },
      { name: "ppt/notesSlides/notesSlide1.xml", data: notes },
    ]);
    const text = await extractPptxText(p);
    expect(text.indexOf("One")).toBeGreaterThan(-1);
    expect(text.indexOf("One")).toBeLessThan(text.indexOf("Two"));
    expect(text.indexOf("Two")).toBeLessThan(text.indexOf("Ten"));
    expect(text).toContain("## Slide 1");
    expect(text).toContain("Speaker Notes");
    expect(text).toContain("My note");
  });

  test("EPUB:container→OPF→spine 章节顺序,封面图不解压", async () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const opf = `<package><manifest><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
    const ch = (s: string) => `<html><body><h1>${s}</h1><p>Body of ${s}</p></body></html>`;
    const p = writeZip("t.epub", [
      { name: "mimetype", data: "application/epub+zip", method: 0 },
      { name: "META-INF/container.xml", data: container },
      { name: "OEBPS/content.opf", data: opf },
      { name: "OEBPS/ch2.xhtml", data: ch("Second") },
      { name: "OEBPS/ch1.xhtml", data: ch("First") },
      { name: "OEBPS/cover.png", data: Buffer.alloc(60_000, 9), corrupt: true },
    ]);
    const text = await extractEpubText(p);
    expect(text).toContain("# First");
    expect(text).toContain("Body of Second");
    expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
  });

  test("EPUB 无 container.xml 时走文件名序兜底", async () => {
    const p = writeZip("fallback.epub", [
      { name: "b.xhtml", data: "<html><body><p>Beta</p></body></html>" },
      { name: "a.xhtml", data: "<html><body><p>Alpha</p></body></html>" },
    ]);
    const text = await extractEpubText(p);
    expect(text.indexOf("Alpha")).toBeGreaterThan(-1);
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"));
  });
});
