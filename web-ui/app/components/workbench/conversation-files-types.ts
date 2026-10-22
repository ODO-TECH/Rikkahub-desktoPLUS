// 会话文件侧边栏(0.0.3 Feature A)的共享类型与纯函数。
// 后端契约见 pc-server/conversations/conversation-files.ts 与 workspaces 文件路由。

export interface WorkspaceFileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

export type FilePreview =
  | { kind: "text"; text: string; truncated: boolean; size: number }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "binary"; size: number };

export interface WorkspaceFileEditInfo {
  editable: boolean;
  etag: string | null;
  eol: "\n" | "\r\n";
  hasBom: boolean;
  size: number;
  limitBytes: number;
  reason?: "image" | "binary" | "too_large";
}

export interface WorkspaceEditableContent {
  preview: FilePreview;
  edit: WorkspaceFileEditInfo;
}

export interface ConversationFileItem {
  id: string;
  kind: "attachment" | "output";
  partType: "image" | "video" | "audio" | "document";
  url: string;
  fileName: string;
  mime: string;
  size: number | null;
  fileId: number | null;
  nodeId: string;
  messageId: string;
  messageIndex: number;
  createdAt: string;
  toolName: string | null;
  prompt: string | null;
}

export interface ConversationChangeItem {
  path: string;
  absolutePath: string;
  inWorkspace: boolean;
  toolName: string;
  changeType: "write" | "edit";
  failed: boolean;
  finished: boolean;
  fileExists: boolean;
  nodeId: string;
  messageId: string;
  messageIndex: number;
  createdAt: string;
  diff: string | null;
}

/** 查看器数据:工作区文件用 FilePreview;会话媒体直接按 URL 播放/展示。 */
export type ViewerPreview =
  | FilePreview
  | { kind: "media"; url: string; mime: string; size: number | null };

export interface ConversationFilesResponse {
  files: ConversationFileItem[];
  changes: ConversationChangeItem[];
  workspaceId: string | null;
  /** 工具路径的解析基准(会话 workspaceCwd)。 */
  cwd: string;
  workspaceRoot: string | null;
}

/** 查看器里打开的一个文件(工作区文件或会话媒体共用一个标签模型)。 */
export interface OpenFileView {
  key: string;
  kind: "workspace" | "media";
  title: string;
  /** 工作区相对路径;媒体为 null。 */
  path: string | null;
  preview: ViewerPreview | null;
  loading: boolean;
  /** 编辑元信息(点到“编辑”时才拉取;未拉取为 null)。 */
  edit: WorkspaceFileEditInfo | null;
  /** 非 null = 编辑中;null = 只读预览。 */
  draft: string | null;
  /** 进入编辑时的原文,用于 dirty 判定与“放弃修改”。 */
  savedText: string;
  saving: boolean;
  conflict: boolean;
  error: string | null;
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

/** path 的所有祖先目录(不含自身),用于打开深层文件时展开目录树。 */
export function ancestorDirs(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const result: string[] = [""];
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    result.push(current);
  }
  return result;
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(name);
}

/** 工作区 PDF 原文地址(后端仅对 .pdf 放行 inline)。调用方负责补 web-auth query。 */
export function workspaceRawFileUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`;
}

/** 工作区相对路径的子集判断/换算(深链用)。服务端 conversation-files 的
 *  resolveToolPath 用真实路径做边界校验;这里只做展示层的字面量换算,
 *  真正越界仍由后续 workspace 文件接口拒绝。 */

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** 字面量归一化:折叠 `.`/`..` 与重复斜杠,统一盘符大写、保留大小写。 */
export function normalizeAbsolutePath(value: string): string {
  const normalized = normalizeSlashes(value).trim();
  const drive = normalized.match(/^([A-Za-z]):/);
  const rest = drive ? normalized.slice(2) : normalized;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (drive) return `${drive[1].toUpperCase()}:${joined ? `/${joined}` : "/"}`;
  return `/${joined}`;
}

/**
 * 把工具卡里的原始 path(相对 cwd 或绝对)换算成工作区根相对 posix 路径。
 * 与后端 resolveToolPath 同口径:相对路径以 cwd 为基准,合法时返回相对路径;
 * 无工作区、绝对路径落点越界或换算失败返回 null。
 */
export function resolveWorkspaceFilePath(
  rawPath: string,
  cwd: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string | null {
  const raw = rawPath.trim();
  if (!raw || !workspaceRoot) return null;
  const root = normalizeAbsolutePath(workspaceRoot).replace(/\/$/, "");
  const isAbsoluteRaw = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(raw);
  const rawCwd = cwd && cwd.trim() ? cwd.trim() : workspaceRoot;
  // workspaceCwd 契约上是绝对路径,但容错导入数据允许相对值(后端按工作区根解析)。
  const base = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(rawCwd)
    ? rawCwd
    : `${normalizeSlashes(workspaceRoot).replace(/\/$/, "")}/${normalizeSlashes(rawCwd)}`;
  const absolute = normalizeAbsolutePath(
    isAbsoluteRaw ? raw : `${normalizeSlashes(base).replace(/\/$/, "")}/${normalizeSlashes(raw)}`,
  );
  const lowerRoot = root.toLowerCase();
  const lowerAbsolute = absolute.toLowerCase();
  if (lowerAbsolute === lowerRoot) return "";
  if (!lowerAbsolute.startsWith(`${lowerRoot}/`)) return null;
  return absolute.slice(root.length + 1);
}

/** 从 /api/files/<id>/content 形式的 URL 提取库内文件 id;不是该形式返回 null。 */
export function fileIdFromUrl(url: string): number | null {
  const match = url.match(/\/api\/files\/(\d+)\/content/);
  return match ? Number(match[1]) : null;
}
