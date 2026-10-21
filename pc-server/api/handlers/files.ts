// api/handlers/files.ts — 文件路由（files/upload、content、path、extraction、delete）
// 纪律：纯搬迁自 server.ts routeApi()。

import type { ExtractionStatusDto, UploadFilesResponseDto, UploadedFileDto } from "../../foundation/types";
import { existsSync, unlinkSync } from "node:fs";
import { safeDataFilePath } from "../../files";
import { extname, join } from "node:path";
import type { StoredFile } from "../../foundation/types";
import { filesDir } from "../../foundation/paths";
import { saveState, state } from "../../persistence/json-store";
import { extractedTextPath, isExtractableDocument } from "../../files/index";
import { ensureExtractedTextAsync, getExtractionStatus } from "../../files/extraction";
import { error, json, mime } from "../request";

export async function handleFileRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "files/upload" && request.method === "POST") {
    const form = await request.formData();
    const uploaded: UploadedFileDto[] = await Promise.all(
      form.getAll("files").filter((item): item is File => item instanceof File).map(async (file) => {
        const fileId = state.nextFileId++;
        const target = join(filesDir, `${fileId}${extname(file.name)}`);
        await Bun.write(target, file);
        const entry: StoredFile = { id: fileId, path: target, fileName: file.name, mime: file.type || "application/octet-stream", size: file.size };
        state.files.push(entry);
        // 专题4:字节落盘即返回,全文提取转后台子进程——上传接口不再被大 PDF 拖住
        // 几十秒。前端拿 "pending" 后轮询 files/:id/extraction 画进度圆圈;发送时
        // 提取未完的走既有 fallbackDocumentText 降级(3-4 机制,行为不变)。
        const extractable = isExtractableDocument(entry);
        if (extractable) ensureExtractedTextAsync(entry);
        console.log(`[upload] ${entry.fileName} (${(file.size / 1024).toFixed(1)} KB) stored, extraction=${extractable ? "pending" : "none"}`);
        return {
          id: fileId,
          url: `/api/files/${fileId}/content`,
          fileName: entry.fileName,
          mime: entry.mime,
          size: entry.size,
          extraction: extractable ? "pending" as const : "none" as const,
        };
      }),
    );
    saveState();
    const response: UploadFilesResponseDto = { files: uploaded };
    return json(response);
  }
  const fileContent = path.match(/^files\/(\d+)\/content$/);
  if (fileContent) {
    const entry = state.files.find((item) => item.id === Number(fileContent[1]));
    if (!entry || !existsSync(entry.path)) return error("File not found", 404);
    // File IDs are integer primary keys assigned at upload time; content for a given id
    // never changes (upload is write-once). The `immutable` directive tells the browser
    // never to revalidate this URL, so switching back to a previously-viewed conversation
    // hits the in-memory cache instantly instead of round-tripping to localhost.
    // Without this, the browser used heuristic caching (effectively none for /api/...
    // paths) and the user saw every image re-load on every conversation switch — even
    // ones they'd viewed seconds earlier. The ETag is a belt-and-suspenders fallback for
    // browsers that disregard `immutable`.
    return new Response(Bun.file(entry.path), {
      headers: {
        "Content-Type": entry.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": `"${entry.id}"`,
      },
    });
  }
  // 专题4:提取状态/进度查询(前端附件 chip 进度圆圈轮询)。终态后前端停轮。
  const fileExtraction = path.match(/^files\/(\d+)\/extraction$/);
  if (fileExtraction && request.method === "GET") {
    const entry = state.files.find((item) => item.id === Number(fileExtraction[1]));
    if (!entry) return error("File not found", 404);
    const status = getExtractionStatus(entry);
    const response: ExtractionStatusDto = { status: status.status, done: status.done, total: status.total };
    return json(response);
  }
  const fileByPath = path.match(/^files\/path\/(.+)$/);
  if (fileByPath) {
    const target = safeDataFilePath(fileByPath[1]);
    if (!target) return error("File not found", 404);
    // Same caching rationale as the by-id endpoint above. Path-based fetches typically
    // come from Android-imported messages whose URL references survived migration —
    // those resolved paths point to immutable on-disk files.
    return new Response(Bun.file(target), {
      headers: {
        "Content-Type": mime(target),
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": `"path:${fileByPath[1]}"`,
      },
    });
  }
  const fileDelete = path.match(/^files\/(\d+)$/);
  if (fileDelete && request.method === "DELETE") {
    const deleteId = Number(fileDelete[1]);
    const target = state.files.find((item) => item.id === deleteId);
    state.files = state.files.filter((item) => item.id !== deleteId);
    // 5-7:此前只删账本条目,物理字节永久残留(导出会跳过孤儿,纯磁盘泄漏)。
    // 历史去重条目可能共享同一路径,仅当无其余条目引用时才删字节;抽取旁车一并清。
    if (target?.path && !state.files.some((item) => item.path === target.path)) {
      try { unlinkSync(target.path); } catch { /* 不存在/被锁,忽略 */ }
    }
    try { unlinkSync(extractedTextPath(deleteId)); } catch { /* 无旁车 */ }
    saveState();
    return json({ status: "deleted" });
  }
  return null;
}
