// workspace/files.test.ts — 文件面板领域操作单测（M3-5）。reveal 不测（起系统进程）。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../foundation/types";
import { WorkspaceBoundaryError } from "./boundary";
import { deleteWorkspaceEntry, listWorkspaceDir, previewWorkspaceFile, readWorkspaceFileForEdit, renameWorkspaceEntry, sweepWorkspaceReservedNameArtifacts, WorkspaceFileConflictError, writeWorkspaceTextFile } from "./files";
import { windowsSafeFsPath } from "../foundation/windows-names";

const host = mkdtempSync(join(tmpdir(), "rkh-files-"));
const root = join(host, "ws");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "readme.md"), "# hello");
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;");
writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2, 0, 3]));
writeFileSync(join(host, "outside.txt"), "secret");

const workspace = { id: "w1", root } as Workspace;

describe("listWorkspaceDir", () => {
  test("目录优先、名称排序,带类型与体积", () => {
    const entries = listWorkspaceDir(workspace, "");
    expect(entries.map((e) => e.name)).toEqual(["src", "bin.dat", "readme.md"]);
    expect(entries[0]!.type).toBe("dir");
    expect(entries.find((e) => e.name === "readme.md")!.size).toBeGreaterThan(0);
  });

  test("越界路径拒绝", () => {
    expect(() => listWorkspaceDir(workspace, "..")).toThrow(WorkspaceBoundaryError);
  });
});

describe("previewWorkspaceFile", () => {
  test("文本文件返回 text", async () => {
    const preview = await previewWorkspaceFile(workspace, "readme.md");
    expect(preview).toEqual({ kind: "text", text: "# hello", truncated: false, size: 7 });
  });

  test("含 NUL 的文件按二进制处理", async () => {
    const preview = await previewWorkspaceFile(workspace, "bin.dat");
    expect(preview.kind).toBe("binary");
  });

  test("目录/越界拒绝", async () => {
    await expect(previewWorkspaceFile(workspace, "src")).rejects.toThrow("Not a file");
    await expect(previewWorkspaceFile(workspace, "../outside.txt")).rejects.toThrow(WorkspaceBoundaryError);
  });
});

describe("侧边栏编辑(0.0.3):编辑态读取/etag 保存/BOM/EOL", () => {
  test("文本文件可编辑:返回 etag、EOL、无 BOM", async () => {
    writeFileSync(join(root, "edit.txt"), "line1\nline2\n");
    const { preview, edit } = await readWorkspaceFileForEdit(workspace, "edit.txt");
    expect(preview).toEqual({ kind: "text", text: "line1\nline2\n", truncated: false, size: 12 });
    expect(edit.editable).toBe(true);
    expect(edit.etag).toHaveLength(32);
    expect(edit.eol).toBe("\n");
    expect(edit.hasBom).toBe(false);
  });

  test("CRLF + BOM 保留;非文本/超大文件不可编辑", async () => {
    writeFileSync(join(root, "crlf.txt"), Buffer.from("\uFEFFa\r\nb\r\n", "utf-8"));
    const { preview, edit } = await readWorkspaceFileForEdit(workspace, "crlf.txt");
    expect(edit.editable).toBe(true);
    expect(edit.eol).toBe("\r\n");
    expect(edit.hasBom).toBe(true);
    expect(preview.kind === "text" && preview.text.startsWith("a")).toBe(true);

    const binary = await readWorkspaceFileForEdit(workspace, "bin.dat");
    expect(binary.edit.editable).toBe(false);
    expect(binary.edit.reason).toBe("binary");

    writeFileSync(join(root, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    const huge = await readWorkspaceFileForEdit(workspace, "huge.txt");
    expect(huge.edit.editable).toBe(false);
    expect(huge.edit.reason).toBe("too_large");
    deleteWorkspaceEntry(workspace, "huge.txt");
  });

  test("保存:EOL 归一 + etag 返回;旧 etag 冲突", async () => {
    writeFileSync(join(root, "save.txt"), "a\nb\n");
    const { edit } = await readWorkspaceFileForEdit(workspace, "save.txt");
    const result = writeWorkspaceTextFile(workspace, "save.txt", { content: "a\r\nc\r\n", baseEtag: edit.etag, eol: "\n" });
    expect(readFileSync(join(root, "save.txt"), "utf-8")).toBe("a\nc\n");
    expect(result.etag).toHaveLength(32);
    expect(result.size).toBe(4);

    // 用旧 etag 再存 = 冲突(保留磁盘上的内容)
    expect(() => writeWorkspaceTextFile(workspace, "save.txt", { content: "overwrite", baseEtag: edit.etag, eol: "\n" }))
      .toThrow(WorkspaceFileConflictError);
    expect(readFileSync(join(root, "save.txt"), "utf-8")).toBe("a\nc\n");
  });

  test("保存:BOM 保留、界外/不存在/NUL 拒绝", async () => {
    writeFileSync(join(root, "bom.txt"), Buffer.from("\uFEFFold", "utf-8"));
    const { edit } = await readWorkspaceFileForEdit(workspace, "bom.txt");
    writeWorkspaceTextFile(workspace, "bom.txt", { content: "new", baseEtag: edit.etag, eol: "\n" });
    expect(readFileSync(join(root, "bom.txt"), "utf-8")).toBe("\uFEFFnew");

    expect(() => writeWorkspaceTextFile(workspace, "../outside.txt", { content: "x" })).toThrow(WorkspaceBoundaryError);
    expect(() => writeWorkspaceTextFile(workspace, "missing.txt", { content: "x" })).toThrow();
    expect(() => writeWorkspaceTextFile(workspace, "bom.txt", { content: "a\u0000b", eol: "\n" })).toThrow("NUL");
  });

  test("大文件预览只读前 512KB(不再整读)", async () => {
    const big = join(root, "big-preview.txt");
    writeFileSync(big, "a".repeat(600 * 1024));
    const preview = await previewWorkspaceFile(workspace, "big-preview.txt");
    expect(preview.kind).toBe("text");
    if (preview.kind === "text") {
      expect(preview.truncated).toBe(true);
      expect(preview.text.length).toBe(512 * 1024);
    }
    deleteWorkspaceEntry(workspace, "big-preview.txt");
  });
});

describe("rename/delete", () => {
  test("重命名限同目录、名称不得含分隔符;root 本身不可动", () => {
    writeFileSync(join(root, "old.txt"), "x");
    renameWorkspaceEntry(workspace, "old.txt", "new.txt");
    expect(existsSync(join(root, "new.txt"))).toBe(true);
    expect(() => renameWorkspaceEntry(workspace, "new.txt", "../escape.txt")).toThrow();
    expect(() => renameWorkspaceEntry(workspace, "", "anything")).toThrow("Cannot rename the workspace root");
  });

  test("删除文件与目录;root 本身不可删", () => {
    writeFileSync(join(root, "src", "tmp.txt"), "x");
    deleteWorkspaceEntry(workspace, "src/tmp.txt");
    expect(existsSync(join(root, "src", "tmp.txt"))).toBe(false);
    expect(() => deleteWorkspaceEntry(workspace, "")).toThrow("Cannot delete the workspace root");
    expect(() => deleteWorkspaceEntry(workspace, "../outside.txt")).toThrow(WorkspaceBoundaryError);
    expect(existsSync(join(host, "outside.txt"))).toBe(true);
  });
});

describe("Windows 保留设备名残留处置(问题4,2.0.0 内测)", () => {
  const onWindows = process.platform === "win32";

  test.if(onWindows)("字面 nul 残留:面板可见(真实体积)、可预览、可删除", async () => {
    await Bun.write(windowsSafeFsPath(join(root, "nul")), "stray-bytes");
    const entries = listWorkspaceDir(workspace, "");
    const nul = entries.find((e) => e.name === "nul");
    expect(nul?.type).toBe("file");
    expect(nul?.size).toBe(11);

    const preview = await previewWorkspaceFile(workspace, "nul");
    expect(preview).toEqual({ kind: "text", text: "stray-bytes", truncated: false, size: 11 });

    deleteWorkspaceEntry(workspace, "nul");
    expect(listWorkspaceDir(workspace, "").some((e) => e.name === "nul")).toBe(false);
  });

  test.if(onWindows)("重命名救活残留;重命名目标为保留名被拒", async () => {
    await Bun.write(windowsSafeFsPath(join(root, "nul")), "rescue-me");
    renameWorkspaceEntry(workspace, "nul", "rescued.txt");
    expect(readFileSync(join(root, "rescued.txt"), "utf-8")).toBe("rescue-me");

    expect(() => renameWorkspaceEntry(workspace, "rescued.txt", "con")).toThrow("reserved Windows device name");
    expect(() => renameWorkspaceEntry(workspace, "rescued.txt", "NUL.txt")).toThrow("reserved Windows device name");
    deleteWorkspaceEntry(workspace, "rescued.txt");
  });

  test.if(onWindows)("sweepWorkspaceReservedNameArtifacts 清扫顶层裸名残留", async () => {
    await Bun.write(windowsSafeFsPath(join(root, "nul")), "x");
    sweepWorkspaceReservedNameArtifacts(root);
    expect(listWorkspaceDir(workspace, "").some((e) => e.name === "nul")).toBe(false);
  });
});
