import * as React from "react";
import { useTranslation } from "react-i18next";

import { Code2, Folder, FolderTree, ImagePlus, PanelRight } from "lucide-react";

import Markdown from "~/components/markdown/markdown";
import { MediaStudioPanel } from "~/components/media-studio/media-studio-panel";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { getCodePreviewLanguage } from "./code-preview-language";
import { ConversationFilesPanel } from "./conversation-files-panel";
import { WorkspaceFilesPanel } from "./workspace-files-panel";
import type { WorkbenchPanel } from "./workbench-context";

interface WorkbenchHostProps {
  panel: WorkbenchPanel;
  onClose: () => void;
  className?: string;
  /** 当前聚焦的会话(页面级)。会话文件面板跟随它切换——右侧栏是全局单个,
   *  换会话后必须换内容,否则会展示上一个会话的文件。 */
  activeConversationId?: string | null;
}

interface WorkbenchPanelRenderer {
  render: (panel: WorkbenchPanel, activeConversationId: string | null | undefined) => React.ReactNode;
}

function readStringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function readOpenTarget(payload: Record<string, unknown>): { path?: string; fileId?: number } | undefined {
  const raw = payload.open;
  if (!raw || typeof raw !== "object") return undefined;
  const open = raw as Record<string, unknown>;
  const path = typeof open.path === "string" && open.path ? open.path : undefined;
  const fileId = typeof open.fileId === "number" ? open.fileId : undefined;
  if (!path && fileId === undefined) return undefined;
  return { ...(path ? { path } : {}), ...(fileId !== undefined ? { fileId } : {}) };
}

function ConversationFilesRenderer({
  panel,
  activeConversationId,
}: {
  panel: WorkbenchPanel;
  activeConversationId: string | null | undefined;
}) {
  const payloadConversationId = readStringField(panel.payload, "conversationId") || undefined;
  const payloadWorkspaceId = readStringField(panel.payload, "workspaceId") || undefined;
  // 从会话打开的侧边栏 = “跟随焦点会话”:payload 只用来表明这是会话面板,
  // 真正的 id 每次渲染取当前焦点会话;换会话时 key 变化 → 面板整体重建(标签清空)。
  // 首页打开的 payload 是空的:之后进入会话也要跟着走,不能停在“还没有文件”那屏;
  // 只有 payload 明确带了 workspaceId(工作区树)时才不跟随会话。
  const followsConversation = Boolean(payloadConversationId) || !payloadWorkspaceId;
  const conversationId = followsConversation ? (activeConversationId ?? undefined) : undefined;
  const workspaceId = followsConversation ? undefined : payloadWorkspaceId;
  // payload 对象只在真正 openPanel 时换新;memo 住 open 目标,面板据此区分
  // “又一次深链请求”与“无关重渲染”(如会话文件清单刷新)。
  const open = React.useMemo(() => readOpenTarget(panel.payload), [panel.payload]);
  return (
    <ConversationFilesPanel
      key={conversationId ?? workspaceId ?? "empty"}
      conversationId={conversationId}
      workspaceId={workspaceId}
      open={open}
    />
  );
}

function CodePreviewPanel({ panel }: { panel: WorkbenchPanel }) {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"preview" | "source">("preview");

  const language = readStringField(panel.payload, "language");
  const normalizedLanguage = getCodePreviewLanguage(language);
  const code = readStringField(panel.payload, "code");

  const canRenderPreview =
    normalizedLanguage === "html" ||
    normalizedLanguage === "svg" ||
    normalizedLanguage === "markdown" ||
    normalizedLanguage === "mermaid";

  React.useEffect(() => {
    setMode(canRenderPreview ? "preview" : "source");
  }, [canRenderPreview, panel.payload]);

  const iframeDoc = React.useMemo(() => {
    if (normalizedLanguage === "html") {
      return code;
    }

    if (normalizedLanguage === "svg") {
      return `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;padding:16px;">${code}</body></html>`;
    }

    if (normalizedLanguage === "mermaid") {
      const encodedCode = encodeURIComponent(code);
      return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #1f2937;
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      #container {
        min-height: 100vh;
        box-sizing: border-box;
        padding: 16px;
        display: flex;
        justify-content: center;
      }
      #diagram {
        width: 100%;
      }
      #error {
        display: none;
        width: 100%;
        white-space: pre-wrap;
        color: #b91c1c;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 8px;
        padding: 12px;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div id="container">
      <div id="diagram"></div>
      <pre id="error"></pre>
    </div>
    <script type="module">
      import mermaid from "https://esm.sh/mermaid@11";

      const source = decodeURIComponent("${encodedCode}");
      const diagram = document.getElementById("diagram");
      const errorEl = document.getElementById("error");

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
      });

      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const result = await mermaid.render(id, source.trim());
        if (diagram) {
          diagram.innerHTML = result.svg;
        }
      } catch (error) {
        if (errorEl) {
          errorEl.style.display = "block";
          errorEl.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    </script>
  </body>
</html>`;
    }

    return "";
  }, [code, normalizedLanguage]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "preview" ? "secondary" : "ghost"}
          disabled={!canRenderPreview}
          onClick={() => {
            setMode("preview");
          }}
        >
          {t("workbench.preview")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "source" ? "secondary" : "ghost"}
          onClick={() => {
            setMode("source");
          }}
        >
          {t("workbench.source_code")}
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        {mode === "preview" && canRenderPreview ? (
          normalizedLanguage === "markdown" ? (
            <div className="h-full overflow-auto p-4">
              <Markdown content={code} />
            </div>
          ) : (
            <iframe
              title={panel.title}
              sandbox="allow-scripts"
              srcDoc={iframeDoc}
              className="h-full w-full border-0"
            />
          )
        ) : (
          <pre className="h-full overflow-auto bg-muted/30 p-4 text-xs">
            {code || t("workbench.empty_content")}
          </pre>
        )}
      </div>
    </div>
  );
}

function UnknownPanel({ panel }: { panel: WorkbenchPanel }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-xs">
        <pre>{JSON.stringify(panel.payload, null, 2)}</pre>
      </div>
    </div>
  );
}

const PANEL_RENDERERS: Record<string, WorkbenchPanelRenderer> = {
  "code-preview": {
    render: (panel) => <CodePreviewPanel panel={panel} />,
  },
  // 会话文件侧边栏(0.0.3 Feature A):改动 / 工作区 / 附件 / 产出 + 预览编辑。
  "conversation-files": {
    render: (panel, activeConversationId) => (
      <ConversationFilesRenderer panel={panel} activeConversationId={activeConversationId} />
    ),
  },
  // 工作区文件面板(M3-5,§4.4)——保留旧入口,工作区容器仍可直接打开只读树。
  "workspace-files": {
    render: (panel) => <WorkspaceFilesPanel workspaceId={readStringField(panel.payload, "workspaceId")} />,
  },
  // 媒体工作台:输入框入口导入提示词,生成图片/视频后可插入当前会话。
  "media-studio": {
    render: (panel, activeConversationId) => (
      <MediaStudioPanel panel={panel} activeConversationId={activeConversationId} />
    ),
  },
};

const TYPE_LABEL_KEYS: Record<string, string> = {
  "conversation-files": "workbench.type_labels.conversation_files",
  "workspace-files": "workbench.type_labels.workspace_files",
  "code-preview": "workbench.type_labels.code_preview",
  "media-studio": "workbench.type_labels.media_studio",
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  "conversation-files": FolderTree,
  "workspace-files": Folder,
  "code-preview": Code2,
  "media-studio": ImagePlus,
};

export function WorkbenchHost({ panel, onClose, className, activeConversationId }: WorkbenchHostProps) {
  const { t } = useTranslation();
  const renderer = PANEL_RENDERERS[panel.type];
  const typeLabelKey = TYPE_LABEL_KEYS[panel.type];
  const TypeIcon = TYPE_ICONS[panel.type] ?? FolderTree;

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground", className)}>
      {/* 头部是左栏用户行的左右镜像:左栏「头像+标题 … 收起钮(卡内侧)」,
          这里「关闭钮(卡内侧)… 图标+标题」——关闭钮落在朝中央的一侧,与左栏同构。
          头区同为 p-2 pt-3,内容行同为 px-2.5 py-2.5。不画分隔线:浮起卡片的界由圆角+投影立。 */}
      <div className="flex items-center gap-1 p-2 pt-3">
        <Button
          aria-label={t("workbench.close_panel")}
          type="button"
          size="icon"
          variant="ghost"
          className="ml-0.5 size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onClose()}
        >
          <PanelRight className="size-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 px-2.5 py-2.5">
          <div className="min-w-0 text-right">
            <div className="truncate text-sm font-medium leading-none">{panel.title}</div>
            <div className="mt-1 truncate text-muted-foreground text-xs">
              {typeLabelKey ? t(typeLabelKey) : t("workbench.type_label", { type: panel.type })}
            </div>
          </div>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-module-card-bg)] text-[var(--ds-icon)]">
            <TypeIcon className="size-4" strokeWidth={1.75} />
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {renderer ? renderer.render(panel, activeConversationId) : <UnknownPanel panel={panel} />}
      </div>
    </section>
  );
}
