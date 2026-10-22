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
