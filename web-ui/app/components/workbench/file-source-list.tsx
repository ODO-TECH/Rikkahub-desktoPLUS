import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Loader2,
  PencilLine,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { cn } from "~/lib/utils";

import {
  formatSize,
  isImageName,
  joinRel,
  type ConversationChangeItem,
  type ConversationFileItem,
  type ConversationFilesResponse,
  type WorkspaceFileEntry,
} from "./conversation-files-types";

// 侧边栏的来源列表(0.0.3 Feature A):本次改动 / 工作区树 / 附件 / 产出。
// 纯展示 + 回调,数据与生命周期归 conversation-files-panel。

export interface FileSourceListProps {
  source: "changes" | "files" | "attachments" | "outputs";
  workspaceRoot: string;
  conversationFiles: ConversationFilesResponse | null;
  loading: boolean;
  tree: Record<string, WorkspaceFileEntry[] | undefined>;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenMedia: (item: ConversationFileItem) => void;
  onRequestRename: (path: string, name: string) => void;
  onRequestDelete: (path: string, isDir: boolean) => void;
  onReveal: (path: string) => void;
  onRefresh: () => void;
}

function mediaIcon(partType: ConversationFileItem["partType"]) {
  if (partType === "image") return <FileImage className="size-3.5 shrink-0 text-muted-foreground" />;
  if (partType === "video") return <FileVideo className="size-3.5 shrink-0 text-muted-foreground" />;
  if (partType === "audio") return <FileAudio className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
}

function changeIcon(change: ConversationChangeItem) {
  if (change.failed) return <TriangleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (change.changeType === "edit") return <PencilLine className="size-3.5 shrink-0 text-[var(--ds-brand-primary)]" />;
  return <FileText className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
}

export function FileSourceList({
  source,
  workspaceRoot,
  conversationFiles,
  loading,
  tree,
  expanded,
  onToggleDir,
  onOpenWorkspaceFile,
  onOpenMedia,
  onRequestRename,
  onRequestDelete,
  onReveal,
  onRefresh,
}: FileSourceListProps) {
  const { t } = useTranslation();

  const renderEntries = (relPath: string, depth: number): React.ReactNode => {
    const entries = tree[relPath];
    if (entries === undefined) {
      return (
        <div className="flex items-center gap-2 px-2 py-1" style={{ paddingLeft: depth * 14 + 8 }}>
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (entries.length === 0 && relPath === "") {
      return <div className="px-3 py-6 text-center text-muted-foreground text-xs">{t("workbench.files.empty_dir")}</div>;
    }
    return entries.map((entry) => {
      const entryPath = joinRel(relPath, entry.name);
      const isOpen = entry.type === "dir" && expanded.has(entryPath);
      return (
        <React.Fragment key={entryPath}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  // 拖进聊天输入框 = 引用相对路径(textarea 原生插入 text/plain)
                  event.dataTransfer.setData("text/plain", entryPath);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => (entry.type === "dir" ? onToggleDir(entryPath) : onOpenWorkspaceFile(entryPath))}
                className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                style={{ paddingLeft: depth * 14 + 8 }}
              >
                {entry.type === "dir" ? (
                  <>
                    {isOpen ? <ChevronDown className="size-3 shrink-0 opacity-60" /> : <ChevronRight className="size-3 shrink-0 opacity-60" />}
                    {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" /> : <Folder className="size-3.5 shrink-0 text-amber-500" />}
                  </>
                ) : (
                  <>
                    <span className="w-3 shrink-0" />
                    {isImageName(entry.name)
                      ? <FileImage className="size-3.5 shrink-0 text-muted-foreground" />
                      : <File className="size-3.5 shrink-0 text-muted-foreground" />}
                  </>
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.type === "file" ? (
                  <span className="shrink-0 text-micro text-muted-foreground/70">{formatSize(entry.size)}</span>
                ) : null}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onRequestRename(entryPath, entry.name)}>
                {t("workbench.files.rename")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onReveal(entryPath)}>
                {t("workbench.files.reveal")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={() => onRequestDelete(entryPath, entry.type === "dir")}>
                {t("workbench.files.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {isOpen ? renderEntries(entryPath, depth + 1) : null}
        </React.Fragment>
      );
    });
  };

  if (loading && !conversationFiles) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (source === "files") {
    if (!workspaceRoot) {
      return <div className="px-3 py-6 text-center text-muted-foreground text-xs">{t("workbench.files.no_workspace")}</div>;
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-mini text-muted-foreground" title={workspaceRoot}>
            {workspaceRoot}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("workbench.files.refresh")}
            aria-label={t("workbench.files.refresh")}
            onClick={onRefresh}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">{renderEntries("", 0)}</div>
      </div>
    );
  }

  const items = source === "changes" ? conversationFiles?.changes ?? [] : (conversationFiles?.files ?? []).filter((item) => item.kind === (source === "attachments" ? "attachment" : "output"));

  if (items.length === 0) {
    const emptyKey = source === "changes" ? "workbench.files.empty_changes" : source === "attachments" ? "workbench.files.empty_attachments" : "workbench.files.empty_outputs";
    return <div className="px-3 py-6 text-center text-muted-foreground text-xs">{t(emptyKey)}</div>;
  }

  return (
    <div className="h-full overflow-auto py-1">
      {source === "changes"
        ? (items as ConversationChangeItem[]).map((change) => (
            <button
              key={`${change.absolutePath}:${change.createdAt}`}
              type="button"
              disabled={!change.inWorkspace || !workspaceRoot}
              onClick={() => onOpenWorkspaceFile(change.path)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                (!change.inWorkspace || !workspaceRoot) && "cursor-default opacity-60 hover:bg-transparent",
              )}
              title={change.inWorkspace ? change.path : t("workbench.files.outside_workspace")}
            >
              {changeIcon(change)}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{change.path}</span>
                <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
                  <span>{change.changeType === "edit" ? t("workbench.files.action_edit") : t("workbench.files.action_write")}</span>
                  {!change.finished ? <span>· {t("workbench.files.in_progress")}</span> : null}
                  {change.failed ? <span className="text-destructive">· {t("workbench.files.action_failed")}</span> : null}
                  {change.finished && !change.failed && !change.fileExists ? <span>· {t("workbench.files.file_missing")}</span> : null}
                  {!change.inWorkspace ? <span>· {t("workbench.files.outside_workspace")}</span> : null}
                </span>
              </span>
            </button>
          ))
        : (items as ConversationFileItem[]).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpenMedia(item)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
              title={item.fileName}
            >
              {mediaIcon(item.partType)}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.fileName}</span>
                <span className="block truncate text-micro text-muted-foreground">
                  {item.size !== null ? formatSize(item.size) : item.mime}
                  {item.toolName ? ` · ${item.toolName}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-micro text-muted-foreground">
                {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </button>
          ))}
    </div>
  );
}
