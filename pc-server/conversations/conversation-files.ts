// conversations/conversation-files.ts — 会话侧边栏的“涉及文件”汇总(0.0.3 Feature A)。
//
// 一个会话里用户能看到的文件有三类来源,面板按来源分 tab:
//   - 本次改动:选中分支里 write/edit 工具调用命中的文件(带 etag 冲突编辑的入口);
//   - 附件:用户消息里的 image/video/audio/document(上传件);
//   - 产出:工具输出与助手消息里的媒体(image/video/audio,MCP/媒体生成产物)。
//
// 路径解析以会话的 workspaceCwd 为基准(AI 工具的 cwd),再折算成工作区根的相对路径;
// 落在工作区外时 inWorkspace=false,面板只显示原文路径不提供编辑。
// 纯读函数,不落库、不广播——面板每次打开/工具收尾时按需拉取。

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Conversation, Message, MessageNode, MessagePart, State, ToolPart, Workspace } from "../foundation/types";
import { state } from "../persistence/json-store";
import { assertInsideWorkspace } from "../workspace/boundary";
import { reservedNameSafeFsPath } from "../foundation/windows-names";

export type ConversationFileKind = "attachment" | "output";
export type ConversationMediaPartType = "image" | "video" | "audio" | "document";

export interface ConversationFileItem {
  /** 稳定 key(面板列表渲染/选中)。 */
  id: string;
  kind: ConversationFileKind;
  partType: ConversationMediaPartType;
  url: string;
  fileName: string;
  mime: string;
  size: number | null;
  fileId: number | null;
  nodeId: string;
  messageId: string;
  messageIndex: number;
  createdAt: string;
  /** 工具产出时的工具名/提示词(没有则为 null)。 */
  toolName: string | null;
  prompt: string | null;
}

export interface ConversationChangeItem {
  /** 工作区内=相对根的 posix 路径;工作区外=工具拿到的原始路径。 */
  path: string;
  absolutePath: string;
  inWorkspace: boolean;
  toolName: string;
  changeType: "write" | "edit";
  failed: boolean;
  /** write/edit 已收到终局输出(流式中为 false)。 */
  finished: boolean;
  fileExists: boolean;
  nodeId: string;
  messageId: string;
  messageIndex: number;
  createdAt: string;
  /** edit 的结构化 diff(来自 tool output metadata.workspace.details.diff)。 */
  diff: string | null;
}

export interface ConversationFilesPayload {
  files: ConversationFileItem[];
  changes: ConversationChangeItem[];
  workspaceId: string | null;
  /** 工具路径的解析基准(会话 workspaceCwd,缺省工作区根)。深链把工具卡里的
   *  原始 path 换算成工作区相对路径时用,和 changes.path 同一口径。 */
  cwd: string;
  /** 工作区根绝对路径;无工作区为 null。 */
  workspaceRoot: string | null;
}

const FILE_URL_PATTERN = /\/api\/files\/(\d+)\/content/;

/** 改动类工具:pi 原名 + 安卓备份别名(§9.1B),与前端 workspace-tool-model 同口径。 */
const CHANGE_TOOL_TYPE: Record<string, "write" | "edit"> = {
  write: "write",
  edit: "edit",
  workspace_write_file: "write",
  workspace_edit_file: "edit",
};

function fileIdFromUrl(url: string): number | null {
  const match = url.match(FILE_URL_PATTERN);
  return match ? Number(match[1]) : null;
}

function storedFileFor(url: string) {
  const fileId = fileIdFromUrl(url);
  if (fileId === null) return null;
  // state 由 bootstrap 装载;单测/极早期调用下可能尚未就绪,退化为"没有库内元数据"。
  const files = (state as State | undefined)?.files;
  if (!Array.isArray(files)) return null;
  return files.find((item) => item.id === fileId) ?? null;
}

function fallbackFileName(url: string, partType: ConversationMediaPartType, fileId: number | null): string {
  const ext = partType === "image" ? "png" : partType === "video" ? "mp4" : partType === "audio" ? "mp3" : "";
  return fileId !== null ? `${partType}-${fileId}${ext ? `.${ext}` : ""}` : `${partType}${ext ? `.${ext}` : ""}`;
}

function hasErrorOutput(part: ToolPart): boolean {
  return part.output.some(
    (entry) => Boolean(entry && typeof entry === "object" && typeof (entry as { error?: unknown }).error === "string"),
  );
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function editDiffOf(part: ToolPart): string | null {
  for (const entry of part.output) {
    const record = objectField(entry);
    if (!record) continue;
    const metadata = objectField(record.metadata);
    const workspace = objectField(metadata?.workspace);
    const details = objectField(workspace?.details);
    if (details && typeof details.diff === "string") return details.diff;
  }
  return null;
}

function parseToolArgs(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input || "{}");
    return objectField(parsed) ?? {};
  } catch {
    return {};
  }
}

/** write/edit 的路径解析:相对路径以会话 cwd 为基准;返回工作区相对 posix 路径。 */
function resolveToolPath(rawPath: string, cwd: string, workspace: Workspace | null): { display: string; absolute: string; inWorkspace: boolean } {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
  if (workspace) {
    try {
      const canonicalRoot = assertInsideWorkspace(workspace.root, workspace.root);
      const canonicalTarget = assertInsideWorkspace(absolute, workspace.root);
      const rel = relative(canonicalRoot, canonicalTarget);
      return { display: rel.split(sep).join("/"), absolute: canonicalTarget, inWorkspace: rel !== "" };
    } catch {
      // 落在工作区外:保留原始输入做展示,不提供编辑入口
    }
  }
  return { display: rawPath, absolute, inWorkspace: false };
}

function selectedMessages(conversation: Conversation): Array<{ node: MessageNode; nodeIndex: number; message: Message }> {
  const result: Array<{ node: MessageNode; nodeIndex: number; message: Message }> = [];
  conversation.messages.forEach((node, nodeIndex) => {
    const message = node.messages[node.selectIndex] ?? node.messages[node.messages.length - 1];
    if (message) result.push({ node, nodeIndex, message });
  });
  return result;
}

function collectMedia(
  parts: MessagePart[],
  origin: { kind: ConversationFileKind; nodeId: string; messageId: string; messageIndex: number; createdAt: string; toolName?: string; prompt?: string },
  out: ConversationFileItem[],
): void {
  for (const [partIndex, part] of parts.entries()) {
    if (part.type !== "image" && part.type !== "video" && part.type !== "audio" && part.type !== "document") continue;
    const url = part.url;
    if (!url) continue;
    const fileId = fileIdFromUrl(url);
    const stored = storedFileFor(url);
    const fileName = part.type === "document" && part.fileName
      ? part.fileName
      : stored?.fileName ?? fallbackFileName(url, part.type, fileId);
    out.push({
      id: `${origin.kind}:${origin.messageId}:${partIndex}:${url}`,
      kind: origin.kind,
      partType: part.type,
      url,
      fileName,
      mime: part.type === "document" ? part.mime : stored?.mime ?? (part.type === "image" ? "image/png" : part.type === "video" ? "video/mp4" : "audio/mpeg"),
      size: stored?.size ?? null,
      fileId,
      nodeId: origin.nodeId,
      messageId: origin.messageId,
      messageIndex: origin.messageIndex,
      createdAt: origin.createdAt,
      toolName: origin.toolName ?? null,
      prompt: origin.prompt ?? null,
    });
  }
}

/** 收集某会话的附件/产出/本次改动。workspace 由调用方按 conversation.workspaceId 解析。 */
export function listConversationFiles(conversation: Conversation, workspace: Workspace | null): ConversationFilesPayload {
  const files: ConversationFileItem[] = [];
  const changesByPath = new Map<string, ConversationChangeItem>();
  const cwd = conversation.workspaceCwd || workspace?.root || process.cwd();

  for (const { node, nodeIndex, message } of selectedMessages(conversation)) {
    const origin = { nodeId: node.id, messageId: message.id, messageIndex: nodeIndex, createdAt: message.createdAt };

    // 用户消息里的媒体 = 附件;助手消息里直接生成的媒体 = 产出。
    collectMedia(message.parts, { ...origin, kind: message.role === "USER" ? "attachment" : "output" }, files);

    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const outputParts = part.output.filter(
        (entry): entry is MessagePart =>
          Boolean(entry && typeof entry === "object" && ["image", "video", "audio"].includes(String((entry as { type?: unknown }).type))),
      );
      if (outputParts.length > 0) {
        const args = parseToolArgs(part.input);
        const prompt = typeof args.prompt === "string" ? args.prompt : null;
        collectMedia(outputParts, { ...origin, kind: "output", toolName: part.toolName, ...(prompt ? { prompt } : {}) }, files);
      }

      const changeType = CHANGE_TOOL_TYPE[part.toolName];
      if (!changeType) continue;
      const args = parseToolArgs(part.input);
      const rawPath = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
      if (!rawPath) continue;
      const resolved = resolveToolPath(rawPath, cwd, workspace);
      let fileExists = false;
      try {
        fileExists = statSync(reservedNameSafeFsPath(resolved.absolute)).isFile();
      } catch {
        fileExists = false;
      }
      const finished = part.output.length > 0;
      const failed = part.approvalState.type === "denied" || hasErrorOutput(part);
      const item: ConversationChangeItem = {
        path: resolved.display,
        absolutePath: resolved.absolute,
        inWorkspace: resolved.inWorkspace,
        toolName: part.toolName,
        changeType,
        failed,
        finished,
        fileExists,
        nodeId: node.id,
        messageId: message.id,
        messageIndex: nodeIndex,
        createdAt: message.createdAt,
        diff: changeType === "edit" ? editDiffOf(part) : null,
      };
      // 同一文件多次改动只留最新一条(列表语义=“这次动了哪些文件”);Map 保持插入序,
      // 最后统一按 createdAt 倒序。
      changesByPath.delete(resolved.absolute);
      changesByPath.set(resolved.absolute, item);
    }
  }

  // 媒体按 url 去重(同一条消息重复引用同一附件只列一次)。
  const seen = new Set<string>();
  const uniqueFiles = files.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  return {
    files: uniqueFiles,
    changes: [...changesByPath.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    workspaceId: conversation.workspaceId ?? null,
    cwd,
    workspaceRoot: workspace?.root ?? null,
  };
}
