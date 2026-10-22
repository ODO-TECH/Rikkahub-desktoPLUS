import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookOpenText, FolderTree, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SegmentedTabs } from "~/components/ui/segmented-tabs";
import { Textarea } from "~/components/ui/textarea";
import { extractErrorMessage } from "~/lib/error";
import api, { ApiError } from "~/services/api";
import { useConversationStore } from "~/stores/conversation-store";
import { useWorkspaceStore } from "~/stores/workspace-store";

import {
  ancestorDirs,
  baseName,
  formatSize,
  parentPath,
  resolveWorkspaceFilePath,
  type ConversationFileItem,
  type ConversationFilesResponse,
  type FilePreview,
  type OpenFileView,
  type WorkspaceEditableContent,
  type WorkspaceFileEditInfo,
  type WorkspaceFileEntry,
} from "./conversation-files-types";
import {
  clearFileDraft,
  clearFileDraftsUnder,
  countFileDrafts,
  loadFileDraft,
  saveFileDraft,
} from "./conversation-file-drafts";
import { FileSourceList } from "./file-source-list";
import { FileTabs } from "./file-tabs";
import { FileViewer } from "./file-viewer";
import { useOptionalWorkbench } from "./workbench-context";

// 会话文件侧边栏(0.0.3 Feature A)——Workbench 面板类型 "conversation-files"。
// 四个来源:本次改动(write/edit 工具命中) / 工作区文件树 / 附件 / 产出。
// 支持预览、就地编辑(Ctrl+S、etag 冲突保护、EOL/BOM 保留)与多文件标签。
// 数据即取即用;边界校验/原子写全在服务端,前端只做展示与意图表达。

type Source = "changes" | "files" | "attachments" | "outputs";

interface AgentsFileState {
  fileName: string;
  exists: boolean;
  content: string;
  template: string;
}

type DiscardAction = "close" | "cancel-edit" | "reload" | "close-panel";

interface ConversationFilesPanelProps {
  conversationId?: string;
  workspaceId?: string;
  open?: { path?: string; fileId?: number };
}

function emptyView(key: string, title: string, path: string | null, kind: "workspace" | "media"): OpenFileView {
  return {
    key,
    kind,
    title,
    path,
    preview: null,
    loading: true,
    edit: null,
    draft: null,
    savedText: "",
    saving: false,
    conflict: false,
    error: null,
  };
}

/** 不可编辑原因的人话。与服务端 WorkspaceFileEditInfo.reason 一一对应。 */
function editBlockedText(
  edit: WorkspaceFileEditInfo,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (edit.reason === "too_large") return t("workbench.files.not_editable_too_large", { limit: formatSize(edit.limitBytes) });
  if (edit.reason === "binary") return t("workbench.files.not_editable_binary");
  return t("workbench.files.not_editable_image");
}

export function ConversationFilesPanel({ conversationId, workspaceId, open }: ConversationFilesPanelProps) {
  const { t } = useTranslation();
  const workbench = useOptionalWorkbench();
  const [conversationFiles, setConversationFiles] = React.useState<ConversationFilesResponse | null>(null);
  // 工作区来源:面板显式传入优先;普通对话里由后端按 conversation.workspaceId 解析后回传。
  // 只认 store 里真实存在的工作区——被删掉的工作区不该给出可编辑的文件树。
  const resolvedWorkspaceId = workspaceId ?? conversationFiles?.workspaceId ?? undefined;
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((item) => item.id === resolvedWorkspaceId),
  );
  const [loadingConversationFiles, setLoadingConversationFiles] = React.useState(false);
  const [source, setSource] = React.useState<Source>(open?.path ? "files" : "changes");
  const [tree, setTree] = React.useState<Record<string, WorkspaceFileEntry[] | undefined>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]));
  const [files, setFiles] = React.useState<OpenFileView[]>([]);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [renameTarget, setRenameTarget] = React.useState<{ path: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{ path: string; isDir: boolean } | null>(null);
  const [agentsDialog, setAgentsDialog] = React.useState<{ data: AgentsFileState | null } | null>(null);
  const [agentsDraft, setAgentsDraft] = React.useState("");
  const [agentsSaving, setAgentsSaving] = React.useState(false);
  const [pendingDiscard, setPendingDiscard] = React.useState<{ key: string; action: DiscardAction } | null>(null);
  const filesRef = React.useRef<OpenFileView[]>([]);
  filesRef.current = files;
  // 深链目标按 payload 对象身份消费:openPanel 每次都会换新 payload,借此区分
  // “用户又点了一个附件/工具卡”与“会话文件清单刷新导致的重渲染”——后者不能
  // 把用户从正在看的文件上拽走。
  const consumedOpenRef = React.useRef<typeof open | null>(null);

  // 关闭面板守卫:有未保存草稿时不直接关,先弹确认(与关闭标签同一套文案)。
  React.useEffect(() => {
    if (!workbench?.setCloseGuard) return;
    workbench.setCloseGuard(() => {
      const victim = filesRef.current.find((view) => view.draft !== null && view.draft !== view.savedText);
      if (!victim) return true;
      setActiveKey(victim.key);
      setPendingDiscard({ key: victim.key, action: "close-panel" });
      return false;
    });
    return () => workbench.setCloseGuard(null);
  }, [workbench]);

  const effectiveWorkspaceId = workspace?.id ?? workspaceId ?? null;
  const workspaceRoot = workspace?.root ?? "";
  const activeFile = files.find((item) => item.key === activeKey) ?? null;
  // 未保存草稿的暂存作用域:面板会随会话切换卸载,草稿靠模块级 store 渡过去。
  // 会话优先(同一工作区里不同会话的草稿互不串),纯工作区面板用 w: 前缀。
  const draftScope = conversationId
    ? `c:${conversationId}`
    : effectiveWorkspaceId
      ? `w:${effectiveWorkspaceId}`
      : null;

  // 切换会话再回来:标签已随卸载消失,但脏草稿还在暂存里;提示用户重新打开即可续编。
  React.useEffect(() => {
    if (!draftScope) return;
    const count = countFileDrafts(draftScope);
    if (count > 0) toast.info(t("workbench.files.drafts_kept", { count }));
  }, [draftScope, t]);

  const updateFile = React.useCallback((key: string, patch: Partial<OpenFileView> | ((view: OpenFileView) => Partial<OpenFileView>)) => {
    setFiles((prev) => prev.map((view) => (view.key === key ? { ...view, ...(typeof patch === "function" ? patch(view) : patch) } : view)));
  }, []);

  // ── 会话文件清单(改动/附件/产出)──────────────────────────────
  const refreshConversationFiles = React.useCallback(async () => {
    if (!conversationId) return;
    setLoadingConversationFiles(true);
    try {
      const res = await api.get<ConversationFilesResponse>(`conversations/${conversationId}/files`);
      setConversationFiles(res);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setLoadingConversationFiles(false);
    }
  }, [conversationId, t]);

  React.useEffect(() => {
    void refreshConversationFiles();
  }, [refreshConversationFiles]);

  // 流式期间工具落盘后自动刷新:会话 updateAt 变化 → 250ms 节流重拉。
  const detailUpdateAt = useConversationStore((state) =>
    conversationId ? state.entries[conversationId]?.detail?.updateAt : undefined,
  );
  React.useEffect(() => {
    if (!conversationId || detailUpdateAt === undefined) return;
    const timer = setTimeout(() => {
      void refreshConversationFiles();
    }, 250);
    return () => clearTimeout(timer);
  }, [detailUpdateAt, conversationId, refreshConversationFiles]);

  React.useEffect(() => {
    if (!conversationId) return;
    const onFocus = () => {
      void refreshConversationFiles();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [conversationId, refreshConversationFiles]);

  // ── 工作区文件树 ──────────────────────────────────────────────
  const loadDir = React.useCallback(
    async (relPath: string) => {
      if (!effectiveWorkspaceId) return;
      try {
        const res = await api.get<{ entries: WorkspaceFileEntry[] }>(
          `workspaces/${effectiveWorkspaceId}/files?path=${encodeURIComponent(relPath)}`,
        );
        setTree((prev) => ({ ...prev, [relPath]: res.entries }));
      } catch (err) {
        toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      }
    },
    [effectiveWorkspaceId, t],
  );

  React.useEffect(() => {
    if (!effectiveWorkspaceId) return;
    setTree({});
    setExpanded(new Set([""]));
    void loadDir("");
  }, [effectiveWorkspaceId, loadDir]);

  const toggleDir = (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else {
        next.add(relPath);
        if (tree[relPath] === undefined) void loadDir(relPath);
      }
      return next;
    });
  };

  const reloadParentOf = React.useCallback(
    (relPath: string) => {
      void loadDir(parentPath(relPath));
    },
    [loadDir],
  );

  // ── 打开/加载文件 ────────────────────────────────────────────
  const fetchPreview = React.useCallback(
    async (view: OpenFileView) => {
      if (!effectiveWorkspaceId || !view.path) return;
      updateFile(view.key, { loading: true, error: null });
      try {
        const res = await api.get<{ preview: FilePreview }>(
          `workspaces/${effectiveWorkspaceId}/files/content?path=${encodeURIComponent(view.path)}`,
        );
        updateFile(view.key, {
          preview: res.preview,
          loading: false,
          edit: null,
          draft: null,
          savedText: "",
          conflict: false,
        });
      } catch (err) {
        updateFile(view.key, { loading: false, error: extractErrorMessage(err, t("workbench.files.failed")) });
      }
    },
    [effectiveWorkspaceId, t, updateFile],
  );

  /** 进入编辑。若该文件有跨会话暂存的草稿,恢复它;磁盘在草稿之后又变过则亮冲突横幅
   *  (savedText/etag 取最新磁盘值,保存走覆盖或重新加载,不会静默吞掉别人的修改)。 */
  const startEdit = React.useCallback(
    async (view: OpenFileView) => {
      if (!effectiveWorkspaceId || !view.path) return;
      try {
        const res = await api.get<WorkspaceEditableContent>(
          `workspaces/${effectiveWorkspaceId}/files/content?path=${encodeURIComponent(view.path)}&mode=edit`,
        );
        if (!res.edit.editable) {
          if (draftScope) clearFileDraft(draftScope, view.path);
          updateFile(view.key, { edit: res.edit, loading: false });
          toast.info(editBlockedText(res.edit, t));
          return;
        }
        const diskText = res.preview.kind === "text" ? res.preview.text : "";
        const stored = draftScope ? loadFileDraft(draftScope, view.path) : null;
        const restoring = stored !== null && stored.text !== diskText;
        updateFile(view.key, {
          preview: res.preview,
          loading: false,
          edit: res.edit,
          draft: restoring ? stored.text : diskText,
          savedText: diskText,
          conflict: Boolean(restoring && stored.etag !== null && stored.etag !== res.edit.etag),
          error: null,
        });
        if (draftScope) {
          if (restoring) {
            saveFileDraft(draftScope, view.path, { text: stored.text, savedText: diskText, etag: res.edit.etag });
          } else {
            clearFileDraft(draftScope, view.path);
          }
        }
      } catch (err) {
        updateFile(view.key, { loading: false, error: extractErrorMessage(err, t("workbench.files.failed")) });
      }
    },
    [draftScope, effectiveWorkspaceId, t, updateFile],
  );

  const openWorkspaceFile = React.useCallback(
    (relPath: string) => {
      const key = `ws:${relPath}`;
      const existing = filesRef.current.find((item) => item.key === key);
      setFiles((prev) => (prev.some((item) => item.key === key) ? prev : [...prev, emptyView(key, baseName(relPath), relPath, "workspace")]));
      setActiveKey(key);
      setExpanded((prev) => new Set([...prev, ...ancestorDirs(relPath)]));
      for (const dir of ancestorDirs(relPath)) {
        if (tree[dir] === undefined) void loadDir(dir);
      }
      // 已经开着的标签不重新读盘:否则从附件/工具卡再次深链同一文件时,正在编辑的
      // 草稿会被一次 preview 刷新冲掉。刷新走工具栏的重新加载。
      if (existing) return;
      const view = emptyView(key, baseName(relPath), relPath, "workspace");
      if (draftScope && loadFileDraft(draftScope, relPath)) void startEdit(view);
      else void fetchPreview(view);
    },
    [draftScope, fetchPreview, loadDir, startEdit, tree],
  );

  const openMedia = React.useCallback((item: ConversationFileItem) => {
    const key = `media:${item.id}`;
    setFiles((prev) => {
      if (prev.some((view) => view.key === key)) return prev;
      return [
        ...prev,
        {
          ...emptyView(key, item.fileName, null, "media"),
          loading: false,
          preview: { kind: "media", url: item.url, mime: item.mime, size: item.size },
        },
      ];
    });
    setActiveKey(key);
    setSource(item.kind === "attachment" ? "attachments" : "outputs");
  }, []);

  // 外部入口(从消息 chip / 工具卡 / 改动列表跳转):每个 open 目标消费一次。
  // 面板已开着时再次深链会换新 payload → 新 open 身份 → 这里重新消费,
  // 不会因为首次打开后的 didOpen 标记而失效。
  React.useEffect(() => {
    if (!open) return;
    if (consumedOpenRef.current === open) return;
    if (open.path) {
      // 路径换算依赖清单里的 cwd/workspaceRoot(工具路径以会话 cwd 为基准),
      // 首次还没拿到清单时先等,避免把 "src/a.ts" 当成工作区根相对路径。
      if (!workspace || !conversationFiles) return;
      consumedOpenRef.current = open;
      const resolved = resolveWorkspaceFilePath(open.path, conversationFiles.cwd, conversationFiles.workspaceRoot);
      if (resolved === null) {
        toast.error(t("workbench.files.outside_workspace"));
        return;
      }
      setSource("files");
      openWorkspaceFile(resolved);
      return;
    }
    if (open.fileId !== undefined && conversationFiles) {
      consumedOpenRef.current = open;
      const target = conversationFiles.files.find((item) => item.fileId === open.fileId);
      if (target) openMedia(target);
      else toast.info(t("workbench.files.deep_link_missing"));
    }
  }, [conversationFiles, open, openMedia, openWorkspaceFile, t, workspace]);

  // ── 编辑/保存 ────────────────────────────────────────────────
  const saveFile = React.useCallback(
    async (key: string, options?: { force?: boolean }) => {
      const view = filesRef.current.find((item) => item.key === key);
      if (!view || view.draft === null || !view.path || !effectiveWorkspaceId) return;
      updateFile(key, { saving: true, conflict: false, error: null });
      try {
        let baseEtag = view.edit?.etag ?? null;
        if (options?.force) {
          // 覆盖保存:先取磁盘当前 etag(不改草稿),再用它提交。
          const latest = await api.get<WorkspaceEditableContent>(
            `workspaces/${effectiveWorkspaceId}/files/content?path=${encodeURIComponent(view.path)}&mode=edit`,
          );
          baseEtag = latest.edit.etag;
        }
        const content = view.draft;
        const res = await api.put<{ etag: string; size: number; modifiedAt: number }>(
          `workspaces/${effectiveWorkspaceId}/files/content?path=${encodeURIComponent(view.path)}`,
          { content, baseEtag, eol: view.edit?.eol ?? "\n" },
        );
        updateFile(key, {
          draft: null,
          savedText: content,
          preview: { kind: "text", text: content, truncated: false, size: res.size },
          edit: view.edit ? { ...view.edit, etag: res.etag, size: res.size } : view.edit,
          saving: false,
          conflict: false,
        });
        if (draftScope && view.path) clearFileDraft(draftScope, view.path);
        toast.success(t("workbench.files.saved"));
        reloadParentOf(view.path);
      } catch (err) {
        if (err instanceof ApiError && err.code === 409) {
          updateFile(key, { saving: false, conflict: true });
          return;
        }
        updateFile(key, { saving: false, error: extractErrorMessage(err, t("workbench.files.failed")) });
        toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      }
    },
    [draftScope, effectiveWorkspaceId, reloadParentOf, t, updateFile],
  );

  /** 编辑区输入:同步组件 state 与跨会话暂存。回到原文等于放弃改动,直接清暂存。 */
  const changeDraft = (view: OpenFileView, text: string) => {
    updateFile(view.key, { draft: text });
    if (!draftScope || !view.path) return;
    if (text === view.savedText) {
      clearFileDraft(draftScope, view.path);
      return;
    }
    saveFileDraft(draftScope, view.path, { text, savedText: view.savedText, etag: view.edit?.etag ?? null });
  };

  const isDirty = (view: OpenFileView) => view.draft !== null && view.draft !== view.savedText;

  const requestDiscard = (key: string, action: DiscardAction) => {
    const view = filesRef.current.find((item) => item.key === key);
    if (!view) return;
    if (!isDirty(view)) {
      void applyDiscard(key, action);
      return;
    }
    setPendingDiscard({ key, action });
  };

  const applyDiscard = async (key: string, action: DiscardAction) => {
    const view = filesRef.current.find((item) => item.key === key);
    if (!view) return;
    // 明确放弃/关闭/重载:该文件的暂存草稿一并清掉,避免下次打开又"复活"旧改动。
    if (draftScope && view.path) clearFileDraft(draftScope, view.path);
    if (action === "close-panel") {
      // 守卫已确认放弃草稿:force 关闭,避免再次触发守卫。
      workbench?.closePanel(true);
      return;
    }
    if (action === "close") {
      setFiles((prev) => {
        const index = prev.findIndex((item) => item.key === key);
        const next = prev.filter((item) => item.key !== key);
        setActiveKey((current) => {
          if (current !== key) return current;
          return next[Math.max(0, index - 1)]?.key ?? null;
        });
        return next;
      });
      return;
    }
    if (action === "cancel-edit") {
      // 放弃本次编辑:回到编辑前的磁盘内容(savedText),编辑态与冲突标记一并清除。
      updateFile(key, {
        draft: null,
        savedText: "",
        conflict: false,
        edit: null,
        preview:
          view.preview?.kind === "text"
            ? { ...view.preview, text: view.savedText, truncated: false }
            : view.preview,
      });
      return;
    }
    // reload:丢弃草稿并重读磁盘(冲突横幅里的“重新加载”也走这里)。
    await fetchPreview(view);
  };

  const reloadFile = (key: string) => {
    requestDiscard(key, "reload");
  };

  const closeTab = (key: string) => {
    requestDiscard(key, "close");
  };

  // ── 重命名/删除/定位(工作区面板既有能力)────────────────────
  /** 重命名/删除后收掉受影响的标签:路径已不存在,留着点开就是 404。 */
  const closeWorkspaceTabs = (relPath: string) => {
    const removed = new Set(
      filesRef.current
        .filter((view) => view.path === relPath || (view.path !== null && view.path.startsWith(`${relPath}/`)))
        .map((view) => view.key),
    );
    if (removed.size === 0) return;
    if (draftScope) clearFileDraftsUnder(draftScope, relPath);
    setFiles((prev) => prev.filter((view) => !removed.has(view.key)));
    setActiveKey((current) => (current !== null && removed.has(current) ? null : current));
  };

  const doRename = async (newName: string) => {
    if (!renameTarget || !effectiveWorkspaceId || !newName.trim() || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const target = renameTarget;
    try {
      await api.post(`workspaces/${effectiveWorkspaceId}/files/rename`, { path: target.path, newName: newName.trim() });
      closeWorkspaceTabs(target.path);
      reloadParentOf(target.path);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setRenameTarget(null);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget || !effectiveWorkspaceId) return;
    const target = deleteTarget;
    try {
      await api.delete(`workspaces/${effectiveWorkspaceId}/files?path=${encodeURIComponent(target.path)}`);
      closeWorkspaceTabs(target.path);
      reloadParentOf(target.path);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setDeleteTarget(null);
    }
  };

  const doReveal = async (relPath: string) => {
    if (!effectiveWorkspaceId) return;
    try {
      await api.post(`workspaces/${effectiveWorkspaceId}/files/reveal`, { path: relPath });
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    }
  };

  const openAgentsDialog = async () => {
    if (!effectiveWorkspaceId) return;
    setAgentsDialog({ data: null });
    try {
      const res = await api.get<{ agentsFile: AgentsFileState }>(`workspaces/${effectiveWorkspaceId}/agents-file`);
      setAgentsDialog((current) => (current ? { data: res.agentsFile } : current));
      setAgentsDraft(res.agentsFile.exists ? res.agentsFile.content : res.agentsFile.template);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
      setAgentsDialog(null);
    }
  };

  const saveAgentsFile = async () => {
    if (!agentsDialog?.data || !effectiveWorkspaceId) return;
    setAgentsSaving(true);
    try {
      const wasNew = !agentsDialog.data.exists;
      await api.put(`workspaces/${effectiveWorkspaceId}/agents-file`, { content: agentsDraft });
      toast.success(t("workbench.files.agents_saved"));
      setAgentsDialog(null);
      if (wasNew) void loadDir("");
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workbench.files.failed")));
    } finally {
      setAgentsSaving(false);
    }
  };

  // ── 渲染 ────────────────────────────────────────────────────
  const sourceItems = React.useMemo(() => {
    const items = [
      { value: "changes" as const, label: `${t("workbench.files.tab_changes")}${conversationFiles ? ` ${conversationFiles.changes.length}` : ""}` },
      ...(effectiveWorkspaceId ? [{ value: "files" as const, label: t("workbench.files.tab_files") }] : []),
      { value: "attachments" as const, label: `${t("workbench.files.tab_attachments")}${conversationFiles ? ` ${conversationFiles.files.filter((item) => item.kind === "attachment").length}` : ""}` },
      { value: "outputs" as const, label: `${t("workbench.files.tab_outputs")}${conversationFiles ? ` ${conversationFiles.files.filter((item) => item.kind === "output").length}` : ""}` },
    ];
    return items;
  }, [conversationFiles, effectiveWorkspaceId, t]);

  React.useEffect(() => {
    // 工作区 tab 消失(无工作区)时避免停留在空 tab。
    if (!effectiveWorkspaceId && source === "files") setSource("changes");
  }, [effectiveWorkspaceId, source]);

  const refreshAll = () => {
    void refreshConversationFiles();
    if (effectiveWorkspaceId) {
      setTree({});
      setExpanded(new Set([""]));
      void loadDir("");
    }
  };

  // 首页直接点顶栏开关也会走到这里:没有会话就没有“改动/附件/产出”,没有工作区就没有
  // 文件树。给一屏说明代替一句“请先打开会话”,用户知道文件从哪里来。
  if (!conversationId && !effectiveWorkspaceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <FolderTree className="size-5 text-muted-foreground" strokeWidth={1.75} />
        </div>
        <div className="space-y-1">
          <div className="font-medium text-sm">{t("workbench.files.empty_title")}</div>
          <p className="mx-auto max-w-56 text-muted-foreground text-xs leading-5">
            {t("workbench.files.empty_desc")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <SegmentedTabs
          items={sourceItems}
          value={source}
          onChange={(next) => {
            setSource(next);
            // 切换来源即回到该来源的列表:已打开的文件留在标签条里(草稿不丢),
            // 否则用户点了“附件 / 产出”却仍停在上一个文件的预览上,像是没响应。
            setActiveKey(null);
            if (next === "files" && tree[""] === undefined) void loadDir("");
          }}
          size="sm"
          className="min-w-0"
        />
        <div className="ml-auto flex shrink-0 items-center">
          {source === "files" && effectiveWorkspaceId ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("workbench.files.agents_edit")}
              title={t("workbench.files.agents_edit")}
              onClick={() => void openAgentsDialog()}
            >
              <BookOpenText className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("workbench.files.refresh")}
            title={t("workbench.files.refresh")}
            onClick={refreshAll}
          >
            {loadingConversationFiles ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      {files.length > 0 ? (
        <FileTabs
          tabs={files.map((view) => ({ key: view.key, title: view.title, dirty: isDirty(view) }))}
          activeKey={activeKey}
          onSelect={setActiveKey}
          onClose={closeTab}
          onBack={() => setActiveKey(null)}
        />
      ) : null}

      <div className="min-h-0 flex-1">
        {activeFile ? (
          <FileViewer
            file={activeFile}
            workspaceId={effectiveWorkspaceId}
            onStartEdit={() => void startEdit(activeFile)}
            onCancelEdit={() => requestDiscard(activeFile.key, "cancel-edit")}
            onDraftChange={(text) => changeDraft(activeFile, text)}
            onSave={() => void saveFile(activeFile.key)}
            onReload={() => reloadFile(activeFile.key)}
            onOverwrite={() => void saveFile(activeFile.key, { force: true })}
            onReveal={() => {
              if (activeFile.path) void doReveal(activeFile.path);
            }}
          />
        ) : (
          <FileSourceList
            source={source}
            workspaceRoot={workspaceRoot}
            conversationFiles={conversationFiles}
            loading={loadingConversationFiles}
            tree={tree}
            expanded={expanded}
            onToggleDir={toggleDir}
            onOpenWorkspaceFile={openWorkspaceFile}
            onOpenMedia={openMedia}
            onRequestRename={(path, name) => setRenameTarget({ path, name })}
            onRequestDelete={(path, isDir) => setDeleteTarget({ path, isDir })}
            onReveal={(path) => void doReveal(path)}
            onRefresh={() => {
              setTree({});
              setExpanded(new Set([""]));
              void loadDir("");
            }}
          />
        )}
      </div>

      <Dialog open={pendingDiscard !== null} onOpenChange={(isOpen) => { if (!isOpen) setPendingDiscard(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.discard_title")}</DialogTitle>
            <DialogDescription>{t("workbench.files.discard_desc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPendingDiscard(null)}>
              {t("workbench.files.keep_editing")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!pendingDiscard) return;
                const pending = pendingDiscard;
                setPendingDiscard(null);
                void applyDiscard(pending.key, pending.action);
              }}
            >
              {t("workbench.files.discard_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.rename")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void doRename(String(new FormData(event.currentTarget).get("name") ?? ""));
            }}
          >
            <Input name="name" defaultValue={renameTarget?.name ?? ""} autoFocus />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenameTarget(null)}>{t("workbench.files.cancel")}</Button>
              <Button type="submit">{t("workbench.files.confirm")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={agentsDialog !== null} onOpenChange={(isOpen) => { if (!isOpen) setAgentsDialog(null); }}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.agents_dialog_title", { name: agentsDialog?.data?.fileName ?? "AGENTS.md" })}</DialogTitle>
            <DialogDescription>
              {agentsDialog?.data && !agentsDialog.data.exists
                ? t("workbench.files.agents_dialog_create_hint")
                : t("workbench.files.agents_dialog_edit_hint")}
            </DialogDescription>
          </DialogHeader>
          {agentsDialog?.data === null ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Textarea
              value={agentsDraft}
              onChange={(event) => setAgentsDraft(event.target.value)}
              spellCheck={false}
              className="min-h-64 flex-1 resize-none font-mono text-xs leading-5"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAgentsDialog(null)}>{t("workbench.files.cancel")}</Button>
            <Button type="button" disabled={agentsSaving || !agentsDialog?.data} onClick={() => void saveAgentsFile()}>
              {agentsSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("workbench.files.agents_save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("workbench.files.delete")}</DialogTitle>
            <DialogDescription>
              {t(deleteTarget?.isDir ? "workbench.files.delete_dir_confirm" : "workbench.files.delete_file_confirm", {
                name: deleteTarget?.path ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)}>{t("workbench.files.cancel")}</Button>
            <Button type="button" variant="destructive" onClick={() => void doDelete()}>{t("workbench.files.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
