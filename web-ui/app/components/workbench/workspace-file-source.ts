// 文件面板的数据源:同一套面板组件既浏览本机工作区,也浏览 SSH 工作区绑定的那条授权目录。
//
// 分派只看工作区 DTO 的 type 与两个绑定 id——本地文件路由对 ssh 型一律 400
// ssh.use_remote_file_routes(api/handlers/workspaces.ts),所以「远程目录」从来没有第二条
// 入口;把分派收在这一个模块里,面板组件就不必到处判断 workspace.type。
//
// 两端能力不同,且是后端事实而非界面偏好,因此显式建一张能力表(界面按它隐藏入口,
// 不画点了必定失败的菜单项):
// - 重命名:pc-server 的 SFTP 层没有远端改名(remote-files.ts 只有 write/upload/delete)。
// - 在资源管理器中显示:本机专属,远端没有"宿主机的文件管理器"。
// - AGENTS.md:远程工作区不加载项目上下文文件(引擎侧 includeProjectAgentsFiles=false),
//   写一份模型永远不读的文件只会让人以为改了远端行为 → ssh.agents_file_unsupported。
// - 上传/下载:远程有(安卓端 importFile/exportFile 的对应物);本地面板历来没有,不反向补。
// - 条件写(etag):只有本地有。远端 PUT 就是有意覆盖,冲突横幅在远程永远不会亮。

import * as React from "react";

import api, { appendWebAuthQuery } from "~/services/api";
import type { WorkspaceDto } from "~/types";

import {
  workspaceRawFileUrl,
  type FilePreview,
  type WorkspaceEditableContent,
  type WorkspaceFileEditInfo,
  type WorkspaceFileEntry,
} from "./conversation-files-types";

export type WorkspaceFileSource =
  | { kind: "local"; workspaceId: string }
  | { kind: "remote"; deviceId: string; dirId: string };

export interface FileSourceCapabilities {
  rename: boolean;
  reveal: boolean;
  agents: boolean;
  remove: boolean;
  upload: boolean;
  download: boolean;
  /** 交互式终端(只在 ssh 工作区里存在)。 */
  terminal: boolean;
}

/** 远端写入上限:与 pc-server/ssh/constants.ts 的 MAX_WRITE_BYTES(2 MiB)同值。 */
const REMOTE_WRITE_LIMIT_BYTES = 2 * 1024 * 1024;
/** 远端预览截断阈值:与 ssh/constants.ts 的 MAX_READ_BYTES(512 KiB)同值。 */
const REMOTE_READ_LIMIT_BYTES = 512 * 1024;

/**
 * 工作区 → 文件面来源。
 * 返回 null 的两种情况都不该发请求:工作区不存在(store 里没有),或 ssh 型绑定已断
 * (sshDeviceId/sshDirId 为空——设备或授权目录被删掉了,后端判 status=missing)。
 */
export function fileSourceOf(
  workspace: Pick<WorkspaceDto, "id" | "type" | "sshDeviceId" | "sshDirId"> | null | undefined,
): WorkspaceFileSource | null {
  if (!workspace) return null;
  if (workspace.type === "ssh") {
    const deviceId = workspace.sshDeviceId ?? "";
    const dirId = workspace.sshDirId ?? "";
    if (!deviceId || !dirId) return null;
    return { kind: "remote", deviceId, dirId };
  }
  return { kind: "local", workspaceId: workspace.id };
}

export function capabilitiesOf(source: WorkspaceFileSource | null): FileSourceCapabilities {
  // 没有来源 = 没有可操作的对象:一格能力都不给。这里不能用「非远程即本地」的写法,
  // 否则绑定断了的 ssh 工作区会因为 source=null 被判成具备本地能力(改名/AGENTS.md 都点亮)。
  if (!source) {
    return { rename: false, reveal: false, agents: false, remove: false, upload: false, download: false, terminal: false };
  }
  const remote = source.kind === "remote";
  return {
    rename: !remote,
    reveal: !remote,
    agents: !remote,
    remove: true,
    upload: remote,
    download: remote,
    terminal: remote,
  };
}

/**
 * 面板用的稳定来源:工作区对象每次 store 刷新都是新引用,而来源判定只看几个原始值。
 * 直接 `useMemo(() => fileSourceOf(workspace), [workspace])` 会让下游的 listDir/preview
 * 回调每轮渲染都换新,文件树被反复重拉、展开状态被冲掉——所以按原始值建键。
 */
export function useWorkspaceFileSource(
  workspace: Pick<WorkspaceDto, "id" | "type" | "sshDeviceId" | "sshDirId"> | null | undefined,
): WorkspaceFileSource | null {
  const latest = React.useRef(workspace);
  latest.current = workspace;
  const key = [workspace?.type, workspace?.id, workspace?.sshDeviceId, workspace?.sshDirId].join("|");
  return React.useMemo(() => fileSourceOf(latest.current), [key]);
}

function query(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return search.toString();
}

/** 远程请求公共参数:面板只认设备 id + 目录 id,路径永远是相对授权目录的那一段。 */
function remoteParams(source: { deviceId: string; dirId: string }, relPath: string): string {
  return query({ deviceId: source.deviceId, dirId: source.dirId, path: relPath });
}

export function listDir(source: WorkspaceFileSource, relPath: string): Promise<WorkspaceFileEntry[]> {
  if (source.kind === "local") {
    return api.get<{ entries: WorkspaceFileEntry[] }>(
      `workspaces/${source.workspaceId}/files?path=${encodeURIComponent(relPath)}`,
    ).then((res) => res.entries);
  }
  return api.get<{ entries: WorkspaceFileEntry[] }>(`ssh/files?${remoteParams(source, relPath)}`).then((res) => res.entries);
}

export function loadPreview(source: WorkspaceFileSource, relPath: string): Promise<FilePreview> {
  if (source.kind === "local") {
    return api
      .get<{ preview: FilePreview }>(
        `workspaces/${source.workspaceId}/files/content?path=${encodeURIComponent(relPath)}`,
      )
      .then((res) => res.preview);
  }
  return api
    .get<{ preview: FilePreview }>(`ssh/files/content?${remoteParams(source, relPath)}`)
    .then((res) => res.preview);
}

/**
 * 进入编辑所需的内容 + 元信息。
 * 本地有专用通道(?mode=edit 回 etag/EOL/BOM);远程没有条件写,预览就是那份文本,
 * 于是这里现场合成一份同形的 edit 信息——editable 只由「是不是文本、有没有被截断」决定:
 * 截断过的文本存回去会静默丢掉尾巴,必须拒绝。
 */
export async function loadEditable(source: WorkspaceFileSource, relPath: string): Promise<WorkspaceEditableContent> {
  if (source.kind === "local") {
    return api.get<WorkspaceEditableContent>(
      `workspaces/${source.workspaceId}/files/content?path=${encodeURIComponent(relPath)}&mode=edit`,
    );
  }
  const preview = await loadPreview(source, relPath);
  return { preview, edit: remoteEditInfo(preview) };
}

export function remoteEditInfo(preview: FilePreview): WorkspaceFileEditInfo {
  if (preview.kind === "image") {
    return { editable: false, etag: null, eol: "\n", hasBom: false, size: preview.size, limitBytes: REMOTE_WRITE_LIMIT_BYTES, reason: "image" };
  }
  if (preview.kind === "binary") {
    return { editable: false, etag: null, eol: "\n", hasBom: false, size: preview.size, limitBytes: REMOTE_WRITE_LIMIT_BYTES, reason: "binary" };
  }
  if (preview.truncated) {
    return { editable: false, etag: null, eol: "\n", hasBom: false, size: preview.size, limitBytes: REMOTE_READ_LIMIT_BYTES, reason: "too_large" };
  }
  // 远端写入不做行尾推断(编辑器里是什么字节就落什么字节),所以这里报的是文件实况:
  // 含 CRLF 就说 CRLF,不然界面会承诺一个它并没有执行的换行规则。
  const eol: "\n" | "\r\n" = preview.text.includes("\r\n") ? "\r\n" : "\n";
  return { editable: true, etag: null, eol, hasBom: false, size: preview.size, limitBytes: REMOTE_WRITE_LIMIT_BYTES };
}

/** 保存文本。本地带 etag 做冲突保护(409 由调用方接)、EOL 按读到的那份写回;远程没有条件写,
 *  PUT 就是有意覆盖,EOL 也不由服务端推断(写出去的字节就是编辑器里的内容)。 */
export function saveText(
  source: WorkspaceFileSource,
  relPath: string,
  content: string,
  baseEtag: string | null,
  eol: "\n" | "\r\n",
): Promise<{ etag: string | null; size: number }> {
  if (source.kind === "local") {
    return api
      .put<{ etag: string; size: number }>(
        `workspaces/${source.workspaceId}/files/content?path=${encodeURIComponent(relPath)}`,
        { content, baseEtag, eol },
      )
      .then((res) => ({ etag: res.etag, size: res.size }));
  }
  return api
    .put<{ entry: { size: number } }>("ssh/files/content", {
      deviceId: source.deviceId,
      dirId: source.dirId,
      path: relPath,
      content,
      // 面板打开的就是远端那一份,保存是有意覆盖——与安卓端 put(OVERWRITE) 同一条决定。
      overwrite: true,
    })
    .then((res) => ({ etag: null, size: res.entry.size }));
}

export function removeEntry(source: WorkspaceFileSource, relPath: string, isDir: boolean): Promise<void> {
  if (source.kind === "local") {
    return api.delete(`workspaces/${source.workspaceId}/files?path=${encodeURIComponent(relPath)}`).then(() => undefined);
  }
  // 远程删目录必须显式 recursive:后端以此区分「误点」与「真的要清空一棵树」。
  const params = new URLSearchParams({ deviceId: source.deviceId, dirId: source.dirId, path: relPath });
  if (isDir) params.set("recursive", "1");
  return api.delete<{ deleted: boolean }>(`ssh/files?${params.toString()}`).then(() => undefined);
}

export function uploadFile(
  source: WorkspaceFileSource,
  destDirRelPath: string,
  file: File,
): Promise<WorkspaceFileEntry> {
  if (source.kind !== "remote") return Promise.reject(new Error("upload is only available in an SSH workspace"));
  const form = new FormData();
  form.set("deviceId", source.deviceId);
  form.set("dirId", source.dirId);
  form.set("path", destDirRelPath);
  form.set("file", file);
  return api.postMultipart<{ entry: WorkspaceFileEntry }>("ssh/files/upload", form).then((res) => res.entry);
}

/**
 * 原始字节地址(内联 PDF / 下载)。两条路由都只放行已授权范围:本地由领域层限 PDF,
 * 远程由 dirId 的授权校验兜。iframe/anchor 走浏览器直连,所以要补 web-auth query。
 */
export function rawFileUrl(source: WorkspaceFileSource, relPath: string): string {
  if (source.kind === "local") {
    return appendWebAuthQuery(workspaceRawFileUrl(source.workspaceId, relPath));
  }
  return appendWebAuthQuery(`/api/ssh/files/raw?${remoteParams(source, relPath)}`);
}

/** 下载用的地址:同一 raw 路由,远程侧用 download=1 强制 attachment(非 PDF 本来就是)。 */
export function downloadFileUrl(source: WorkspaceFileSource, relPath: string): string {
  const url = rawFileUrl(source, relPath);
  if (source.kind !== "remote") return url;
  return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
}
