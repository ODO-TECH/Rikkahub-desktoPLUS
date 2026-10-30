import * as React from "react";

import { useNavigate, useParams, useSearchParams } from "react-router";

import {
  ConversationQuickJump,
  getConversationMessageAnchorId,
  type ConversationQuickJumpItem,
} from "~/components/conversation-quick-jump";
import { ConversationSidebar } from "~/components/conversation-sidebar";
import { ConversationEmptyState } from "~/components/extended/conversation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ChatInput } from "~/components/input/chat-input";
import { VoiceModeBanner } from "~/components/input/voice-mode-banner";
import { useVoiceModeState, voiceMode } from "~/lib/voice/voice-mode";
import { MessageQueuePanel } from "~/components/input/message-queue-panel";
import { GlobalDropZone } from "~/components/global-drop-zone";
import { ChatMessage, useCurrentContextLimit } from "~/components/message/chat-message";
import { CompactionDetailDialog } from "~/components/message/compaction-detail-dialog";
import { CompactionDivider } from "~/components/message/compaction-divider";
import { CompactionSummaryCard } from "~/components/message/compaction-summary-card";
import { ShareExportDialog } from "~/components/message/share-export-dialog";
import { RenameConversationDialog } from "~/components/rename-conversation-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Drawer, DrawerContent } from "~/components/ui/drawer";
import { Input } from "~/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/components/ui/resizable";
import { Slider } from "~/components/ui/slider";
import { TypingIndicator } from "~/components/ui/typing-indicator";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { useIsMobile } from "~/hooks/use-mobile";
import { useAvailableCommands } from "~/hooks/use-available-commands";
import { useConversationList } from "~/hooks/use-conversation-list";
import { useCompactionCandidateCount } from "~/hooks/use-compaction-candidate-count";
import { onHotkeyAction, type HotkeyBusAction } from "~/lib/hotkey-events";
import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import type { SlashCommandDto } from "~/lib/slash-commands";
import { convertConversationToMarkdown, safeMarkdownFilename } from "~/lib/export-markdown";
import { exportTextFile } from "~/lib/export-file";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import {
  buildCompactionAnchors,
  compactionAfterMessage,
  compactionDividerBelow,
  COMPRESS_KEEP_RECENT_DEFAULT,
  COMPRESS_RATIO_DEFAULT,
  COMPRESS_RATIO_MAX,
  COMPRESS_RATIO_MIN,
  COMPRESS_RATIO_WARN,
  compressRatioToTargetTokens,
  contextWarningPercent,
  latestCompactionPlacement,
  normalizeCompressKeepRecent,
  normalizeCompressRatio,
  type CompactionAnchorInfo,
} from "~/lib/compaction";
import api, { ApiError } from "~/services/api";
import { useChatInputStore } from "~/stores";
import { confirmDialog } from "~/stores/confirm-store";
import {
  evictConversations,
  useConversationEngineStatus,
  useConversationEntry,
  useConversationStore,
} from "~/stores/conversation-store";
import {
  ensureFullConversationDetail,
  loadOlderConversationNodes,
  refreshConversation,
  setConversationStreamAttention,
  useConversationSubscription,
} from "~/stores/conversation-stream";
import { WorkbenchHost } from "~/components/workbench/workbench-host";
import { ConversationFilesLauncherProvider } from "~/components/workbench/conversation-files-launcher";
import { ContainerPlusMenu } from "~/components/workspace/container-plus-menu";
import { ContainerTabBar } from "~/components/workspace/container-tab-bar";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { ConversationTabStrip } from "~/components/workspace/conversation-tab-strip";
import { EngineStatusBar } from "~/components/workspace/engine-status-bar";
import { PaneContainerProvider } from "~/components/workspace/pane-container-context";
import { WorkspaceEmptyState } from "~/components/workspace/workspace-empty-state";
import { useCompressStore, useConversationCompressing } from "~/stores/compress-store";
import { openSettingsDialog } from "~/stores/settings-dialog-store";
import {
  useConversationEditingSession,
  useEditingStore,
  type EditingSession,
} from "~/stores/editing-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import {
  CHAT_CONTAINER,
  MAX_PANES,
  flattenColumns,
  groupSiblingOf,
  type ContainerKey,
  type PaneColumn,
  useContainerTabsStore,
} from "~/stores/container-tabs-store";
import { useTabDragStore } from "~/stores/tab-drag-store";
import {
  type WorkbenchPanel,
  useWorkbench,
  useWorkbenchController,
  WorkbenchProvider,
} from "~/components/workbench/workbench-context";
import {
  type ConversationListDto,
  type MessageNodeDto,
  type MessageDto,
  type ProviderModel,
  type Settings,
  type UIMessagePart,
} from "~/types";
import {
  ArrowDown,
  Check,
  ListChecks,
  Loader2,
  MessageSquare,
  PanelRight,
  Pencil,
  X,
} from "lucide-react";
import { EmptyGreeting } from "~/components/empty-greeting";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import i18n from "~/i18n";
import { TtsPlayBar } from "~/components/tts-play-bar";

interface SelectedNodeMessage {
  node: MessageNodeDto;
  message: MessageNodeDto["messages"][number];
}

function ConversationSystemPromptButton({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (value: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");
  const [saving, setSaving] = React.useState(false);
  const hasCustomPrompt = Boolean(value?.trim());
  const { t } = useTranslation("page");

  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const save = async (nextValue: string) => {
    setSaving(true);
    try {
      await onSave(nextValue);
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center px-4 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setExpanded((current) => !current)}
      >
        <Pencil className="size-3.5" />
        <span>
          {hasCustomPrompt
            ? t("conversations.custom_prompt.button_active")
            : t("conversations.custom_prompt.button")}
        </span>
      </Button>
      {expanded ? (
        <div className="mt-2 w-full max-w-3xl space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-28 resize-y"
            placeholder={t("conversations.custom_prompt.placeholder")}
          />
          <div className="flex justify-end gap-2">
            {hasCustomPrompt ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => void save("")}
              >
                {t("conversations.custom_prompt.clear")}
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={saving} onClick={() => void save(draft)}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("conversations.custom_prompt.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const EDIT_DRAFT_ATTACHMENT_MARK = "__from_message_attachment";
const EDIT_DRAFT_SOURCE_INDEX = "__from_message_source_index";
const EMPTY_INPUT_ATTACHMENTS: UIMessagePart[] = [];
const EMPTY_SUGGESTIONS: string[] = [];
// Virtuoso 的 components 必须引用稳定(官方文档明确要求):内联对象每次渲染都是
// 新的组件类型,Header/Footer 被反复卸载重挂 → 尺寸重测(skipAnimationFrameIn-
// ResizeObserver 下同帧同步)→ rangeChanged → setState → 再渲染 → 又是新类型……
// 嵌套更新超 50 次即 React #185 白屏(桌面端快速切换会话高发,崩溃栈实锤 rangeChanged)。
const VirtuosoListPadding = () => <div className="h-4" />;
const VIRTUOSO_COMPONENTS = { Header: VirtuosoListPadding, Footer: VirtuosoListPadding };
// 右侧工作台是组外的一张固定宽浮卡:宽度用像素持久化、自绘分隔条拖拽调整。
// 不再参与 react-resizable-panels 的布局——v4 的 resize()/重注册与 React 状态各记一份,
// 关合竞态下会脱钩(点了没反应/关不掉),命令式补丁越堆越脆。
const WORKBENCH_DEFAULT_WIDTH_PX = 420;
const WORKBENCH_MIN_WIDTH_PX = 240;
const WORKBENCH_MAX_WIDTH_RATIO = 0.6;
const WORKBENCH_WIDTH_KEY = "workbench-width-px";

function readWorkbenchWidth(): number {
  try {
    const parsed = Number(localStorage.getItem(WORKBENCH_WIDTH_KEY));
    if (Number.isFinite(parsed) && parsed >= WORKBENCH_MIN_WIDTH_PX) return parsed;
  } catch {
    // 读不到用默认。
  }
  return WORKBENCH_DEFAULT_WIDTH_PX;
}

function saveWorkbenchWidth(px: number): void {
  try {
    localStorage.setItem(WORKBENCH_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // 存不进就只保留内存态。
  }
}
const COMPRESS_KEEP_OPTIONS = [0, 16, 32, 64];
const TRANSLATION_LANGUAGES = [
  { value: "zh-CN" },
  { value: "zh-TW" },
  { value: "en-US" },
  { value: "ja-JP" },
  { value: "ko-KR" },
  { value: "fr-FR" },
  { value: "de-DE" },
  { value: "es-ES" },
];

interface EditDraft {
  text: string;
  attachments: UIMessagePart[];
  sourceParts: UIMessagePart[];
  textPartIndex: number | null;
}

// 侧栏收起(offcanvas 全隐)或移动端时,正文列顶行需要一个展开入口;
// 常态下折叠按钮在侧栏头部(前端重构A1,明暗切换同步迁往侧栏底部)。
function CollapsedSidebarTrigger() {
  const { isMobile, state } = useSidebar();
  if (!isMobile && state !== "collapsed") return null;
  return <SidebarTrigger className="pointer-events-auto relative z-50 mb-1" />;
}

// 右侧工作台(文件侧边栏)的常驻开关:与左侧 CollapsedSidebarTrigger 同款幽灵图标,
// 面板开着就关、关着就按焦点会话/工作区打开。首页没有会话/工作区也照常打开——
// 面板里给出说明,不做“点了没反应”的禁用态。窄屏由抽屉自己的关闭入口负责,不渲染。
function WorkbenchToggle({
  conversationId,
  workspaceId,
  workspaceName,
}: {
  conversationId?: string | null;
  workspaceId?: string;
  workspaceName?: string;
}) {
  const { t } = useTranslation();
  const { panel, openPanel, closePanel } = useWorkbench();
  const isOpen = Boolean(panel);
  const label = isOpen
    ? t("workbench.toggle_close", "关闭文件侧边栏")
    : t("workbench.toggle_open", "打开文件侧边栏");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="pointer-events-auto relative z-50 mb-1 size-7"
      title={label}
      aria-label={label}
      aria-pressed={isOpen}
      onClick={() => {
        if (isOpen) {
          closePanel();
          return;
        }
        // 没有会话也没有工作区时也打开面板(空态里告诉用户怎么产生文件),
        // 与左侧栏折叠钮一致:任何时候点了都有反馈。
        openPanel({
          type: "conversation-files",
          title: workspaceName ?? t("workbench.files.title", "文件面板"),
          payload: conversationId ? { conversationId } : workspaceId ? { workspaceId } : {},
        });
      }}
    >
      <PanelRight className="size-4" strokeWidth={1.75} />
    </Button>
  );
}

// 右侧工作台浮卡:对话分栏组之外的 flex 兄弟。宽度是本地像素状态,开合直接由
// 「open ? 宽度 : 0」驱动 CSS 过渡——没有命令式布局、没有延时校准,状态与画面不会脱钩。
// 拖分隔条到近 0 即收起;宽度记忆在 pointerup 时落盘,重开还是原宽。
function WorkbenchSide({
  open,
  onClose,
  panel,
  activeConversationId,
}: {
  open: boolean;
  onClose: () => void;
  panel: WorkbenchPanel | null;
  activeConversationId?: string | null;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = React.useState(readWorkbenchWidth);
  const [dragging, setDragging] = React.useState(false);
  const widthRef = React.useRef(width);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const maxWidth = Math.max(
      WORKBENCH_MIN_WIDTH_PX,
      Math.round(window.innerWidth * WORKBENCH_MAX_WIDTH_RATIO),
    );
    setDragging(true);
    handle.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      // 往左拖 = 变宽(右栏镜像),往右拖到底 = 收起。
      const next = Math.min(maxWidth, Math.max(0, startWidth + (startX - moveEvent.clientX)));
      widthRef.current = next;
      setWidth(next);
    };
    const finish = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      setDragging(false);
      if (widthRef.current < WORKBENCH_MIN_WIDTH_PX) {
        // 收起是布局动作,不覆盖宽度记忆:下次打开仍是拖拽前的宽度。
        widthRef.current =
          startWidth >= WORKBENCH_MIN_WIDTH_PX ? startWidth : WORKBENCH_DEFAULT_WIDTH_PX;
        setWidth(widthRef.current);
        onClose();
        return;
      }
      saveWorkbenchWidth(widthRef.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("workbench.resize", "调整文件侧边栏宽度")}
        onPointerDown={startDrag}
        className={cn(
          "relative z-10 w-2 shrink-0 cursor-col-resize touch-none transition-[width] duration-200 ease-linear",
          "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-border/70",
          !open && "pointer-events-none w-0",
        )}
      />
      <div
        className={cn(
          "relative h-full shrink-0 overflow-hidden",
          !dragging && "transition-[width] duration-200 ease-linear",
        )}
        style={{ width: open ? width : 0 }}
      >
        {/* 卡面宽度钉在像素上:开合过渡只裁切,文字不重排(与左栏同款观感)。 */}
        <div className="absolute top-0 right-2 bottom-2" style={{ width: Math.max(0, width - 16) }}>
          {panel ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-black/[0.06] bg-sidebar shadow-[var(--ds-elevation-100)]">
              <WorkbenchHost
                panel={panel}
                onClose={onClose}
                activeConversationId={activeConversationId ?? undefined}
                className="bg-transparent"
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function createHomeDraftId() {
  return `home-${uuidv4()}`;
}

function truncatePreviewText(value: string, maxLength = 48): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function getQuickJumpPreview(
  message: MessageDto,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const textPreview = message.parts
    .filter((part): part is Extract<UIMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .find((text) => text.length > 0);

  if (textPreview) {
    return truncatePreviewText(textPreview.replace(/\s+/g, " "));
  }

  const fallbackPart = message.parts.find(Boolean);
  if (!fallbackPart) return t("conversations.preview.empty_message");

  switch (fallbackPart.type) {
    case "image":
      return t("conversations.preview.image");
    case "video":
      return t("conversations.preview.video");
    case "audio":
      return t("conversations.preview.audio");
    case "document":
      return fallbackPart.fileName.trim().length > 0
        ? t("conversations.preview.document_with_name", {
            name: truncatePreviewText(fallbackPart.fileName.trim(), 32),
          })
        : t("conversations.preview.document");
    case "reasoning":
      return fallbackPart.reasoning.trim().length > 0
        ? truncatePreviewText(fallbackPart.reasoning.trim().replace(/\s+/g, " "))
        : t("conversations.preview.thinking");
    case "tool":
      return fallbackPart.toolName.trim().length > 0
        ? t("conversations.preview.tool_with_name", {
            name: truncatePreviewText(fallbackPart.toolName.trim(), 32),
          })
        : t("conversations.preview.tool_call");
    case "loading":
      return t("conversations.preview.thinking");
    case "text":
      return t("conversations.preview.empty_message");
  }
}

function isAttachmentPart(
  part: UIMessagePart,
): part is Extract<UIMessagePart, { type: "image" | "video" | "audio" | "document" }> {
  return (
    part.type === "image" ||
    part.type === "video" ||
    part.type === "audio" ||
    part.type === "document"
  );
}

function getLastTextPartIndex(parts: UIMessagePart[]): number | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === "text") {
      return index;
    }
  }

  return null;
}

function getDraftSourceIndex(part: UIMessagePart): number | null {
  const value = part.metadata?.[EDIT_DRAFT_SOURCE_INDEX];
  return typeof value === "number" ? value : null;
}

function toEditDraft(message: MessageDto): EditDraft | null {
  const textPartIndex = getLastTextPartIndex(message.parts);
  const text =
    textPartIndex !== null && message.parts[textPartIndex]?.type === "text"
      ? message.parts[textPartIndex].text
      : "";

  const attachments = message.parts.flatMap((part, index) => {
    if (!isAttachmentPart(part)) return [];

    return [
      {
        ...part,
        metadata: {
          ...part.metadata,
          [EDIT_DRAFT_ATTACHMENT_MARK]: true,
          [EDIT_DRAFT_SOURCE_INDEX]: index,
        },
      },
    ];
  });

  if (text.trim().length === 0 && attachments.length === 0) {
    return null;
  }

  return {
    text,
    attachments,
    sourceParts: message.parts,
    textPartIndex,
  };
}

function shouldDeleteAttachmentFileOnRemove(part: UIMessagePart): boolean {
  if (!part.metadata) return true;

  return part.metadata[EDIT_DRAFT_ATTACHMENT_MARK] !== true;
}

function stripEditDraftMetadata(parts: UIMessagePart[]): UIMessagePart[] {
  return parts.map((part) => {
    if (!part.metadata) {
      return part;
    }

    const hasEditMark =
      EDIT_DRAFT_ATTACHMENT_MARK in part.metadata || EDIT_DRAFT_SOURCE_INDEX in part.metadata;
    if (!hasEditMark) {
      return part;
    }

    const nextMetadata = { ...part.metadata };
    delete nextMetadata[EDIT_DRAFT_ATTACHMENT_MARK];
    delete nextMetadata[EDIT_DRAFT_SOURCE_INDEX];

    return {
      ...part,
      metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    };
  });
}

function buildEditedParts(session: EditingSession, draftParts: UIMessagePart[]): UIMessagePart[] {
  const textPart = draftParts.find(
    (part): part is Extract<UIMessagePart, { type: "text" }> => part.type === "text",
  );
  const editedText = textPart?.text ?? "";

  const retainedAttachmentIndexes = new Set<number>();
  const appendedAttachments: UIMessagePart[] = [];

  draftParts.forEach((part) => {
    if (!isAttachmentPart(part)) return;

    if (part.metadata?.[EDIT_DRAFT_ATTACHMENT_MARK] === true) {
      const sourceIndex = getDraftSourceIndex(part);
      if (sourceIndex !== null) {
        retainedAttachmentIndexes.add(sourceIndex);
      }
      return;
    }

    appendedAttachments.push(part);
  });

  const preservedParts: UIMessagePart[] = [];

  session.sourceParts.forEach((part, index) => {
    if (session.textPartIndex !== null && index === session.textPartIndex && part.type === "text") {
      preservedParts.push({ ...part, text: editedText });
      return;
    }

    if (isAttachmentPart(part)) {
      if (retainedAttachmentIndexes.has(index)) {
        preservedParts.push(part);
      }
      return;
    }

    preservedParts.push(part);
  });

  if (session.textPartIndex === null && textPart && textPart.text.trim().length > 0) {
    return [textPart, ...preservedParts, ...appendedAttachments];
  }

  return [...preservedParts, ...appendedAttachments];
}

function useDraftInputController({
  container,
  activeId,
  isHomeRoute,
  homeDraftId,
  setHomeDraftId,
  setActiveId,
  navigate,
  refreshList,
}: {
  /** 本列所属容器:新会话的归属(workspaceId)由它决定,不读全局激活容器。 */
  container: ContainerKey;
  activeId: string | null;
  isHomeRoute: boolean;
  homeDraftId: string;
  setHomeDraftId: React.Dispatch<React.SetStateAction<string>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: ReturnType<typeof useNavigate>;
  refreshList: () => void;
}) {
  const draftKey = activeId ?? (isHomeRoute ? homeDraftId : null);
  // 刻意不在这里订阅 drafts[draftKey] 的内容:一旦订阅草稿,每次打字都会让整个窗格
  // (消息列表/对话框/工具条)一起重渲染,造成输入卡顿。草稿内容订阅下沉到
  // ChatInputArea——只有输入区随打字重渲染。
  const setDraftText = useChatInputStore((state) => state.setText);
  const addDraftParts = useChatInputStore((state) => state.addParts);
  const getSubmitParts = useChatInputStore((state) => state.getSubmitParts);
  const clearDraft = useChatInputStore((state) => state.clearDraft);

  const handleSubmit = React.useCallback(async () => {
    if (!draftKey) return;

    const parts = getSubmitParts(draftKey);
    if (parts.length === 0) return;

    if (activeId) {
      // 单端点 StartOrSteer:占用与否由服务端裁决(空闲=落库点火;生成中=排队并在下一模型
      // 请求边界注入,不打断在跑生成)。前端不再按 SSE 滞后的 isGenerating 选端点——快速连发
      // 时那会误判空闲、掐掉自己刚点火的生成。
      await api.post<{ status: string }>(`conversations/${activeId}/messages`, { parts });
      clearDraft(draftKey);
      return;
    }

    const conversationId = uuidv4();
    setHomeDraftId(createHomeDraftId());

    // Send the message BEFORE setting activeId so the detail fetcher doesn't race
    // (`POST /messages` calls ensureConversation on the server; only then does the
    // subsequent `GET /api/conversations/{id}` succeed).
    // 双层标签(M2-1):新会话归属发起它的那一列的容器——工作区容器时把 workspaceId
    // 一并送给 ensureConversation,服务端据此挂载工作区工具与提示词段。并排后必须用
    // 列的容器而不是全局激活容器,否则在非聚焦列发第一句会挂到邻列的工作区上。
    await api.post<{ status: string }>(
      `conversations/${conversationId}/messages`,
      container !== CHAT_CONTAINER ? { parts, workspaceId: container } : { parts },
    );
    clearDraft(draftKey);
    useContainerTabsStore.getState().openConversation(container, conversationId);

    setActiveId(conversationId);
    navigate(`/c/${conversationId}`);
    refreshList();
  }, [
    activeId,
    clearDraft,
    container,
    draftKey,
    getSubmitParts,
    navigate,
    refreshList,
    setActiveId,
    setHomeDraftId,
  ]);

  const replaceDraft = React.useCallback(
    (text: string, parts: UIMessagePart[]) => {
      if (!draftKey) return;
      clearDraft(draftKey);
      setDraftText(draftKey, text);
      addDraftParts(draftKey, parts);
    },
    [addDraftParts, clearDraft, draftKey, setDraftText],
  );

  const clearCurrentDraft = React.useCallback(() => {
    if (!draftKey) return;
    clearDraft(draftKey);
  }, [clearDraft, draftKey]);

  const getCurrentSubmitParts = React.useCallback(() => {
    if (!draftKey) return [];
    return getSubmitParts(draftKey);
  }, [draftKey, getSubmitParts]);

  return {
    draftKey,
    setDraftText,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  };
}

// 输入区渲染边界:把"草稿内容订阅"隔离在这里,这样打字时只有本组件重渲染,
// 而 ConversationsPageInner(侧边栏 / 顶栏 / 对话框 / 面板组 / 消息列表)全部不动。
// 父级传入的都是稳定引用(handlers / useCallback / 原始值),React.memo 让本组件在
// 父级因无关原因(如 SSE 推送)重渲染时也能跳过,只在草稿内容或真正变化的 prop 变化时重渲染。
interface ChatInputAreaProps {
  draftKey: string | null;
  isGenerating: boolean;
  disabled: boolean;
  isEditing: boolean;
  suggestions: string[];
  onSuggestionClick: (suggestion: string) => void;
  onCancelEdit?: () => void;
  shouldDeleteFileOnRemove?: (part: UIMessagePart) => boolean;
  onSend: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onExportConversation?: (includeReasoning: boolean) => void;
  onCompressConversation?: () => void;
  /** 语音模式开关(仅当选中的 ASR 服务支持 server-VAD 时传入;否则输入区不显示入口)。 */
  onToggleVoiceMode?: () => void;
  voiceModeActive?: boolean;
  slashCommands?: SlashCommandDto[];
  onSlashCommand?: (name: string, argument: string) => Promise<boolean | void> | boolean | void;
  getOptimizeContext?: () => string;
  /** 提示词优化回退用的当前会话 id(未配置优化模型时后端用它回退会话模型)。 */
  conversationId?: string | null;
  /** 队列预览插槽(由父级构造,渲染进输入卡片内顶端)。 */
  queueSlot?: React.ReactNode;
}

const ChatInputArea = React.memo(function ChatInputArea({
  draftKey,
  isGenerating,
  disabled,
  isEditing,
  suggestions,
  onSuggestionClick,
  onCancelEdit,
  shouldDeleteFileOnRemove,
  onSend,
  onStop,
  onExportConversation,
  onCompressConversation,
  onToggleVoiceMode,
  voiceModeActive,
  slashCommands,
  onSlashCommand,
  getOptimizeContext,
  conversationId,
  queueSlot,
}: ChatInputAreaProps) {
  const setText = useChatInputStore((state) => state.setText);
  const addParts = useChatInputStore((state) => state.addParts);
  const removePartAt = useChatInputStore((state) => state.removePartAt);
  const draft = useChatInputStore(
    React.useCallback((state) => (draftKey ? state.drafts[draftKey] : undefined), [draftKey]),
  );
  const inputText = draft?.text ?? "";
  const inputAttachments = draft?.parts ?? EMPTY_INPUT_ATTACHMENTS;

  const handleValueChange = React.useCallback(
    (text: string) => {
      if (!draftKey) return;
      setText(draftKey, text);
    },
    [draftKey, setText],
  );
  const handleAddParts = React.useCallback(
    (parts: UIMessagePart[]) => {
      if (!draftKey || parts.length === 0) return;
      addParts(draftKey, parts);
    },
    [addParts, draftKey],
  );
  const handleRemovePart = React.useCallback(
    (index: number) => {
      if (!draftKey) return;
      removePartAt(draftKey, index);
    },
    [draftKey, removePartAt],
  );

  return (
    <ChatInput
      value={inputText}
      attachments={inputAttachments}
      ready={draftKey !== null}
      isGenerating={isGenerating}
      disabled={disabled}
      isEditing={isEditing}
      onValueChange={handleValueChange}
      onAddParts={handleAddParts}
      suggestions={suggestions}
      onSuggestionClick={onSuggestionClick}
      onCancelEdit={onCancelEdit}
      shouldDeleteFileOnRemove={shouldDeleteFileOnRemove}
      onRemovePart={handleRemovePart}
      onSend={onSend}
      onStop={onStop}
      onExportConversation={onExportConversation}
      onCompressConversation={onCompressConversation}
      onToggleVoiceMode={onToggleVoiceMode}
      voiceModeActive={voiceModeActive}
      slashCommands={slashCommands}
      onSlashCommand={onSlashCommand}
      getOptimizeContext={getOptimizeContext}
      conversationId={conversationId}
      draftKey={draftKey}
      queueSlot={queueSlot}
    />
  );
});

interface QuickJumpRangeHandle {
  setRange: (start: number, end: number) => void;
}

// 滚动范围状态的唯一消费者是快速跳转条,收进独立小组件:Virtuoso 的 rangeChanged
// 高频回调经命令式 ref 只重渲染本组件,巨型 ConversationTimeline(含 Virtuoso)完全
// 不在传播路径上。这不仅是滚动性能优化,更是白屏 bug 的根治:此前 rangeChanged →
// setState 重渲染整个 Timeline,Virtuoso 全套函数 props 换新引用,特定会话上范围
// 计算被扰动回摆,"rangeChanged→重渲染→范围又变"正反馈同步嵌套,直至击穿 React
// 50 层更新深度上限(#185),被 root ErrorBoundary 接住即 "Oops!" 白屏(桌面端快速
// 切换会话高发)。
const QuickJumpOverlay = React.forwardRef<
  QuickJumpRangeHandle,
  {
    seedKey: string;
    initialIndex: number;
    itemCount: number;
    isAtBottom: boolean;
    isAtTop: boolean;
    items: ConversationQuickJumpItem[];
    onItemClick: (index: number) => void;
  }
>(function QuickJumpOverlay(
  { seedKey, initialIndex, itemCount, isAtBottom, isAtTop, items, onItemClick },
  ref,
) {
  const [range, setRange] = React.useState({ start: initialIndex, end: initialIndex });
  // C 族闪动修复(播种逻辑随状态一起搬入):切换会话/详情迟到时在 render 期重置,
  // 避免挂载稳定期 rangeChanged 尚未回调时指示器闪指第 1 轮。
  const seedRef = React.useRef<string | null>(null);
  if (seedRef.current !== seedKey) {
    seedRef.current = seedKey;
    setRange({ start: initialIndex, end: initialIndex });
  }
  React.useImperativeHandle(
    ref,
    () => ({
      setRange: (start, end) =>
        setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end })),
    }),
    [],
  );
  const activeIndex = isAtBottom
    ? itemCount - 1
    : isAtTop
      ? 0
      : Math.round((range.start + range.end) / 2);
  return (
    <ConversationQuickJump items={items} activeIndex={activeIndex} onItemClick={onItemClick} />
  );
});

const ConversationTimeline = React.memo(
  ({
    activeId,
    isHomeRoute,
    settings,
    contentClassName,
    onEdit,
    onDelete,
    onFork,
    onRegenerate,
    onSelectBranch,
    onTranslate,
    onTogglePin,
    onToolApproval,
    onCompress,
  }: {
    activeId: string | null;
    isHomeRoute: boolean;
    settings: Settings | null;
    contentClassName?: string;
    onEdit: (message: MessageDto) => void | Promise<void>;
    onDelete: (messageId: string) => Promise<void>;
    onFork: (messageId: string) => Promise<void>;
    onRegenerate: (messageId: string) => Promise<void>;
    onSelectBranch: (nodeId: string, selectIndex: number) => Promise<void>;
    onTranslate: (messageId: string) => Promise<void>;
    onTogglePin: (messageId: string, pinned: boolean) => Promise<void>;
    onToolApproval: (
      toolCallId: string,
      approved: boolean,
      reason: string,
      answer?: string,
    ) => Promise<void>;
    /** 上下文告警行点击 → 打开压缩框(聊天引擎专用;工作区走 pi 原生压缩)。 */
    onCompress: () => void;
  }) => {
    const { t } = useTranslation("page");
    // colocation(D 族支柱②):详情状态在消息面板本地订阅、本地派生 —— 流式增量
    // 只重渲染本子树,顶层(侧边栏/顶栏/输入区)不在传播路径上。切换会话时 store
    // 按 id 直读,缓存命中则首帧就是新会话完整内容(原 render 阶段换内容语义天然满足,
    // 下游 knownIdsRef/滚动播种依赖这一点)。
    const entry = useConversationEntry(activeId);
    const detail = entry?.detail ?? null;
    // I-2(专题2):窗口化快照——detail.messages 是绝对下标 [nodesOffset, total) 的已
    // 加载后缀。Virtuoso 用 firstItemIndex=nodesOffset 做顶部插入的滚动锚定;本组件内
    // 一律使用"已加载数组的本地下标",只在 itemContent/rangeChanged(回调携带全局
    // 偏移)处换算。scrollToIndex/initialTopMostItemIndex 本就是本地坐标,无需换算。
    const nodesOffset = detail?.nodesOffset ?? 0;
    // bug1 兜底:react-virtuoso 不支持 firstItemIndex 原地增大(尺寸树错乱 → 底部
    // 幽灵空白/尾部条目消失)。数据层已尽力避免(mergeConversationSnapshot 前缀保留),
    // 但仍有合法缩窗路径(如离开期间新增消息超过一个快照窗口,本地前缀接不上)——
    // 此时唯一正确的处理是重挂载列表。render 期播种(与 knownIdsRef 同模式)。
    const offsetEpochRef = React.useRef({ activeId: null as string | null, offset: 0, epoch: 0 });
    if (offsetEpochRef.current.activeId !== activeId) {
      offsetEpochRef.current = { activeId, offset: nodesOffset, epoch: 0 };
    } else if (nodesOffset > offsetEpochRef.current.offset) {
      offsetEpochRef.current.epoch += 1;
      offsetEpochRef.current.offset = nodesOffset;
    } else if (nodesOffset < offsetEpochRef.current.offset) {
      offsetEpochRef.current.offset = nodesOffset; // 向上翻页(prepend)是受支持方向,只跟踪
    }
    const listRemountEpoch = offsetEpochRef.current.epoch;
    // 缓存命中时即使订阅尚未建立也不进加载态 —— 内容已在屏上,快照到达后静默校正
    const detailLoading = (entry?.subscribing ?? false) && detail === null;
    const detailError = entry?.error ?? null;
    const isGenerating = detail?.isGenerating ?? false;
    // 域4-1 审批等待(本地订阅,同 colocation 原则):pending 工具卡的计时存活判据——
    // 挂起仍在 = 等用户期间秒数照走(#59 刻意语义);重启后遗留的死 pending 卡不再走表。
    const awaitingApproval = useConversationEngineStatus(activeId)?.phase === "awaiting_approval";
    const conversationTitle = detail?.title ?? "";
    const conversationAssistantId = detail?.assistantId ?? null;
    const selectedNodeMessages = React.useMemo<SelectedNodeMessage[]>(() => {
      if (!detail) return [];
      return detail.messages.map((node) => ({
        node,
        message: node.messages[node.selectIndex] ?? node.messages[0],
      }));
    }, [detail]);
    // 压缩记录 → 分割线锚点详情。切点可能落在非当前分支上,所以按节点成员查找;
    // 旧的 cut 注解若找不到对应记录(历史版本数据)就只画线、不提供可点入口。
    const compactionAnchors = React.useMemo(() => {
      if (!detail) return new Map<string, CompactionAnchorInfo>();
      return buildCompactionAnchors(
        detail.engineCompactions,
        detail.messages.map((node) => ({
          messages: node.messages,
          selectedId: (node.messages[node.selectIndex] ?? node.messages[0])?.id ?? "",
        })),
      );
    }, [detail]);
    // 最新一条有效压缩记录的位置:锚点及其之前的原文默认折叠,锚点那一行换成摘要卡。
    // 数组本身不裁剪(切分支/翻页/搜索都按下标工作),折叠只在渲染层把旧行压成 0 高。
    const compactionPlacement = React.useMemo(() => {
      if (!detail) return null;
      return latestCompactionPlacement(
        detail.engineCompactions,
        detail.messages.map((node) => ({
          messages: node.messages,
          selectedId: (node.messages[node.selectIndex] ?? node.messages[0])?.id ?? "",
        })),
      );
    }, [detail]);
    // 压缩摘要卡上的「待确认记忆候选」:实验总开关 + 压缩后置候选都开才请求,
    // 否则不产生任何额外网络请求。失败静默为 0,不打扰阅读。
    const compactionCandidateCount = useCompactionCandidateCount(
      activeId,
      compactionPlacement?.record.cutMessageId ?? null,
      settings?.memoryExperimentSettings?.enabled === true &&
        settings.memoryExperimentSettings.compactionCandidates === true,
    );
    // 默认折叠;切会话或产生新压缩记录时回到折叠态,不与用户上一次的展开选择混淆。
    const [compactionCollapsed, setCompactionCollapsed] = React.useState(true);
    React.useEffect(() => {
      setCompactionCollapsed(true);
    }, [activeId, compactionPlacement?.record.cutMessageId]);
    // startReached 回调在 render 早期创建,折叠态经 ref 读取最新值:折叠时顶部就是
    // 摘要卡,不应再向上无限翻页(翻出来的原文也被折叠,只是白拉数据)。
    const compactionFoldedRef = React.useRef(false);
    const [compactionAnchorId, setCompactionAnchorId] = React.useState<string | null>(null);
    // 切换会话时收起详情卡:锚点 id 属于上一个会话,留着会拿错记录。
    React.useEffect(() => {
      setCompactionAnchorId(null);
    }, [activeId]);
    const compactionDetail = compactionAnchorId
      ? (compactionAnchors.get(compactionAnchorId) ?? null)
      : null;
    // 上下文告警(聊天引擎):阈值与工作区 pi 自动压缩同口径——窗口剩余不足
    // CONTEXT_WARNING_RESERVE_TOKENS 时,在最后一条回复下方提示用户主动压缩。
    // 工作区会话不提示:pi 自带 threshold/overflow 自动压缩,手动入口也在输入区,
    // 再插一行只是重复。渲染位置见 itemContent 的 isLastLoaded 分支。
    const liveContextLimit = useCurrentContextLimit();
    const contextWarning = React.useMemo(() => {
      if (!detail || detail.workspaceId) return null;
      const node = detail.messages.at(-1);
      const message = node ? (node.messages[node.selectIndex] ?? node.messages[0]) : null;
      if (!message || message.role !== "ASSISTANT" || !message.usage) return null;
      // 刚压缩完:最后一条回复的 usage 还是压缩前的窗口量,提示会与压缩动作自相矛盾。
      if (compactionAfterMessage(detail.engineCompactions, message.createdAt)) return null;
      return contextWarningPercent(message.usage, liveContextLimit);
    }, [detail, liveContextLimit]);
    const canQuickJump =
      Boolean(activeId) && !detailLoading && !detailError && selectedNodeMessages.length > 1;
    const assistant = React.useMemo(() => {
      if (!settings) return null;
      return (
        settings.assistants.find((item) => item.id === conversationAssistantId) ??
        settings.assistants[0] ??
        null
      );
    }, [conversationAssistantId, settings]);
    const modelById = React.useMemo(() => {
      const map = new Map<string, ProviderModel>();
      if (!settings) return map;

      for (const provider of settings.providers) {
        for (const model of provider.models) {
          if (!map.has(model.id)) {
            map.set(model.id, model);
          }
        }
      }

      return map;
    }, [settings]);
    const fallbackModel = React.useMemo(() => {
      if (!settings) return null;
      const fallbackId = assistant?.chatModelId ?? settings.chatModelId;
      // 嵌入/重排只走 /embeddings、/rerank，兜底挑到它们会让会话显示与上下文长度全部失真。
      const chatCapable = (model: ProviderModel | undefined) =>
        !!model && model.type !== "EMBEDDING" && model.type !== "RERANK" ? model : undefined;
      return (
        chatCapable(modelById.get(fallbackId)) ??
        settings.providers
          .flatMap((provider) => provider.models)
          .find((model) => !!chatCapable(model)) ??
        null
      );
    }, [assistant?.chatModelId, modelById, settings]);

    // 仅对"进入会话(或切换会话)之后才新出现的消息"播放入场动画。首次加载的历史
    // 消息一律不动画——避免长会话进入时 N 条消息并发播 4 属性动画拖垮首屏 mount。
    // activeId 变化(切换会话)→ 重新锁定当前消息集为新会话的"历史";detail 延迟
    // 加载(锁定时为空、随后才有消息)的场景,在消息首次出现时补锁定一次。
    const knownIdsRef = React.useRef<{ activeId: string | null; ids: Set<string> } | null>(null);
    if (
      knownIdsRef.current === null ||
      knownIdsRef.current.activeId !== activeId ||
      (knownIdsRef.current.ids.size === 0 && selectedNodeMessages.length > 0)
    ) {
      knownIdsRef.current = {
        activeId,
        ids: new Set(selectedNodeMessages.map((item) => item.message.id)),
      };
    }
    const knownMessageIds = knownIdsRef.current.ids;

    // I-2:向上翻页 prepend 的老节点不是"新消息",不播入场动画——offset 变小即 prepend,
    // 把新出现的前缀 id 并入已知集合(含"分享/导出拉全量"一次性展开的场景)。
    const prevOffsetRef = React.useRef<{ activeId: string | null; offset: number }>({
      activeId,
      offset: nodesOffset,
    });
    if (prevOffsetRef.current.activeId !== activeId) {
      prevOffsetRef.current = { activeId, offset: nodesOffset };
    } else if (nodesOffset !== prevOffsetRef.current.offset) {
      if (nodesOffset < prevOffsetRef.current.offset) {
        const prepended = prevOffsetRef.current.offset - nodesOffset;
        for (const item of selectedNodeMessages.slice(0, prepended)) {
          knownIdsRef.current.ids.add(item.message.id);
        }
      }
      prevOffsetRef.current = { activeId, offset: nodesOffset };
    }

    const virtuosoRef = React.useRef<VirtuosoHandle>(null);
    // "回到底部"按钮的滚动距离判定用(复现实测:平滑滚动跨越大段未测量的巨型条目时
    // 会因尺寸修正中途卡死,永远到不了底;远距离改瞬时跳转,近距离保留平滑动画)
    const scrollerElRef = React.useRef<HTMLElement | Window | null>(null);
    // I-2:滚到已加载顶部时向上翻页(去重/到头判断在 loadOlderConversationNodes 内)。
    // 压缩区折叠时顶部是摘要卡而不是历史原文,不再向上拉取。
    const handleStartReached = React.useCallback(() => {
      if (compactionFoldedRef.current) return;
      if (activeId) void loadOlderConversationNodes(activeId);
    }, [activeId]);
    const [isAtBottom, setIsAtBottom] = React.useState(true);
    // 1.5.0 内测 bug1:底部幽灵空白自愈。Virtuoso 的 followOutput 只在新数据到达时
    // 贴底,不追踪已有行的缩高(官方 issue #241 明确为设计取舍);贴底状态下最后一项
    // 大幅缩高(推理块生成结束自动折叠、用户手动折叠长卡片等)时,过期总高度偶发
    // 残留在滚动容器里,表现为"到底了还能继续下拉出大片空白"。对策:总高度变小且
    // 仍贴底时补一次显式贴底,强制 Virtuoso 重算并钳位;rAF 等布局提交后执行。
    // 高度增长(流式输出/向上翻页 prepend)不触发,不干扰正常滚动。
    const isAtBottomRef = React.useRef(true);
    const totalListHeightRef = React.useRef(0);
    React.useEffect(() => {
      // 切换会话时 Virtuoso 按 key 重挂,旧会话的总高度不应参与比较
      totalListHeightRef.current = 0;
    }, [activeId]);
    const handleAtBottomStateChange = React.useCallback((atBottom: boolean) => {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }, []);
    // 流式注意力上报:贴底观看当前会话 -> 增量逐帧落地;滚离底部/切会话/卸载 -> 攒批
    // 250ms(根治"流式表格/大块时滚动看别处掉到十几帧",见 conversation-stream.ts)。
    React.useEffect(() => {
      if (!activeId || !isAtBottom) return;
      setConversationStreamAttention(activeId);
      return () => setConversationStreamAttention(null);
    }, [activeId, isAtBottom]);
    const handleTotalListHeightChanged = React.useCallback((height: number) => {
      const previous = totalListHeightRef.current;
      totalListHeightRef.current = height;
      if (previous === 0 || height >= previous || !isAtBottomRef.current) return;
      requestAnimationFrame(() => {
        if (!isAtBottomRef.current) return;
        virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
      });
    }, []);
    // 打开会话的首帧渲染批量控制(专题2 加餐):increaseViewportBy=800 会让 Virtuoso
    // 挂载时连滚动缓冲区一并渲染,每条长消息的 markdown 管线(remark+KaTeX)要
    // 4-20ms,叠加 DOM 提交与布局就是用户看到的“空白/加载中”。改成两阶段:首帧只
    // 渲染视口内(overscan=0),首次内容绘制后的浏览器空闲期再扩回 800px 滚动预渲染
    // 缓冲——首开耗时与缓冲大小解耦,滚动体验不变。切换会话时重置。
    const [overscanExpanded, setOverscanExpanded] = React.useState(false);
    React.useEffect(() => {
      setOverscanExpanded(false);
    }, [activeId]);
    const hasRenderedContent = !detailLoading && !detailError && selectedNodeMessages.length > 0;
    React.useEffect(() => {
      if (overscanExpanded || !hasRenderedContent) return;
      const expand = () => setOverscanExpanded(true);
      if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(expand, { timeout: 1500 });
        return () => window.cancelIdleCallback(handle);
      }
      const timer = window.setTimeout(expand, 300);
      return () => window.clearTimeout(timer);
    }, [overscanExpanded, hasRenderedContent]);
    const [isAtTop, setIsAtTop] = React.useState(false);
    const quickJumpRangeRef = React.useRef<QuickJumpRangeHandle | null>(null);
    const didInitialScrollRef = React.useRef<string | null>(null);
    const ensureFullForFocusRef = React.useRef<string | null>(null);

    // C 族闪动修复:"回到底部"按钮延迟出现 —— Virtuoso 挂载稳定期可能瞬时回调
    // atBottom=false→true,立即渲染按钮就是闪现一帧(与加载提示的 250ms 延迟同理)。
    // 150ms 内恢复贴底则全程不可见;真离底(用户上滚)时延迟不可感知。
    const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);
    React.useEffect(() => {
      if (isAtBottom) {
        setShowJumpToBottom(false);
        return;
      }
      const timer = window.setTimeout(() => setShowJumpToBottom(true), 150);
      return () => window.clearTimeout(timer);
    }, [isAtBottom]);

    // 会话内分享: 点消息"分享"进入选择模式, 默认选中该消息及之前所有(对齐 APP).
    // 确认后弹出导出格式选择 (Markdown / 图片). 切换会话时清理, 避免残留选中态.
    const [shareSelecting, setShareSelecting] = React.useState(false);
    const [shareSelectedIds, setShareSelectedIds] = React.useState<Set<string>>(() => new Set());
    const [shareDialogOpen, setShareDialogOpen] = React.useState(false);

    const handleShare = React.useCallback(
      async (messageId: string) => {
        // I-2:默认选中"该消息及之前所有"需要完整历史;窗口化时先拉全量。拿不到完整
        // 历史(网络失败)则放弃进入选择模式——绝不拿截断的数据当作全部内容分享。
        let source = selectedNodeMessages;
        if (activeId && nodesOffset > 0) {
          const full = await ensureFullConversationDetail(activeId);
          if (!full) return;
          source = full.messages.map((node) => ({
            node,
            message: node.messages[node.selectIndex] ?? node.messages[0],
          }));
        }
        const idx = source.findIndex((item) => item.message.id === messageId);
        if (idx < 0) return;
        const ids = new Set<string>();
        for (let i = 0; i <= idx; i++) {
          ids.add(source[i].message.id);
        }
        setShareSelectedIds(ids);
        setShareSelecting(true);
      },
      [activeId, nodesOffset, selectedNodeMessages],
    );

    const handleToggleSelect = React.useCallback((messageId: string) => {
      setShareSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(messageId)) {
          next.delete(messageId);
        } else {
          next.add(messageId);
        }
        return next;
      });
    }, []);

    const handleCancelShare = React.useCallback(() => {
      setShareSelecting(false);
      setShareSelectedIds(new Set());
    }, []);

    const handleSelectAllToggle = React.useCallback(() => {
      setShareSelectedIds((prev) => {
        if (prev.size >= selectedNodeMessages.length) return new Set();
        return new Set(selectedNodeMessages.map((item) => item.message.id));
      });
    }, [selectedNodeMessages]);

    const handleConfirmShare = React.useCallback(() => {
      if (shareSelectedIds.size === 0) {
        setShareSelecting(false);
        return;
      }
      setShareSelecting(false);
      setShareDialogOpen(true);
    }, [shareSelectedIds.size]);

    React.useEffect(() => {
      setShareSelecting(false);
      setShareSelectedIds(new Set());
      setShareDialogOpen(false);
    }, [activeId]);

    // 搜索命中跳转时 URL 带 ?msg=<messageId>,用它定位到命中那条消息(对齐安卓)。
    const [searchParams] = useSearchParams();
    const focusMessageId = searchParams.get("msg");

    // 折叠仅在"没有全量曝光需求"时生效:导出选择要能勾选所有消息,搜索定位可能落在
    // 折叠区内;两者结束后回到用户自己的折叠选择。0 条可折(切点就在第一条)不折。
    const compactionFolded =
      compactionCollapsed &&
      compactionPlacement != null &&
      compactionPlacement.anchorNodeIndex > 0 &&
      !shareSelecting &&
      !focusMessageId;
    compactionFoldedRef.current = compactionFolded;
    // 摘要覆盖的节点数 = 窗口外更早的节点 + 当前窗口内锚点及其之前的节点。
    // 锚点自身也已被摘要吸收(只是它还是切点的前驱),折叠时一并收起。
    const foldedNodeCount = compactionPlacement
      ? nodesOffset + compactionPlacement.anchorNodeIndex + 1
      : 0;

    // 加载指示延迟出现:本地请求通常几十 ms 内返回,"加载中"只闪一帧反而像故障。
    // 250ms 内完成则全程只见空白→内容;真慢(远端大会话)才浮现文案。
    const [showLoadingHint, setShowLoadingHint] = React.useState(false);
    React.useEffect(() => {
      if (!detailLoading) {
        setShowLoadingHint(false);
        return;
      }
      const timer = window.setTimeout(() => setShowLoadingHint(true), 250);
      return () => window.clearTimeout(timer);
    }, [detailLoading]);

    React.useEffect(() => {
      if (!activeId || detailLoading || detailError || selectedNodeMessages.length === 0) {
        return;
      }
      if (!focusMessageId) {
        // 无聚焦消息:进入/切换会话时滚底部一次。流式新消息的跟底交给 followOutput。
        const bottomKey = `${activeId}:bottom`;
        if (didInitialScrollRef.current === bottomKey) return;
        didInitialScrollRef.current = bottomKey;
        const lastIndex = selectedNodeMessages.length - 1;
        const frame = window.requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: lastIndex, behavior: "auto", align: "end" });
        });
        return () => window.cancelAnimationFrame(frame);
      }
      // 有聚焦消息(搜索命中):定位到它所在 node。后端 search 索引每个 node 的全部分支,命中可能
      // 是 selectIndex 之外的消息;只看渲染链会找不到,所以遍历所有分支定位到该消息所在轮次(对齐安卓)。
      // 配合下方 followOutput 读 focusMessageId:定位期间(URL 带 msg)不自动跟底,避免 Virtuoso 首次
      // data 填充时被 followOutput 拉到底部、覆盖 scrollToIndex 的居中定位。
      const nodeIdx = selectedNodeMessages.findIndex((item) =>
        item.node.messages.some((m) => m.id === focusMessageId),
      );
      if (nodeIdx < 0) {
        // I-2:命中的可能是窗口之外的老消息——按需拉全量,detail 更新后本 effect 重跑定位。
        // 每个 focusMessageId 只拉一次,拉不到(已删)则维持现状不空转。
        if (nodesOffset > 0 && activeId && ensureFullForFocusRef.current !== focusMessageId) {
          ensureFullForFocusRef.current = focusMessageId;
          void ensureFullConversationDetail(activeId);
        }
        return;
      }
      const focusKey = `${activeId}:focus:${focusMessageId}`;
      if (didInitialScrollRef.current === focusKey) return;
      didInitialScrollRef.current = focusKey;
      // Virtuoso 刚 mount / 数据刚填充时高度未稳定,立即 scrollToIndex 会被后续布局调整覆盖
      // (实测 rAF 连调多次无效,但布局稳定后手动调用有效)。改用递增延迟重试,跨过稳定窗口。
      let cancelled = false;
      const timers = [100, 300, 600].map((d) =>
        window.setTimeout(() => {
          if (cancelled) return;
          virtuosoRef.current?.scrollToIndex({ index: nodeIdx, behavior: "auto", align: "start" });
        }, d),
      );
      return () => {
        cancelled = true;
        timers.forEach((t) => window.clearTimeout(t));
      };
    }, [activeId, detailError, detailLoading, focusMessageId, nodesOffset, selectedNodeMessages]);

    // 首帧定位:Virtuoso 缺省从 index 0 开始渲染,挂载后再 scrollToIndex 会先画出
    // 列表中部、布局稳定后又跳一次(用户看到"中间→闪→末尾")。initialTopMostItemIndex
    // 让首帧就渲染在目标处,不产生滚动动作;上面的 scrollToIndex effect 保留,作为
    // 图片/代码块异步撑高后的兜底修正(同位置重滚不可见)。
    const initialLocation = React.useMemo(() => {
      if (focusMessageId) {
        const idx = selectedNodeMessages.findIndex((item) =>
          item.node.messages.some((m) => m.id === focusMessageId),
        );
        if (idx >= 0) return { index: idx, align: "start" as const };
      }
      return { index: Math.max(0, selectedNodeMessages.length - 1), align: "end" as const };
      // 仅挂载时被 Virtuoso 读取(key=activeId 保证每次切会话重挂载),依赖变化无副作用
    }, [focusMessageId, selectedNodeMessages]);

    // C 族闪动修复:滚动指示状态随会话切换在 render 阶段播种(与上方 knownIdsRef 同模式)。
    // Virtuoso 以 key=activeId 重挂载并按 initialTopMostItemIndex 定位首帧,但这几个状态
    // 属于本组件、不随之重置:挂载稳定期 rangeChanged/atBottomStateChange 尚未回调时,
    // 旧值/初值(0)会让轮次条瞬间指向第 1 轮、"回到底部"按钮闪现 —— 即用户报告的
    // "轮次条刚进来指第一轮,闪动后跳末轮"。播种值与 initialLocation 同源:无聚焦消息
    // = 末条+贴底;有聚焦消息 = 该条+非贴底。详情延迟到达(切换时列表为空、快照后才有
    // 消息)的场景在消息首次出现时补播种一次(wasEmpty 分支,同 knownIdsRef 第三条件)。
    const scrollSeedRef = React.useRef<{ activeId: string | null; wasEmpty: boolean } | null>(null);
    if (
      scrollSeedRef.current === null ||
      scrollSeedRef.current.activeId !== activeId ||
      (scrollSeedRef.current.wasEmpty && selectedNodeMessages.length > 0)
    ) {
      scrollSeedRef.current = { activeId, wasEmpty: selectedNodeMessages.length === 0 };
      setIsAtBottom(!focusMessageId);
      setIsAtTop(false);
    }

    // 轮次条条目身份保持(D 族支柱③):以消息对象为键的 WeakMap 缓存 ——
    // applyNodeUpdate 保持未变节点的引用稳定,流式期间只有正在打字那条未命中、
    // 重算 preview 并重建条目;其余条目引用原样复用,行级 memo 得以生效,
    // 也免掉了每 chunk 对全量消息重跑 preview 提取。语言切换(t 变)整表作废重建。
    const quickJumpCacheRef = React.useRef<{
      t: unknown;
      map: WeakMap<MessageDto, ConversationQuickJumpItem>;
    } | null>(null);
    if (quickJumpCacheRef.current === null || quickJumpCacheRef.current.t !== t) {
      quickJumpCacheRef.current = { t, map: new WeakMap() };
    }
    const quickJumpCache = quickJumpCacheRef.current.map;
    const quickJumpItems = React.useMemo(
      () =>
        selectedNodeMessages.map(({ message }) => {
          const hit = quickJumpCache.get(message);
          if (hit) return hit;
          const item: ConversationQuickJumpItem = {
            id: message.id,
            role: message.role,
            preview: getQuickJumpPreview(message, t),
          };
          quickJumpCache.set(message, item);
          return item;
        }),
      [quickJumpCache, selectedNodeMessages, t],
    );
    // 折叠时轮次条只列可见消息(摘要卡占掉锚点那一行);点击/范围下标再换算回完整数组,
    // 避免跳进 0 高的隐藏行。
    const quickJumpOffset =
      compactionFolded && compactionPlacement ? compactionPlacement.anchorNodeIndex + 1 : 0;
    const visibleQuickJumpItems = React.useMemo(
      () => (quickJumpOffset > 0 ? quickJumpItems.slice(quickJumpOffset) : quickJumpItems),
      [quickJumpItems, quickJumpOffset],
    );

    return (
      // @container/timeline:消息区自身作为容器基准。分栏时窗格窄,右侧轮次跳转轨需要
      // 在消息列(max-w-3xl)之外留出 gutter 才不压正文——视口断点(lg:)判不出单个窗格
      // 的真实宽度,正是「轨道贴着消息叠在一起」的根因。
      <div className="@container/timeline relative flex-1 min-h-0">
        {!activeId && !isHomeRoute ? (
          <ConversationEmptyState
            icon={<MessageSquare className="size-10" />}
            title={t("conversations.empty_state.select_title")}
            description={t("conversations.empty_state.select_description")}
          />
        ) : detailLoading ? (
          showLoadingHint ? (
            <ConversationEmptyState
              title={t("conversations.empty_state.loading_title")}
              description={t("conversations.empty_state.loading_description")}
            />
          ) : null
        ) : detailError ? (
          <ConversationEmptyState
            title={t("conversations.empty_state.error_title")}
            description={detailError}
          />
        ) : selectedNodeMessages.length === 0 ? (
          isGenerating ? (
            <div className="flex items-start px-4 py-2">
              <TypingIndicator className="px-1 py-2" />
            </div>
          ) : (
            <ConversationEmptyState
              icon={<MessageSquare className="size-10" />}
              title={t("conversations.empty_state.no_message_title")}
              description={t("conversations.empty_state.no_message_description")}
            />
          )
        ) : (
          <Virtuoso
            key={`${activeId ?? "home"}:${listRemountEpoch}`}
            ref={virtuosoRef}
            scrollerRef={(el) => {
              scrollerElRef.current = el;
            }}
            className="h-full"
            data={selectedNodeMessages}
            // I-2:顶部插入的滚动锚定。prepend 时 store 原子地同步减小 offset 与增长
            // messages,Virtuoso 保持视口稳定;offset=0(绝大多数会话)时行为与旧版一致。
            firstItemIndex={nodesOffset}
            startReached={handleStartReached}
            initialTopMostItemIndex={initialLocation}
            // 未测量条目的高度估算基准。首帧挂载条数 ≈ 视口高 ÷ 估算值,它直接决定
            // 打开会话的首帧渲染量:旧值 120 在 900px 视口下首帧挂 ~8 条,而长消息
            // 会话单条实测 1500px+,等于首帧多画 4-8 倍——"打开卡 0.5-1s"的主因之一。
            // 取偏大的 600:长消息会话首帧只挂 1-2 条;短消息会话低估的部分由实测后
            // 同帧渐进补挂(见下方 skipAnimationFrameInResizeObserver),两类会话都
            // 不吃亏。真实高度测得后照常精确修正。
            defaultItemHeight={600}
            // 尺寸测量不等下一帧(官方对新浏览器的推荐配置):Virtuoso 缺省把
            // ResizeObserver 回调推迟到 rAF,挂载稳定期的"渲染→测量"要迭代多轮,
            // 每轮至少一帧,纯帧等待就 100-200ms(性能探针实测)。关掉后同帧完成。
            // 前提:rangeChanged 绝不重渲染本组件(见 QuickJumpOverlay),否则
            // "测量→回调→重渲染→再测量"同步嵌套会击穿 React 更新深度上限(#185)。
            skipAnimationFrameInResizeObserver
            computeItemKey={(_, item) => item.message.id}
            // "auto" 瞬时贴底(D 族支柱④):流式每 chunk 都触发 followOutput,"smooth"
            // 会让上一帧尚未完成的平滑滚动被反复打断重启,视觉上持续抖动;瞬时贴底
            // 无动画可打断。点击"回到底部"按钮的平滑滚动不受影响(走 scrollToIndex)。
            // 专题9:enableAutoScroll 关闭时不跟底(对齐安卓 ChatList 的同名开关);
            // 进入会话的一次性滚底与"回到底部"按钮不受影响,只停生成期间的强制跟随。
            followOutput={(atBottom) =>
              focusMessageId || settings?.displaySetting.enableAutoScroll === false
                ? false
                : atBottom
                  ? "auto"
                  : false
            }
            atBottomStateChange={handleAtBottomStateChange}
            atTopStateChange={setIsAtTop}
            totalListHeightChanged={handleTotalListHeightChanged}
            rangeChanged={({ startIndex, endIndex }) => {
              // I-2:firstItemIndex 使回调下标携带全局偏移;轮次条用已加载数组的本地坐标。
              // 折叠时再减去摘要卡之前的隐藏行,与 visibleQuickJumpItems 的下标对齐。
              // 只走命令式通道更新快速跳转条,绝不 setState 重渲染本组件(根治 #185
              // 白屏正反馈,见 QuickJumpOverlay 注释)。
              quickJumpRangeRef.current?.setRange(
                Math.max(0, startIndex - nodesOffset - quickJumpOffset),
                Math.max(0, endIndex - nodesOffset - quickJumpOffset),
              );
            }}
            increaseViewportBy={overscanExpanded ? 800 : 0}
            components={VIRTUOSO_COMPONENTS}
            itemContent={(index, { node, message }) => {
              // I-2:index 携带 firstItemIndex 全局偏移,换算回已加载数组的本地下标
              const localIndex = index - nodesOffset;
              // 折叠区:被摘要吸收的历史(锚点及其之前)压成 0 高;锚点那一行换成摘要卡。
              // 数据一条不删——切分支/翻页/搜索照常,只是用户不再需要滚过模型已看不到的原文。
              const foldedAnchorInfo = compactionPlacement
                ? compactionAnchors.get(compactionPlacement.anchorId)
                : undefined;
              if (compactionFolded && compactionPlacement && foldedAnchorInfo) {
                if (localIndex < compactionPlacement.anchorNodeIndex) {
                  return <div aria-hidden="true" className="h-0" />;
                }
                if (localIndex === compactionPlacement.anchorNodeIndex) {
                  return (
                    <div
                      id={getConversationMessageAnchorId(compactionPlacement.anchorId)}
                      className={cn(
                        "mx-auto w-full max-w-3xl px-4 py-2 scroll-mt-24",
                        contentClassName,
                      )}
                    >
                      <CompactionSummaryCard
                        info={foldedAnchorInfo}
                        collapsed
                        hiddenCount={foldedNodeCount}
                        candidateCount={compactionCandidateCount}
                        onToggle={() => setCompactionCollapsed((prev) => !prev)}
                        onOpen={() => setCompactionAnchorId(compactionPlacement.anchorId)}
                        onOpenCandidates={() =>
                          openSettingsDialog("?section=experiments&sub=memory")
                        }
                      />
                    </div>
                  );
                }
              }
              const model = message.modelId
                ? (modelById.get(message.modelId) ?? fallbackModel)
                : fallbackModel;
              const isLastLoaded = localIndex === selectedNodeMessages.length - 1;
              // 压缩分割线(两代形态并行,判定见 lib/compaction.ts):
              // - compaction_cut:非破坏性压缩的记忆边界,锚在切点前一条消息下方;
              // - compaction_boundary:旧破坏式压缩的发生点,锚在当时的最新消息下方。
              const dividerBelow = compactionDividerBelow(message);
              const compactionAnchor = compactionAnchors.get(message.id);
              // 最新记录的锚点行下方换成摘要卡:压缩成果直接可见,不再只能点开弹窗。
              const summaryCardHere =
                compactionPlacement != null &&
                compactionPlacement.anchorId === message.id &&
                compactionAnchor != null;
              return (
                <div
                  id={getConversationMessageAnchorId(message.id)}
                  className={cn(
                    "mx-auto w-full max-w-3xl px-4 py-2 scroll-mt-24",
                    contentClassName,
                    !knownMessageIds.has(message.id) && "rikkahub-animate-fade-in-up",
                  )}
                >
                  <ChatMessage
                    node={node}
                    message={message}
                    loading={isGenerating && isLastLoaded}
                    awaitingApproval={awaitingApproval}
                    isLastMessage={isLastLoaded}
                    assistant={assistant}
                    model={model}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onFork={onFork}
                    onRegenerate={onRegenerate}
                    onSelectBranch={onSelectBranch}
                    onTranslate={onTranslate}
                    onTogglePin={onTogglePin}
                    onCompress={onCompress}
                    onToolApproval={onToolApproval}
                    selecting={shareSelecting}
                    selected={shareSelectedIds.has(message.id)}
                    onToggleSelect={handleToggleSelect}
                    onShare={handleShare}
                  />
                  {summaryCardHere ? (
                    <CompactionSummaryCard
                      info={compactionAnchor}
                      collapsed={compactionFolded}
                      hiddenCount={foldedNodeCount}
                      candidateCount={compactionCandidateCount}
                      onToggle={() => setCompactionCollapsed((prev) => !prev)}
                      onOpen={() => setCompactionAnchorId(message.id)}
                      onOpenCandidates={() =>
                        openSettingsDialog("?section=experiments&sub=memory")
                      }
                    />
                  ) : dividerBelow ? (
                    <CompactionDivider
                      variant={dividerBelow}
                      onOpen={
                        dividerBelow === "cut" && compactionAnchor
                          ? () => setCompactionAnchorId(message.id)
                          : undefined
                      }
                    />
                  ) : null}
                  {isLastLoaded && contextWarning != null ? (
                    <button
                      type="button"
                      onClick={onCompress}
                      className="mt-1 w-full text-center text-xs text-amber-600 hover:underline dark:text-amber-400"
                    >
                      {t("conversations.context_warning", { percent: contextWarning })}
                    </button>
                  ) : null}
                </div>
              );
            }}
          />
        )}

        {!detailLoading && !detailError && activeId && selectedNodeMessages.length > 0 ? (
          <>
            {shareSelecting ? (
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background/95 p-1 shadow-lg">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCancelShare}
                  title={t("conversations.share.cancel", "取消选择")}
                >
                  <X className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2"
                  onClick={handleSelectAllToggle}
                  title={t("conversations.share.select_all", "全选 / 取消全选")}
                >
                  <ListChecks className="size-4" />
                  <span className="ml-1 text-xs tabular-nums">{shareSelectedIds.size}</span>
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="px-2"
                  disabled={shareSelectedIds.size === 0}
                  onClick={handleConfirmShare}
                  title={t("conversations.share.confirm", "导出选中消息")}
                >
                  <Check className="size-4" />
                </Button>
              </div>
            ) : null}
            {showJumpToBottom ? (
              <Button
                aria-label={t("conversations.scroll_to_bottom", "滚动到底部")}
                className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:bg-background dark:hover:bg-muted"
                onClick={() => {
                  // 距离超过 3 屏改瞬时:平滑滚动跨大段未测量条目会中途卡死(实测),
                  // 且长距离平滑动画本身也无导向价值
                  const el = scrollerElRef.current;
                  const far =
                    el instanceof HTMLElement &&
                    el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 3;
                  virtuosoRef.current?.scrollToIndex({
                    index: selectedNodeMessages.length - 1,
                    behavior: far ? "auto" : "smooth",
                    align: "end",
                  });
                }}
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowDown className="size-4" />
              </Button>
            ) : null}
            {canQuickJump ? (
              <QuickJumpOverlay
                ref={quickJumpRangeRef}
                seedKey={`${activeId ?? "home"}:${selectedNodeMessages.length === 0}:${quickJumpOffset}`}
                initialIndex={Math.max(0, initialLocation.index - quickJumpOffset)}
                itemCount={visibleQuickJumpItems.length}
                isAtBottom={isAtBottom}
                isAtTop={isAtTop}
                items={visibleQuickJumpItems}
                onItemClick={(index) =>
                  virtuosoRef.current?.scrollToIndex({
                    index: index + quickJumpOffset,
                    behavior: "smooth",
                    align: "start",
                  })
                }
              />
            ) : null}
          </>
        ) : null}
        <ShareExportDialog
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
          messages={selectedNodeMessages
            .filter((item) => shareSelectedIds.has(item.message.id))
            .map((item) => item.message)}
          title={conversationTitle ?? ""}
        />
        <CompactionDetailDialog
          info={compactionDetail}
          onOpenChange={(open) => {
            if (!open) setCompactionAnchorId(null);
          }}
        />
      </div>
    );
  },
);

export function meta() {
  return [
    { title: i18n.t("page:conversations.meta.title") },
    {
      name: "description",
      content: i18n.t("page:conversations.meta.description"),
    },
  ];
}

export default function ConversationsPage() {
  const workbench = useWorkbenchController();

  return (
    <WorkbenchProvider value={workbench}>
      <ConversationsPageInner />
    </WorkbenchProvider>
  );
}

// ===== 分栏:每列一份的会话视图 =====
// 订阅/选择器/草稿/编辑态/三个会话级对话框全部收进本组件,以 conversationId 为参数——
// 双栏/三栏 = 渲染多个实例。流订阅(entries 多路)与草稿(drafts 按会话键)天然隔离,
// 打字/流式只重渲染所属列。页面层只保留侧栏、容器标签、热键、工作台等全局职责。
// L 轮一级分栏:列 = (容器, 容器内窗格下标),故容器归属由 props 显式传入。

type CurrentAssistantValue = ReturnType<typeof useCurrentAssistant>["currentAssistant"];

interface ConversationPaneViewProps {
  /** 本列所属容器(一级并排:同屏可有多个容器)。 */
  container: ContainerKey;
  /** 本列在所属容器内的窗格下标。 */
  paneIndex: number;
  /** 本列是否为聚焦列(路由/侧栏跟随它)。 */
  focused: boolean;
  /** 本列的会话:焦点列由路由权威(null = "新对话"态);非焦点列 = 窗格激活标签。 */
  conversationId: string | null;
  isHomeRoute: boolean;
  homeDraftId: string;
  setHomeDraftId: React.Dispatch<React.SetStateAction<string>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  navigate: ReturnType<typeof useNavigate>;
  refreshList: () => void;
  settings: Settings | null;
  conversations: ConversationListDto[];
  activeWorkspace?: React.ComponentProps<typeof WorkspaceEmptyState>["workspace"];
  currentAssistantId: ReturnType<typeof useCurrentAssistant>["currentAssistantId"];
  currentAssistant: CurrentAssistantValue;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
  onFocusPane: (container: ContainerKey, index: number) => void;
}

const ConversationPaneView = React.memo(function ConversationPaneView({
  container,
  paneIndex,
  focused,
  conversationId,
  isHomeRoute,
  homeDraftId,
  setHomeDraftId,
  setActiveId,
  navigate,
  refreshList,
  settings,
  conversations,
  activeWorkspace,
  currentAssistantId,
  currentAssistant,
  onRenameConversation,
  onFocusPane,
}: ConversationPaneViewProps) {
  const { t } = useTranslation("page");
  const activeId = conversationId;
  // 非聚焦列永远有会话(多窗格不变量:空窗格即收起),"新对话"态只属于聚焦列。
  const paneIsHome = focused && isHomeRoute;

  // 编辑绑定按会话键控全局存活(editing-store,与 drafts 同款):切走再切回续编辑,
  // 发送不再静默腐化成"发新消息"。窗格本地仅留 UI 瞬态。
  const editingSession = useConversationEditingSession(activeId);
  const beginEdit = useEditingStore((state) => state.beginEdit);
  const endEdit = useEditingStore((state) => state.endEdit);
  const [compressDialogOpen, setCompressDialogOpen] = React.useState(false);
  // 压缩比例:压掉上下文的百分比,摘要保留剩下的部分。默认 40%,滑杆允许 20–100,
  // 超过 65% 视为高风险(细节不足,模型容易编造),一次会话内确认一次后放行。
  const [compressRatio, setCompressRatio] = React.useState(COMPRESS_RATIO_DEFAULT);
  const compressRatioAcknowledgedRef = React.useRef(false);
  React.useEffect(() => {
    if (!compressDialogOpen) compressRatioAcknowledgedRef.current = false;
  }, [compressDialogOpen]);
  // 换算基准:最后一条带 usage 的助手回复(与上下文告警同一口径 prompt + completion)。
  // 最后一条回复早于最近一次压缩时,它的 usage 还是压缩前的窗口量,拿来换算会给出
  // 比当前上下文还大的摘要目标——按未知处理,提交时省略 targetTokens 走服务端默认。
  const compressContextTokens = useConversationStore((state) => {
    const detail = activeId ? state.entries[activeId]?.detail : null;
    if (!detail) return null;
    for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
      const node = detail.messages[index];
      const message = node?.messages[node.selectIndex] ?? node?.messages[0];
      if (!message || message.role !== "ASSISTANT" || !message.usage) continue;
      if (compactionAfterMessage(detail.engineCompactions, message.createdAt)) return null;
      const used = (message.usage.promptTokens ?? 0) + (message.usage.completionTokens ?? 0);
      if (used > 0) return used;
    }
    return null;
  });
  const compressTargetTokens = compressRatioToTargetTokens(compressRatio, compressContextTokens);
  // 保留条数仍用字符串态承载原始键入(允许清空/逐步输入),提交与失焦时才归一。
  const [compressKeepRecent, setCompressKeepRecent] = React.useState(
    String(COMPRESS_KEEP_RECENT_DEFAULT),
  );
  const [compressAdditionalPrompt, setCompressAdditionalPrompt] = React.useState("");
  // 压缩状态全局化(compress-store):压缩是长任务,状态不随本组件卸载而丢——切页回来
  // busy 互斥/spinner/取消句柄照常;取消语义(R7-4)不变,后端落库前查 request.signal。
  const compressing = useConversationCompressing(activeId);
  const [translationDialogMessageId, setTranslationDialogMessageId] = React.useState<string | null>(
    null,
  );
  const [translationLanguage, setTranslationLanguage] = React.useState(() =>
    i18n.language?.startsWith("zh") ? "zh-CN" : navigator.language || "en-US",
  );
  const [translatingMessage, setTranslatingMessage] = React.useState(false);
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = React.useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = React.useState("");

  // 订阅生命周期挂在窗格顶层:窗格打开即持流,与消息面板的条件渲染解耦。
  // 分栏 = 每窗格各挂一份,同会话自动共享一条流。
  useConversationSubscription(activeId);
  // 窄选择器取标量/稳定引用 —— 流式增量期间这些值不变,窗格壳零重渲染。
  const conversationAssistantId = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.assistantId ?? null) : null,
  );
  const conversationSystemPrompt = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.systemPrompt ?? null) : null,
  );
  const conversationIsGenerating = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.isGenerating ?? false) : false,
  );
  // 消息发送队列快照(SSE 直通,队空为 null):队列面板据此渲染。
  const conversationMessageQueue = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.messageQueue ?? null) : null,
  );
  const hasDetail = useConversationStore((state) =>
    activeId ? state.entries[activeId]?.detail != null : false,
  );
  const hasMessages = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.detail?.messages.length ?? 0) > 0 : false,
  );
  // P5:工作区会话的手动压缩走 pi 原生 compaction(压引擎记忆,UI 历史不动)——
  // 压缩框隐藏"目标 Token/保留最近消息"(那是 UI 历史压缩的参数),文案换语义。
  const isWorkspaceConversation = useConversationStore((state) =>
    activeId ? Boolean(state.entries[activeId]?.detail?.workspaceId) : false,
  );
  const detailLoading = useConversationStore((state) => {
    if (!activeId) return false;
    const entry = state.entries[activeId];
    return (entry?.subscribing ?? false) && (entry?.detail ?? null) === null;
  });
  const detailError = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.error ?? null) : null,
  );
  const chatSuggestions =
    useConversationStore((state) =>
      activeId ? state.entries[activeId]?.detail?.chatSuggestions : undefined,
    ) ?? EMPTY_SUGGESTIONS;

  const {
    draftKey,
    setDraftText,
    handleSubmit,
    replaceDraft,
    clearCurrentDraft,
    getCurrentSubmitParts,
  } = useDraftInputController({
    container,
    activeId,
    isHomeRoute: paneIsHome,
    homeDraftId,
    setHomeDraftId,
    setActiveId,
    navigate,
    refreshList,
  });

  const activeConversationMeta = conversations.find((item) => item.id === activeId);
  const activeAssistantForConversation = React.useMemo(() => {
    const assistantId =
      conversationAssistantId ?? activeConversationMeta?.assistantId ?? currentAssistantId;
    return (
      settings?.assistants.find((assistant) => assistant.id === assistantId) ??
      currentAssistant ??
      null
    );
  }, [
    activeConversationMeta?.assistantId,
    conversationAssistantId,
    currentAssistant,
    currentAssistantId,
    settings,
  ]);
  const canOverrideConversationSystemPrompt =
    activeAssistantForConversation?.allowConversationSystemPrompt === true;

  React.useEffect(() => {
    if (!systemPromptDialogOpen) return;
    setSystemPromptDraft(
      conversationSystemPrompt ?? activeAssistantForConversation?.systemPrompt ?? "",
    );
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeAssistantForConversation?.systemPrompt,
    conversationSystemPrompt,
    systemPromptDialogOpen,
  ]);

  const isNewChat = paneIsHome && !activeId;
  const showSuggestions =
    Boolean(activeId) && !detailLoading && !detailError && chatSuggestions.length > 0;
  const displaySuggestions = showSuggestions ? chatSuggestions : EMPTY_SUGGESTIONS;

  /** 交互改路由前先聚焦本列(fork/新建等依赖"路由同步进聚焦列"的语义)。 */
  const focusSelf = React.useCallback(() => {
    useContainerTabsStore.getState().focusPane(container, paneIndex);
  }, [container, paneIndex]);

  const handleToolApproval = React.useCallback(
    async (toolCallId: string, approved: boolean, reason: string, answer?: string) => {
      if (!activeId) return;
      await api.post<{ status: string }>(`conversations/${activeId}/tool-approval`, {
        toolCallId,
        approved,
        reason,
        ...(answer != null ? { answer } : {}),
      });
    },
    [activeId],
  );

  const handleRegenerate = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      try {
        await api.post<{ status: string }>(`conversations/${activeId}/regenerate`, {
          messageId,
        });
        refreshList();
      } catch (error) {
        // 审计修复配套:压缩窗口内 regenerate 被服务端 409 挡下(写互斥,防压缩落库
        // 覆盖吞消息)。按业务码查 i18n,后端 message 兜底——否则用户点了没反应。
        const coded =
          error instanceof ApiError && error.errorCode
            ? t(`conversations.compress.error.${error.errorCode}`, { defaultValue: error.message })
            : undefined;
        toast.error(coded ?? (error instanceof Error ? error.message : String(error)));
      }
    },
    [activeId, refreshList, t],
  );

  const handleSelectBranch = React.useCallback(
    async (nodeId: string, selectIndex: number) => {
      if (!activeId) return;
      await api.post<{ status: string }>(`conversations/${activeId}/nodes/${nodeId}/select`, {
        selectIndex,
      });
    },
    [activeId],
  );

  const handleDeleteMessage = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      await api.delete<{ status: string }>(`conversations/${activeId}/messages/${messageId}`);
      // 编辑目标被删:绑定成孤儿(提交会 404),连带清草稿——留着只会让下一次发送
      // 打向已删除的消息。旧本地 state 实现同样隐式靠"切换会话清空"兜底,现在显式化。
      if (useEditingStore.getState().byConversation[activeId]?.messageId === messageId) {
        endEdit(activeId);
        clearCurrentDraft();
      }
    },
    [activeId, clearCurrentDraft, endEdit],
  );

  const handleForkMessage = React.useCallback(
    async (messageId: string) => {
      if (!activeId) return;
      const response = await api.post<{ conversationId: string }>(
        `conversations/${activeId}/fork`,
        {
          messageId,
        },
      );
      // fork 结果在本窗格打开:先聚焦,路由同步效应会把新会话挂进聚焦窗格。
      focusSelf();
      setActiveId(response.conversationId);
      navigate(`/c/${response.conversationId}`);
      refreshList();
    },
    [activeId, focusSelf, navigate, refreshList, setActiveId],
  );

  const handleTranslateMessage = React.useCallback(async (messageId: string) => {
    setTranslationDialogMessageId(messageId);
  }, []);

  // 阶段四:钉住/取消钉住。UI 靠 node_update 的整节点帧刷新徽标,无需重取详情。
  const handleTogglePin = React.useCallback(
    async (messageId: string, pinned: boolean) => {
      if (!activeId) return;
      await api.post<{ status: string; pinned: boolean }>(
        `conversations/${activeId}/messages/${messageId}/pin`,
        { pinned },
      );
    },
    [activeId],
  );

  const handleConfirmTranslateMessage = React.useCallback(async () => {
    if (!activeId || !translationDialogMessageId) return;
    setTranslatingMessage(true);
    try {
      // R7-4:翻译端点立即返回 202,翻译在后端异步进行并经 SSE 推送——无需禁用超时。
      await api.post<{ status: string; translation?: string }>(
        `conversations/${activeId}/messages/${translationDialogMessageId}/translate`,
        { targetLanguage: translationLanguage },
      );
      setTranslationDialogMessageId(null);
      refreshConversation(activeId);
      refreshList();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("conversations.translate.failed"));
    } finally {
      setTranslatingMessage(false);
    }
  }, [activeId, refreshList, translationDialogMessageId, translationLanguage]);

  const handleStartEdit = React.useCallback(
    (message: MessageDto) => {
      if (!activeId || (message.role !== "USER" && message.role !== "ASSISTANT")) return;

      const draft = toEditDraft(message);
      if (!draft) return;

      beginEdit(activeId, {
        messageId: message.id,
        sourceParts: draft.sourceParts,
        textPartIndex: draft.textPartIndex,
      });
      replaceDraft(draft.text, draft.attachments);
    },
    [activeId, beginEdit, replaceDraft],
  );

  const handleCancelEdit = React.useCallback(() => {
    if (activeId) endEdit(activeId);
    clearCurrentDraft();
  }, [activeId, clearCurrentDraft, endEdit]);

  const handleClickSuggestion = React.useCallback(
    (suggestion: string) => {
      if (editingSession && activeId) {
        endEdit(activeId);
      }
      if (draftKey) setDraftText(draftKey, suggestion);
    },
    [activeId, draftKey, editingSession, endEdit, setDraftText],
  );

  const handleSend = React.useCallback(async () => {
    // 域9-1(3B)防御层:发送门禁主判定在 chat-input(按钮灰+发送键短路),这里再兜一层
    // ——编辑会话/快捷键/程序化触发等绕开按钮的路径,也不会把"解析中"的附件发出去。
    const draftPartsForGate = getCurrentSubmitParts();
    const parsingIds = useChatInputStore.getState().parsingFileIds;
    if (
      parsingIds.length > 0 &&
      draftPartsForGate.some((part) => {
        const fileId = part.metadata?.fileId;
        return typeof fileId === "number" && parsingIds.includes(fileId);
      })
    ) {
      toast.info(t("input:chat.parsing_send_blocked"));
      return;
    }

    if (!editingSession) {
      await handleSubmit();
      refreshList();
      return;
    }

    if (!activeId) return;

    const draftParts = draftPartsForGate;
    if (draftParts.length === 0) return;

    const nextParts = buildEditedParts(editingSession, draftParts);

    await api.post<{ status: string }>(
      `conversations/${activeId}/messages/${editingSession.messageId}/edit`,
      { parts: stripEditDraftMetadata(nextParts) },
    );

    endEdit(activeId);
    clearCurrentDraft();
  }, [
    activeId,
    clearCurrentDraft,
    editingSession,
    endEdit,
    getCurrentSubmitParts,
    handleSubmit,
    refreshList,
    t,
  ]);

  const handleCompressConversation = React.useCallback(() => {
    if (!activeId) return;
    setCompressDialogOpen(true);
  }, [activeId]);

  // 提示词优化时提取最近 3 轮对话(6 条消息)的纯文本,让优化模型理解"那个""上次的"等指代。
  // 只取 text part,截断到 4000 字符;首条消息时返回空。
  const getOptimizeContext = React.useCallback((): string => {
    // 点击优化时按需读取(不订阅):事件处理器拿最新值即可,不为它拉宽重渲染面
    const detail = activeId ? useConversationStore.getState().entries[activeId]?.detail : null;
    if (!detail || detail.messages.length === 0) return "";
    const recent = detail.messages
      .slice(-6)
      .map((node) => node.messages[node.selectIndex] ?? node.messages[0]);
    const lines: string[] = [];
    for (const message of recent) {
      if (!message) continue;
      if (message.role !== "USER" && message.role !== "ASSISTANT") continue;
      const text = message.parts
        .filter((p) => p.type === "text")
        .map((p) => String((p as { text?: string }).text ?? ""))
        .join("")
        .trim();
      if (!text) continue;
      lines.push(
        `${message.role === "USER" ? t("conversations.optimize_context.user") : t("conversations.optimize_context.assistant")}: ${text}`,
      );
    }
    return lines.join("\n\n").slice(0, 4000);
  }, [activeId]);

  // 压缩执行共享通道:压缩框与 /compact 指令两个入口走同一函数、同一状态与反馈
  // (方案 §5.1,无平行逻辑)。指令路径不传 UI 历史压缩参数(走服务端默认),失败提示
  // 带指令名前缀(方案 §4.4)。
  const performCompress = React.useCallback(
    async (
      params: { additionalPrompt: string; targetTokens?: number; keepRecentMessages?: number },
      errorPrefix = "",
    ) => {
      if (!activeId) return;
      // 捕获发起时的会话 id:压缩期间用户可能切换会话,begin/end/刷新都要落在原会话上。
      const conversationId = activeId;
      const controller = new AbortController();
      useCompressStore.getState().begin(conversationId, controller);
      try {
        // status 契约:compressed / aborted(服务端收到取消后静默吞掉 AbortError 的确认,
        // 不带成功文案)。客户端 abort 路径抛 AbortError;服务端已停止但 fetch 尚未断时
        // 走这里——同一轻量确认文案,不弹成功。
        const result = await api.post<{ status: string }>(
          `conversations/${conversationId}/compress`,
          params,
          {
            timeout: false,
            signal: controller.signal,
          },
        );
        setCompressDialogOpen(false);
        if (result.status === "aborted") {
          toast.info(t("conversations.compress.aborted"));
        } else {
          refreshConversation(conversationId);
          refreshList();
          toast.success(
            isWorkspaceConversation
              ? t("conversations.compress.workspace_success")
              : t("conversations.compress.success"),
          );
        }
      } catch (error) {
        // R7-4:用户主动取消不报错(取消不是失败)——给一条轻量确认,明确上下文未受影响
        // (内测反馈:中止后毫无反应,用户不确定压缩到底做没做)。
        if (controller.signal.aborted) {
          toast.info(t("conversations.compress.aborted"));
        } else {
          // 带业务码的错误按码查 i18n 文案(服务端 CodedError 通道;查不到用后端 message 兜底)。
          const coded =
            error instanceof ApiError && error.errorCode
              ? t(`conversations.compress.error.${error.errorCode}`, {
                  defaultValue: error.message,
                })
              : undefined;
          const message =
            coded ?? (error instanceof Error ? error.message : t("conversations.compress.failed"));
          toast.error(`${errorPrefix}${message}`);
        }
      } finally {
        useCompressStore.getState().end(conversationId);
      }
    },
    [activeId, isWorkspaceConversation, refreshList],
  );

  const confirmHighCompressRatio = React.useCallback(
    async (ratio: number): Promise<boolean> => {
      const acknowledged = await confirmDialog({
        title: t("conversations.compress.ratio_warning_title"),
        description: t("conversations.compress.ratio_warning_description", {
          kept: 100 - ratio,
        }),
        confirmLabel: t("conversations.compress.ratio_warning_confirm", { ratio }),
        cancelLabel: t("conversations.compress.ratio_warning_cancel"),
        danger: true,
      });
      if (acknowledged) compressRatioAcknowledgedRef.current = true;
      return acknowledged;
    },
    [t],
  );

  // 松手才弹警告:拖动过程中 onValueChange 连续触发,逐个弹框会互相顶掉。
  const handleCompressRatioCommit = React.useCallback(
    async (raw: number) => {
      const ratio = normalizeCompressRatio(raw);
      if (ratio <= COMPRESS_RATIO_WARN || compressRatioAcknowledgedRef.current) return;
      if (!(await confirmHighCompressRatio(ratio))) setCompressRatio(COMPRESS_RATIO_WARN);
    },
    [confirmHighCompressRatio],
  );

  const handleConfirmCompressConversation = React.useCallback(async () => {
    // 提交前归一:输入框允许清空/输到一半,真正发给后端的永远是合法整数。
    const keepRecentMessages = normalizeCompressKeepRecent(compressKeepRecent);
    setCompressKeepRecent(String(keepRecentMessages));
    const ratio = normalizeCompressRatio(compressRatio);
    // 滑杆可能沿用上次打开的 >65% 值,没有重新拖动就不会触发 commit 警告——
    // 提交前补一次门,不确认就不发请求,并把滑杆拉回安全线。
    if (ratio > COMPRESS_RATIO_WARN && !compressRatioAcknowledgedRef.current) {
      if (!(await confirmHighCompressRatio(ratio))) {
        setCompressRatio(COMPRESS_RATIO_WARN);
        return;
      }
    }
    await performCompress({
      // 上下文未知时省略字段,由服务端按默认目标长度处理。
      ...(compressTargetTokens != null ? { targetTokens: compressTargetTokens } : {}),
      additionalPrompt: compressAdditionalPrompt,
      keepRecentMessages,
    });
  }, [
    compressAdditionalPrompt,
    compressKeepRecent,
    compressRatio,
    compressTargetTokens,
    confirmHighCompressRatio,
    performCompress,
  ]);

  // ── 斜杠指令:清单(服务端权威)+ 执行分发表(实现池前端部分;方案 §3.4) ──────
  const availableSlashCommands = useAvailableCommands(activeId);
  // 域5-1(3F):执行器返回 false=未受理(如压缩占用),chat-input 据此回填原文;正常受理返回 void。
  const slashExecutors: Record<string, (argument: string) => Promise<boolean | void>> =
    React.useMemo(
      () => ({
        // /compact [额外指示] → 既有压缩链路;进行中再触发提示占用(复用现有互斥)并告知未受理。
        compact: async (argument: string) => {
          if (compressing) {
            toast.error(t("conversations.compress.busy"));
            return false;
          }
          await performCompress({ additionalPrompt: argument }, "/compact ");
        },
      }),
      [compressing, performCompress, t],
    );
  // 防两表漂移(方案 §3.1):服务端说可用但前端无执行器的指令不展示,并留痕便于排查。
  const slashCommands = React.useMemo(() => {
    const known = availableSlashCommands.filter((command) => command.name in slashExecutors);
    if (known.length !== availableSlashCommands.length) {
      const missing = availableSlashCommands
        .filter((c) => !(c.name in slashExecutors))
        .map((c) => c.name);
      console.warn("[slash-commands] 服务端清单存在前端未实现的指令,已隐藏:", missing);
    }
    return known;
  }, [availableSlashCommands, slashExecutors]);
  const handleSlashCommand = React.useCallback(
    async (name: string, argument: string) => {
      return await slashExecutors[name]?.(argument);
    },
    [slashExecutors],
  );

  const handleStop = React.useCallback(async () => {
    if (!activeId) return;
    await api.post<{ status: string }>(`conversations/${activeId}/stop`);
  }, [activeId]);

  // 语音模式(台账 §1.3):免提对话循环。入口在输入区,横幅在队列面板之上。
  // 选中的 ASR 服务需有服务端实时判停(OpenAI Realtime / DashScope / 火山);MiMo 是
  // HTTP 分段识别,没有实时 VAD,不能驱动免提循环——新增时已弹窗提示,这里再兜底拦截。
  const voiceState = useVoiceModeState();
  const voiceActive = voiceState.phase !== "off";
  const selectedAsrProvider = React.useMemo(
    () =>
      settings?.asrProviders?.find((item) => item.id === settings?.selectedASRProviderId) ?? null,
    [settings],
  );
  const voiceCapable = Boolean(settings?.selectedASRProviderId && selectedAsrProvider);
  const voiceSupported = voiceCapable && selectedAsrProvider?.type !== "mimo";
  const handleToggleVoiceMode = React.useCallback(() => {
    if (voiceActive) {
      voiceMode.stop();
      return;
    }
    if (!activeId) return;
    if (!settings?.selectedASRProviderId || !selectedAsrProvider) {
      toast.error(t("input:voice.not_configured"));
      return;
    }
    if (!voiceSupported) {
      toast.error(t("input:voice.no_server_vad"));
      return;
    }
    const sampleRate = Number(
      selectedAsrProvider.sampleRate ||
        (selectedAsrProvider.type === "openai_realtime" ? 24000 : 16000),
    );
    voiceMode.start(activeId, selectedAsrProvider.id, sampleRate);
  }, [
    voiceActive,
    activeId,
    settings?.selectedASRProviderId,
    selectedAsrProvider,
    voiceSupported,
    t,
  ]);

  const handleSaveConversationSystemPrompt = React.useCallback(async () => {
    if (!activeId || activeAssistantForConversation?.allowConversationSystemPrompt !== true) return;
    await api.post<{ status: string }>(`conversations/${activeId}/system-prompt`, {
      systemPrompt: systemPromptDraft,
    });
    setSystemPromptDialogOpen(false);
    refreshConversation(activeId);
    refreshList();
    toast.success(t("conversations.custom_prompt.saved"));
  }, [
    activeAssistantForConversation?.allowConversationSystemPrompt,
    activeId,
    refreshList,
    systemPromptDraft,
  ]);

  const handleSaveConversationSystemPromptValue = React.useCallback(
    async (systemPrompt: string) => {
      if (!activeId || activeAssistantForConversation?.allowConversationSystemPrompt !== true)
        return;
      await api.post<{ status: string }>(`conversations/${activeId}/system-prompt`, {
        systemPrompt,
      });
      setSystemPromptDraft(systemPrompt);
      refreshConversation(activeId);
      refreshList();
      toast.success(t("conversations.custom_prompt.saved"));
    },
    [activeAssistantForConversation?.allowConversationSystemPrompt, activeId, refreshList],
  );

  // 拖拽落点(J 轮二级 + L 轮一级统一到一套三分区):拖动标签悬停内容区时
  // 左/中/右 三区高亮 —— 左/右 = 在本列左/右侧拆出新列,中 = 并入本列。
  // 二级载荷(会话标签)在本容器内分栏/移动;一级载荷(容器)拆出/并入"组"——
  // 与二级完全同构:中区 = 并入本组(组焦点换成它),左右 = 带着自己的会话标签
  // 成独立新组。落点动作与高亮都读内存 store(dataTransfer 在 dragover 阶段读不到)。
  // 屏上的列都属于各组焦点容器,所以拖焦点标签时"目标列 = 自己的列"是常态,不是异常:
  // 落到自己列的左右缘 = 把自己从本组拆出去(与二级"把会话标签拖出本窗格"同构),
  // 少了这条,焦点标签就成了唯一拖不出分栏的标签。
  const dragPayload = useTabDragStore((state) => state.dragging);
  const [dropZone, setDropZone] = React.useState<"left" | "center" | "right" | null>(null);

  const resolveDropZone = (event: React.DragEvent<HTMLDivElement>): "left" | "center" | "right" => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    return ratio < 0.25 ? "left" : ratio > 0.75 ? "right" : "center";
  };

  const handleZoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const payload = useTabDragStore.getState().dragging;
    setDropZone(null);
    useTabDragStore.getState().setDragging(null);
    if (!payload) return;
    const store = useContainerTabsStore.getState();
    const zone = resolveDropZone(event);

    if (payload.kind === "container") {
      const selfDrag = payload.container === container;
      // 中区 = 并入本组;拖的是本组焦点容器时它已在本组,无动作。
      if (selfDrag && zone === "center") return;
      if (zone === "center") {
        // 并入本组 = 激活它(已在屏上 = 换本组焦点;不在屏上 = 接替本组席位)。
        // 激活前先聚焦本列:被接替的是本组,不是旧的全局焦点组。
        store.focusPane(container, paneIndex);
        store.activateContainer(payload.container);
      } else {
        // 拖出成新组:从原组移除(原组空了即消失)再落到本组左/右。
        // 拖本组焦点容器时锚点取同组另一成员 —— 屏上的列都属于各组焦点容器,单组时
        // 它悬停到的唯一目标就是自己的列,不接这一手它就成了唯一拆不出去的标签。
        const anchor = selfDrag ? groupSiblingOf(store.groups, container) : container;
        // 自锚/列满/本组只剩它自己(anchor 为 null)都会让 splitContainerBeside 返回 false:
        // 守卫收口在 store 一处,视图不重复校验,只在被拒时统一外显原因。
        if (
          anchor === null ||
          !store.splitContainerBeside(payload.container, anchor, zone === "left" ? "left" : "right")
        ) {
          toast.error(t("workspace.tabs.split_full", { max: MAX_PANES }));
          return;
        }
      }
      // 落定后按新状态取该容器的停留会话(state 已被 set 替换,须重新读)。
      const next = useContainerTabsStore.getState();
      const panes = next.panes[payload.container] ?? [];
      const focus = Math.max(
        0,
        Math.min(next.focusedPane[payload.container] ?? 0, panes.length - 1),
      );
      const target = panes[focus]?.active ?? null;
      navigate(target ? `/c/${target}` : "/");
      return;
    }

    // 会话标签只在自己的容器内挪(跨容器等于改会话归属,不是布局操作)。
    if (payload.container !== container) return;
    if (zone === "center") {
      store.moveConversationToPane(container, payload.conversationId, paneIndex);
    } else {
      const ok = store.splitConversation(
        container,
        payload.conversationId,
        zone === "left" ? paneIndex : paneIndex + 1,
      );
      // 分栏被拒(可见列已满 / 源窗格只剩一个标签)→ 退化为移入本列。
      if (!ok) store.moveConversationToPane(container, payload.conversationId, paneIndex);
    }
    navigate(`/c/${payload.conversationId}`);
  };

  // 本列是否接受当前拖拽:决定落点覆盖层挂不挂(不接受时不拦截指针、也不高亮)。
  // 一级载荷落到"自己这列"是常态而非异常(屏上的列都属于各组焦点容器),接与不接看
  // 本组是否还有别人接手这一组:有 = 可拆出去;只剩它自己 = 已是独立组,无处可拆。
  const selfContainerDrag =
    dragPayload?.kind === "container" && dragPayload.container === container;
  const selfSplittable = useContainerTabsStore(
    (state) => groupSiblingOf(state.groups, container) !== null,
  );
  const dropActive =
    dragPayload !== null &&
    (dragPayload.kind === "container"
      ? dragPayload.container !== container || selfSplittable
      : dragPayload.container === container);
  // 覆盖层的上边界:拖会话标签时让开标签行(它自己是"并入本列"的落点);拖容器时
  // 标签行对它没有语义,铺满整列免留死区。
  const hasTabStrip = useContainerTabsStore(
    (state) => (state.panes[container]?.[paneIndex]?.tabs.length ?? 0) > 0,
  );
  const overlayTop = dragPayload?.kind === "conversation" && hasTabStrip ? "top-9" : "top-0";

  return (
    <PaneContainerProvider container={container}>
      <div
        className="relative flex h-full min-h-0 flex-1 flex-col"
        // 点击非焦点列任意处 → 聚焦并把路由切到它的激活会话。会话标签自己会导航到它指定
        // 的会话(data-tab-nav),不能让这里先抢一次焦点切换,否则先跳本列旧会话、
        // 再跳目标会话,中间闪一帧。
        onMouseDownCapture={
          focused
            ? undefined
            : (event) => {
                if ((event.target as HTMLElement).closest("[data-tab-nav]")) return;
                onFocusPane(container, paneIndex);
              }
        }
      >
        <ConversationTabStrip
          container={container}
          paneIndex={paneIndex}
          focused={focused}
          conversations={conversations}
          onRename={onRenameConversation}
          trailing={
            canOverrideConversationSystemPrompt ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setSystemPromptDialogOpen(true)}
                disabled={!hasDetail}
                aria-label={t("conversations.custom_prompt.edit_aria")}
                title={t("conversations.custom_prompt.edit_aria")}
              >
                <Pencil className="size-4" />
              </Button>
            ) : null
          }
        />

        <div
          className={cn(
            "flex flex-1 flex-col min-h-0 overflow-hidden",
            isNewChat && "justify-center",
          )}
        >
          {!isNewChat && (
            <>
              {canOverrideConversationSystemPrompt && hasDetail ? (
                <ConversationSystemPromptButton
                  value={conversationSystemPrompt}
                  onSave={handleSaveConversationSystemPromptValue}
                />
              ) : null}
              <div className="relative flex min-h-0 flex-1">
                <ConversationTimeline
                  activeId={activeId}
                  isHomeRoute={paneIsHome}
                  settings={settings}
                  onEdit={handleStartEdit}
                  onDelete={handleDeleteMessage}
                  onFork={handleForkMessage}
                  onRegenerate={handleRegenerate}
                  onSelectBranch={handleSelectBranch}
                  onTranslate={handleTranslateMessage}
                  onTogglePin={handleTogglePin}
                  onToolApproval={handleToolApproval}
                  onCompress={handleCompressConversation}
                />
              </div>
            </>
          )}

          <div>
            {isNewChat &&
              (activeWorkspace ? (
                <WorkspaceEmptyState workspace={activeWorkspace} />
              ) : (
                <div className="mb-6 text-center">
                  <EmptyGreeting />
                </div>
              ))}
            {/* 分块 TTS 播放条是全局单例状态,只挂在聚焦窗格,避免分栏时重复显示。 */}
            {focused ? <TtsPlayBar /> : null}
            {/* pi 引擎瞬态状态条(P5):按窗格各自订阅本会话状态,分栏互不串扰。 */}
            <EngineStatusBar conversationId={activeId} />
            {/* 语音模式横幅(免提对话循环;关闭时不渲染)。 */}
            {voiceActive && activeId ? (
              <VoiceModeBanner onEnd={() => voiceMode.stop()} onRetry={handleToggleVoiceMode} />
            ) : null}
            <ChatInputArea
              draftKey={draftKey}
              slashCommands={slashCommands}
              onSlashCommand={handleSlashCommand}
              /* 消息发送队列贴片:渲染在输入卡上沿外侧(左右内缩、下沿被卡片盖住,自带
               叠色色差),读作「附着在输入框上的队列」而非输入框的一部分。条件带 items
               长度——空队列不给插槽,否则输入卡上方会留一条空贴片。 */
              queueSlot={
                activeId &&
                conversationMessageQueue &&
                conversationMessageQueue.items.length > 0 ? (
                  <MessageQueuePanel conversationId={activeId} queue={conversationMessageQueue} />
                ) : null
              }
              isGenerating={conversationIsGenerating}
              disabled={detailLoading || Boolean(detailError)}
              isEditing={Boolean(editingSession)}
              suggestions={displaySuggestions}
              onSuggestionClick={handleClickSuggestion}
              onCancelEdit={editingSession ? handleCancelEdit : undefined}
              shouldDeleteFileOnRemove={shouldDeleteAttachmentFileOnRemove}
              onSend={handleSend}
              onStop={activeId ? handleStop : undefined}
              onExportConversation={
                hasMessages
                  ? async (includeReasoning: boolean) => {
                      // 导出需要完整历史:窗口化(I-2)时先拉全量;拿不到完整历史则报错
                      // 放弃,绝不导出被窗口截断的部分内容。
                      const detail = activeId ? await ensureFullConversationDetail(activeId) : null;
                      if (!detail) {
                        if (activeId) toast.error(t("conversations.errors.load_detail_failed"));
                        return;
                      }
                      const content = await convertConversationToMarkdown(detail, includeReasoning);
                      const filename = safeMarkdownFilename(detail.title || "conversation");
                      // 域10-1:桌面壳落盘 + 定位;浏览器维持下载(编排层分流)。
                      await exportTextFile(content, filename);
                    }
                  : undefined
              }
              onCompressConversation={hasMessages ? handleCompressConversation : undefined}
              getOptimizeContext={getOptimizeContext}
              conversationId={activeId}
              onToggleVoiceMode={voiceSupported || voiceActive ? handleToggleVoiceMode : undefined}
              voiceModeActive={voiceActive}
            />
          </div>
        </div>

        {dropActive ? (
          // 落点提示层:三区等分,命中区亮起品牌色薄底 + 描边,并给一句"放手会发生什么"。
          // 只在本列接受当前拖拽时挂载 —— 不接受时既不拦指针也不亮,用户能看出此处不可放。
          <div
            className={cn("absolute inset-x-0 bottom-0 z-30", overlayTop)}
            onDragOver={(event) => {
              const zone = resolveDropZone(event);
              // 拖本组焦点容器落回自己的中区 = 并入它已在的组,什么都不会发生:既不亮也不
              // 拦指针(光标保持"不可放"),别承诺一个空动作。左右缘才是"拆出去"。
              if (selfContainerDrag && zone === "center") {
                setDropZone(null);
                return;
              }
              event.preventDefault();
              setDropZone(zone);
            }}
            onDragLeave={() => setDropZone(null)}
            onDrop={handleZoneDrop}
          >
            {(["left", "center", "right"] as const).map((zone) => (
              <div
                key={zone}
                className={cn(
                  "pointer-events-none absolute inset-y-1 flex items-center justify-center rounded-xl transition-all duration-150",
                  zone === "left" && "left-1 w-1/4",
                  zone === "center" && "left-1/4 right-1/4",
                  zone === "right" && "right-1 w-1/4",
                  dropZone === zone
                    ? "bg-primary/10 ring-1 ring-primary/30"
                    : "ring-1 ring-transparent",
                )}
              >
                {dropZone === zone ? (
                  <span className="rounded-full bg-[var(--ds-surface-100)] px-2.5 py-1 text-mini font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-elevation-100)]">
                    {t(
                      zone === "center"
                        ? "workspace.tabs.drop_hint_merge"
                        : "workspace.tabs.drop_hint_split",
                    )}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <Dialog
          open={compressDialogOpen}
          onOpenChange={(open) => !compressing && setCompressDialogOpen(open)}
        >
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("conversations.compress.dialog_title")}</DialogTitle>
              <DialogDescription>
                {isWorkspaceConversation
                  ? t("conversations.compress.workspace_description")
                  : t("conversations.compress.dialog_description")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5">
              {/* P5:工作区会话走 pi 原生压缩,压缩比例/保留最近消息是 UI 历史压缩的
                参数(服务端忽略),隐藏以免误导;额外要求透传为压缩自定义指示。 */}
              {!isWorkspaceConversation ? (
                <>
                  <div className="rounded-lg border bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                    {t("conversations.compress.manual_hint")}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium">
                        {t("conversations.compress.ratio")}
                      </span>
                      <span className="text-sm font-semibold tabular-nums">
                        {compressRatio}%
                      </span>
                    </div>
                    <Slider
                      value={[compressRatio]}
                      min={COMPRESS_RATIO_MIN}
                      max={COMPRESS_RATIO_MAX}
                      step={1}
                      onValueChange={(value) =>
                        setCompressRatio(normalizeCompressRatio(value[0] ?? COMPRESS_RATIO_DEFAULT))
                      }
                      onValueCommit={(value) =>
                        void handleCompressRatioCommit(value[0] ?? compressRatio)
                      }
                      aria-label={t("conversations.compress.ratio")}
                    />
                    <p className="text-xs text-muted-foreground">
                      {compressTargetTokens != null && compressContextTokens != null
                        ? t("conversations.compress.ratio_hint", {
                            kept: 100 - compressRatio,
                            target: compressTargetTokens.toLocaleString(),
                            context: compressContextTokens.toLocaleString(),
                          })
                        : t("conversations.compress.ratio_hint_no_context")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">
                      {t("conversations.compress.keep_recent")}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {COMPRESS_KEEP_OPTIONS.map((value) => (
                        <Button
                          key={value}
                          type="button"
                          variant={
                            normalizeCompressKeepRecent(compressKeepRecent) === value
                              ? "default"
                              : "outline"
                          }
                          onClick={() => setCompressKeepRecent(String(value))}
                        >
                          {value}
                        </Button>
                      ))}
                    </div>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      value={compressKeepRecent}
                      onChange={(event) => setCompressKeepRecent(event.target.value)}
                      onBlur={() =>
                        setCompressKeepRecent(
                          String(normalizeCompressKeepRecent(compressKeepRecent)),
                        )
                      }
                      aria-label={t("conversations.compress.keep_recent")}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("conversations.compress.keep_recent_hint")}
                    </p>
                  </div>
                </>
              ) : null}
              <label className="block space-y-2">
                <span className="text-sm font-medium">
                  {t("conversations.compress.additional_prompt")}
                </span>
                <Textarea
                  value={compressAdditionalPrompt}
                  onChange={(event) => setCompressAdditionalPrompt(event.target.value)}
                  placeholder={t("conversations.compress.additional_placeholder")}
                  className="min-h-28"
                />
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  // R7-4:压缩中点取消 = 中止请求并关框(后端保证取消后不改写会话);
                  // 未压缩时就是普通关闭。取消句柄在全局 store,切页回来仍可取消。
                  if (activeId) useCompressStore.getState().cancel(activeId);
                  setCompressDialogOpen(false);
                }}
              >
                {t("conversations.compress.cancel")}
              </Button>
              <Button
                type="button"
                disabled={compressing}
                onClick={() => void handleConfirmCompressConversation()}
              >
                {compressing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("conversations.compress.start")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={Boolean(translationDialogMessageId)}
          onOpenChange={(open) => {
            if (!open && !translatingMessage) setTranslationDialogMessageId(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("conversations.translate.dialog_title")}</DialogTitle>
              <DialogDescription>
                {t("conversations.translate.dialog_description")}
              </DialogDescription>
            </DialogHeader>
            <Select value={translationLanguage} onValueChange={setTranslationLanguage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSLATION_LANGUAGES.map((language) => (
                  <SelectItem key={language.value} value={language.value}>
                    {t(`conversations.translate.lang.${language.value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={translatingMessage}
                onClick={() => setTranslationDialogMessageId(null)}
              >
                {t("conversations.translate.cancel")}
              </Button>
              <Button
                type="button"
                disabled={translatingMessage}
                onClick={() => void handleConfirmTranslateMessage()}
              >
                {translatingMessage ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("conversations.translate.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={systemPromptDialogOpen} onOpenChange={setSystemPromptDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("conversations.custom_prompt.dialog_title")}</DialogTitle>
              <DialogDescription>
                {t("conversations.custom_prompt.dialog_description")}
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={systemPromptDraft}
              onChange={(event) => setSystemPromptDraft(event.target.value)}
              className="field-sizing-fixed h-72 max-h-[55vh] overflow-y-auto font-mono text-xs leading-relaxed"
              placeholder={t("conversations.custom_prompt.dialog_placeholder")}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setSystemPromptDialogOpen(false)}>
                {t("conversations.custom_prompt.cancel")}
              </Button>
              <Button
                onClick={() => void handleSaveConversationSystemPrompt()}
                disabled={!activeId}
              >
                {t("conversations.custom_prompt.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PaneContainerProvider>
  );
});

function ConversationsPageInner() {
  const { t } = useTranslation("page");
  // 面板标题的 workbench.* 在 common 命名空间;与顶部开关(WorkbenchToggle)取同一词条。
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const isHomeRoute = !routeId;
  const isMobile = useIsMobile();
  const { panel, openPanel, closePanel } = useWorkbench();

  const { settings, assistants, currentAssistantId, currentAssistant } = useCurrentAssistant();
  const { conversations, activeId, setActiveId, loading, error, hasMore, loadMore, refreshList } =
    useConversationList({ currentAssistantId, routeId, autoSelectFirst: !isHomeRoute });

  const [homeDraftId, setHomeDraftId] = React.useState(() => createHomeDraftId());

  const activeConversation = conversations.find((item) => item.id === activeId);
  // ===== 双层标签页(工作区 M2-1) =====
  // 路由 /c/:id 是权威:会话的容器归属(列表 meta 或详情快照的 workspaceId)一旦可知,
  // 就把对应容器与会话标签打开——搜索跨容器命中、外部链接进入都自然切换容器。
  // J 轮分栏:openConversation 命中已开窗格时聚焦过去,否则进当前聚焦窗格。
  const detailWorkspaceId = useConversationStore((state) =>
    activeId ? state.entries[activeId]?.detail?.workspaceId : undefined,
  );
  React.useEffect(() => {
    if (!activeId) return;
    const workspaceId = activeConversation ? activeConversation.workspaceId : detailWorkspaceId;
    if (workspaceId === undefined) return; // 归属未知(列表/详情都未到),等下一拍
    useContainerTabsStore.getState().openConversation(workspaceId ?? CHAT_CONTAINER, activeId);
  }, [activeId, activeConversation, detailWorkspaceId]);
  const activeContainer = useContainerTabsStore((state) => state.activeTab);
  // M3-6:工作区容器的首屏空态需要工作区实体(名称/类型/root)。并排后按列取——
  // 每列显示自己容器的空态,而不是聚焦列容器的。
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspaceOf = React.useCallback(
    (container: ContainerKey) =>
      container === CHAT_CONTAINER ? undefined : workspaces.find((item) => item.id === container),
    [workspaces],
  );
  // 侧栏语义随容器切换(方案 §3.1):只列当前容器的会话;完整列表仍用于标题查找等。
  const containerConversations = React.useMemo(
    () =>
      conversations.filter((item) =>
        activeContainer === CHAT_CONTAINER
          ? item.workspaceId == null
          : item.workspaceId === activeContainer,
      ),
    [activeContainer, conversations],
  );

  // 分栏(L 轮分区模型):屏幕列 = 各组焦点容器 × 各自窗格,摊平后左→右渲染。焦点列的
  // 会话以路由为权威,其余列用各自窗格的激活标签。
  // 订阅整个 panes(而非只订阅激活容器的):分栏后同屏有多个容器的窗格,都要参与摊平。
  // 代价可忽略——panes 只在用户开/关/拖标签时变,那些动作本就伴随导航重渲染。
  const groups = useContainerTabsStore((state) => state.groups);
  const openTabs = useContainerTabsStore((state) => state.openTabs);
  const panesRecord = useContainerTabsStore((state) => state.panes);
  const columns = React.useMemo(
    () => flattenColumns(groups, panesRecord, activeContainer),
    [groups, panesRecord, activeContainer],
  );
  // 幽灵标签(开着的容器不在任何组):缀在全局焦点组的标签栏尾部渲染,保持可见可点;
  // 其它组的条不收容它们,免得用户切焦点组时标签跟着乱跳。
  const ghostTabs = React.useMemo(
    () => openTabs.filter((key) => !groups.some((group) => group.includes(key))),
    [openTabs, groups],
  );
  const focusedPaneIndex = useContainerTabsStore((state) => {
    const count = state.panes[state.activeTab]?.length ?? 1;
    return Math.max(0, Math.min(state.focusedPane[state.activeTab] ?? 0, count - 1));
  });

  const handleFocusPane = React.useCallback(
    (container: ContainerKey, index: number) => {
      const store = useContainerTabsStore.getState();
      const count = store.panes[container]?.length ?? 1;
      const current = Math.max(0, Math.min(store.focusedPane[container] ?? 0, count - 1));
      if (store.activeTab === container && current === index) return;
      const target = store.focusPane(container, index);
      setActiveId(target);
      navigate(target ? `/c/${target}` : "/");
    },
    [navigate, setActiveId],
  );

  React.useEffect(() => {
    const base = t("conversations.meta.title");
    document.title = activeConversation?.title ? `${activeConversation.title} - ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [activeConversation?.title, t]);

  const handleSelect = React.useCallback(
    (id: string, messageId?: string) => {
      setActiveId(id);
      // 搜索命中带 messageId 时通过 URL query 传给详情页,加载完成后滚到那条消息位置
      // (对齐安卓);普通点击不带 messageId,维持原"进入会话滚底部"行为。
      const target = messageId ? `/c/${id}?msg=${messageId}` : `/c/${id}`;
      // 同会话也要 navigate 以更新 query(搜索当前会话的某条消息)
      if (routeId !== id || messageId) {
        navigate(target);
      }
    },
    [navigate, routeId, setActiveId],
  );

  const handleAssistantChange = React.useCallback(
    async (assistantId: string) => {
      await api.post<{ status: string }>("settings/assistant", { assistantId });
      await refreshSettingsStore();
      setActiveId(null);
      if (routeId) {
        navigate("/", { replace: true });
      }
      refreshList();
    },
    [navigate, refreshList, routeId, setActiveId],
  );

  const handleTogglePinConversation = React.useCallback(
    async (conversationId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/pin`);
      refreshList();
    },
    [refreshList],
  );

  const handleRegenerateConversationTitle = React.useCallback(
    async (conversationId: string) => {
      // R7-4:标题生成设 120s 客户端上限(原 timeout:false 会让侧栏 spinner 跟着卡死的
      // 后端无限转)。ky 超时会 abort 底层请求;后端在落库前检查 request.signal,
      // 超时后的迟到结果不落库。
      await api.post<{ status: string }>(
        `conversations/${conversationId}/regenerate-title`,
        undefined,
        { timeout: 120_000 },
      );
      // 有活跃订阅(本列/分栏其它列)才需要重取,refreshConversation 对未订阅 id 空操作
      refreshConversation(conversationId);
      refreshList();
    },
    [refreshList],
  );

  const handleMoveConversation = React.useCallback(
    async (conversationId: string, assistantId: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/move`, { assistantId });
      if (conversationId === activeId) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
  );

  const handleUpdateConversationTitle = React.useCallback(
    async (conversationId: string, title: string) => {
      await api.post<{ status: string }>(`conversations/${conversationId}/title`, { title });
      refreshList();
    },
    [refreshList],
  );

  const handleDeleteConversation = React.useCallback(
    async (conversationId: string) => {
      await api.delete<Record<string, never>>(`conversations/${conversationId}`, {
        parseJson: (raw) => (raw ? JSON.parse(raw) : {}),
      });
      evictConversations([conversationId]);
      useContainerTabsStore.getState().forgetConversation(conversationId);
      useEditingStore.getState().endEditMany([conversationId]);
      if (conversationId === activeId) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId === conversationId) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
  );

  const handleDeleteConversations = React.useCallback(
    async (conversationIds: string[]) => {
      await api.post<{ status: string; deleted: number }>("conversations/batch-delete", {
        ids: conversationIds,
      });
      evictConversations(conversationIds);
      useEditingStore.getState().endEditMany(conversationIds);
      for (const id of conversationIds) useContainerTabsStore.getState().forgetConversation(id);
      if (activeId && conversationIds.includes(activeId)) {
        setActiveId(null);
        setHomeDraftId(createHomeDraftId());
        if (routeId && conversationIds.includes(routeId)) {
          navigate("/", { replace: true });
        }
      }
      refreshList();
    },
    [activeId, navigate, refreshList, routeId, setActiveId],
  );

  const handleCreateConversation = React.useCallback(() => {
    closePanel();
    setActiveId(null);
    setHomeDraftId(createHomeDraftId());

    if (routeId) {
      navigate("/");
    }
  }, [closePanel, navigate, routeId, setActiveId]);

  // 切换到上/下个会话(按侧边栏列表顺序:置顶优先,然后按更新时间降序,与展示一致)。
  const switchConversation = (direction: -1 | 1) => {
    if (!activeId || containerConversations.length === 0) return;
    const index = containerConversations.findIndex((c) => c.id === activeId);
    if (index === -1) return;
    const target = containerConversations[index + direction];
    if (!target) return;
    setActiveId(target.id);
    navigate(`/c/${target.id}`);
  };

  // 重命名当前会话:打开自定义 Dialog(替代 WebView2 原生 prompt —— 其标题栏硬编码
  // "localhost:8080 显示",无法定制、样式与应用割裂)。Dialog 内部处理输入校验与确认。
  const [renameOpen, setRenameOpen] = React.useState(false);
  const renameActiveConversation = () => {
    if (!activeId) return;
    if (!conversations.some((c) => c.id === activeId)) return;
    setRenameOpen(true);
  };

  // 快捷键事件接入:ref 每次 render 更新最新闭包,useEffect 只挂一次监听,避免重建与陈旧。
  const hotkeyHandlerRef = React.useRef<(action: HotkeyBusAction) => void>(() => {});
  hotkeyHandlerRef.current = (action: HotkeyBusAction) => {
    switch (action) {
      case "newConversation":
        handleCreateConversation();
        break;
      case "prevConversation":
        switchConversation(-1);
        break;
      case "nextConversation":
        switchConversation(1);
        break;
      case "renameConversation":
        renameActiveConversation();
        break;
      case "searchConversations":
        break;
      case "toggleFilesPanel":
        toggleFilesPanel();
        break;
    }
  };

  React.useEffect(() => {
    const actions: HotkeyBusAction[] = [
      "newConversation",
      "prevConversation",
      "nextConversation",
      "renameConversation",
      "toggleFilesPanel",
    ];
    const offs = actions.map((action) =>
      onHotkeyAction(action, () => hotkeyHandlerRef.current(action)),
    );
    return () => offs.forEach((off) => off());
  }, []);

  const hasWorkbenchPanel = Boolean(panel);
  // 关闭动画期间保留卡片内容:左栏收起是整卡滑出,右栏若立刻卸载内容、只剩空白在收缩,
  // 观感就不是镜像了。panel 为空的这 220ms 继续渲染上一次的面板,过渡结束再卸。
  const [retainedPanel, setRetainedPanel] = React.useState(panel);
  React.useEffect(() => {
    if (panel) {
      setRetainedPanel(panel);
      return;
    }
    const timer = window.setTimeout(() => setRetainedPanel(null), 220);
    return () => window.clearTimeout(timer);
  }, [panel]);
  const displayedPanel = panel ?? retainedPanel;
  // 顶行工作台开关的上下文:有会话时面板只带 conversationId(内部按焦点会话解析工作区);
  // 工作区容器的空态没有会话,退化为只读工作区树(与输入框里的文件按钮同语义)。
  const workbenchWorkspaceId =
    activeContainer === CHAT_CONTAINER
      ? (activeConversation?.workspaceId ?? detailWorkspaceId ?? undefined)
      : activeContainer;
  const workbenchWorkspace = workbenchWorkspaceId
    ? workspaces.find((item) => item.id === workbenchWorkspaceId)
    : undefined;
  const workbenchPanelContext = {
    conversationId: activeId,
    workspaceId: activeId ? undefined : workbenchWorkspaceId,
    workspaceName: workbenchWorkspace?.name,
  };
  // Ctrl+Shift+E 与顶部开关同一语义:面板开着(任意类型)先关,否则按焦点会话→工作区→
  // 空态打开文件面板。函数声明提升,快捷键分派处(上方)可以安全引用。
  function toggleFilesPanel() {
    if (panel) {
      closePanel();
      return;
    }
    openPanel({
      type: "conversation-files",
      title: workbenchWorkspace?.name ?? tCommon("workbench.files.title"),
      payload: workbenchPanelContext,
    });
  }
  // 一级分栏的组面板组:新组成立即与它组等宽(用户抱怨"拆完两栏不对称")。
  const outerGroupRef = React.useRef<GroupImperativeHandle | null>(null);

  // 一级分栏对称初值(用户反馈:拖出一级分栏后两栏不是默认对称摆放):
  // v4 的动态面板仅保证 minSize 合规,新组会按比例摊薄既有宽度(如 95/5 拆成 90/5/5)。
  // 只在"组数变多"且用户没拖过分隔条(layout 仍全员等宽)时重铺等宽;用户已拖过的
  // 布局原样尊重。effect 里的 setLayout 已保证此刻所有面板都注册完毕。
  const groupsCountRef = React.useRef(groups.length);
  React.useEffect(() => {
    if (isMobile) return;
    const grew = groups.length > groupsCountRef.current;
    groupsCountRef.current = groups.length;
    if (!grew || groups.length < 2) return;
    const group = outerGroupRef.current;
    if (!group) return;
    const layout = group.getLayout();
    const ids = groups.map((_, gi) => `group-panel-${gi}`);
    const sizes = ids.map((id) => layout[id] ?? NaN);
    const alreadyEqual = sizes.every(
      (size) => Number.isFinite(size) && Math.abs(size - sizes[0]!) < 0.5,
    );
    // 面板可能尚未注册(组数刚变的第一帧):缺哪块就跳过,等下一次布局变化再说,
    // 绝不写半截布局(见下"5% 裂条"风险)。
    if (!sizes.every((size) => Number.isFinite(size))) return;
    if (!alreadyEqual) return;
    const share = 100 / ids.length;
    group.setLayout(Object.fromEntries(ids.map((id) => [id, share])));
  }, [groups, isMobile]);

  // 全局拖放附件落进聚焦窗格的草稿(草稿键推导与窗格内 useDraftInputController 一致)。
  const focusedDraftKey = activeId ?? (isHomeRoute ? homeDraftId : null);
  const focusedDetailLoading = useConversationStore((state) => {
    if (!activeId) return false;
    const entry = state.entries[activeId];
    return (entry?.subscribing ?? false) && (entry?.detail ?? null) === null;
  });
  const focusedDetailError = useConversationStore((state) =>
    activeId ? (state.entries[activeId]?.error ?? null) : null,
  );

  // 路由会话属于哪一列(若它已在某列开着)。点非聚焦列的标签时,路由先变、下一拍才由
  // 同步效应把焦点挪过去;这一帧里旧聚焦列若无条件采用 activeId,就会闪一下别人的会话。
  // 反之,会话尚未落到任何列时(侧栏点击/新建)聚焦列必须立刻采用 activeId,否则每次
  // 切会话都慢一帧。二者的分界正是"是否已被别的列占着"。
  const routeColumnOwner = React.useMemo(() => {
    if (!activeId) return null;
    return columns.find((column) => column.pane.tabs.includes(activeId)) ?? null;
  }, [activeId, columns]);

  const renderColumn = (column: PaneColumn) => {
    const focused = column.container === activeContainer && column.paneIndex === focusedPaneIndex;
    const routeOwned =
      routeColumnOwner === null ||
      (routeColumnOwner.container === column.container &&
        routeColumnOwner.paneIndex === column.paneIndex);
    const paneConversationId = focused && routeOwned ? activeId : column.pane.active;
    return (
      <ConversationFilesLauncherProvider conversationId={paneConversationId}>
        <ConversationPaneView
          container={column.container}
          paneIndex={column.paneIndex}
          focused={focused}
          conversationId={paneConversationId}
          isHomeRoute={isHomeRoute}
          homeDraftId={homeDraftId}
          setHomeDraftId={setHomeDraftId}
          setActiveId={setActiveId}
          navigate={navigate}
          refreshList={refreshList}
          settings={settings}
          conversations={conversations}
          activeWorkspace={workspaceOf(column.container)}
          currentAssistantId={currentAssistantId}
          currentAssistant={currentAssistant}
          onRenameConversation={handleUpdateConversationTitle}
          onFocusPane={handleFocusPane}
        />
      </ConversationFilesLauncherProvider>
    );
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      {/* 顶带(用户产品决策):Logo 品牌行 + 窗口控制钮直接坐在画布上,不属于任何卡片;
          侧栏卡片自其下方(头像行)起。整带即窗口拖拽区,双击最大化行为不变。
          data-app-titlebar:窗口 chrome 的标记——设置模态遮罩从带下缘起算,模态打开时
          这条带豁免 body 级 pointer-events 锁(app.css),始终可拖可点。 */}
      <div
        data-app-titlebar=""
        {...windowDragRegionProps()}
        className="flex h-[var(--app-band-h)] shrink-0 select-none items-start"
      >
        {/* 三页同源坐标:品牌行左 16px/距顶 4px(= 设置/图像页的 px-4 pt-1),窗控
            mt-1.5/mr-2 与两页逐字相同(距顶 6px/右 8px)——顶带只是换了宿主,Logo 与
            [– □ ✕] 的位置高度不变。 */}
        <SidebarBrandRow className="ml-4 mt-1" />
        <WindowControlsBar className="ml-auto mt-1.5 mr-2" />
      </div>
      <SidebarProvider defaultOpen className="relative min-h-0 flex-1 overflow-hidden">
        <GlobalDropZone
          draftKey={focusedDraftKey}
          disabled={focusedDetailLoading || Boolean(focusedDetailError)}
        />
        <RenameConversationDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          currentTitle={conversations.find((c) => c.id === activeId)?.title ?? ""}
          onConfirm={(nextTitle) => {
            if (!activeId) return;
            void handleUpdateConversationTitle(activeId, nextTitle);
          }}
        />
        <ConversationSidebar
          conversations={containerConversations}
          activeId={activeId}
          loading={loading}
          error={error}
          hasMore={hasMore}
          loadMore={loadMore}
          userName={
            settings?.displaySetting.userNickname?.trim() || t("conversations.user.default_name")
          }
          userAvatar={settings?.displaySetting.userAvatar}
          assistants={assistants}
          assistantTags={settings?.assistantTags ?? []}
          currentAssistantId={currentAssistantId}
          onSelect={handleSelect}
          onAssistantChange={handleAssistantChange}
          onPin={handleTogglePinConversation}
          onRegenerateTitle={handleRegenerateConversationTitle}
          onMoveToAssistant={handleMoveConversation}
          onUpdateTitle={handleUpdateConversationTitle}
          onDelete={handleDeleteConversation}
          onDeleteMany={handleDeleteConversations}
          onCreateConversation={handleCreateConversation}
          webAuthEnabled={settings?.webServerJwtEnabled === true}
        />
        <SidebarInset className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent pr-2 pb-2 pl-2">
          {/* 窗控与品牌行已上移到画布顶带;此处只余主卡。 */}
          {/* 内容列 = on-surface 着色 wrapper(撞色带):一级标签行浮在带顶,
              下方白面板盖住其余部分,于是"带"只在标签行处露出;四周 SidebarInset 的
              pt/pr/pb/pl 留出画布边距(左侧即侧栏与面板之间的 gap)。
              L 轮分区模型:分栏时每组是一块同款"撞色带 + 白面板"的独立单元(自己的一级
              标签栏只列本组成员 + 自己的内容列),与二级分栏"每列一条会话标签栏"同构;
              组间由画布色缝隙分隔 —— "两个组"是比"同组两列"更重的边界。 */}
          {/* 分栏组与工作台浮卡并排:工作台是组外的 flex 兄弟,宽度由自己的状态驱动,
              不参与 v4 布局,开关与拖宽都不会和分栏互相改写。 */}
          <div className="flex min-h-0 flex-1">
            {groups.length === 1 || isMobile ? (
              <ResizablePanelGroup
                orientation="horizontal"
                className="relative isolate flex min-h-0 min-w-0 flex-1"
              >
                <ResizablePanel id="group-panel-0" minSize="18%" className="flex min-h-0 flex-col">
                  <div className="relative isolate flex min-h-0 flex-1 flex-col rounded-[18px] bg-[var(--ds-on-surface)] pt-[2px]">
                    {/* 一级容器标签行:窗控/拖拽由上方 WindowControlsBar 负责,本行纯交互。
                  z-[3] 压过白面板的 elevation-100 外环阴影:否则那道
                  0.5px 暗环会横穿焦点标签与面板的连接处,连体处凭空多出一条缝。 */}
                    <div className="relative z-[3] flex h-[31px] shrink-0 items-end gap-1 px-1">
                      <CollapsedSidebarTrigger />
                      <div className="relative flex h-full min-w-0 flex-1 items-end">
                        <ContainerTabBar
                          group={groups[0] ?? [CHAT_CONTAINER]}
                          groupIndex={0}
                          ghostTabs={ghostTabs}
                          headerTrailing={<ContainerPlusMenu />}
                        />
                      </div>
                      {/* 面板开着时由卡片头部（与左栏折叠钮镜像的 PanelRight）关闭，
                    和左栏“展开后收起钮移入卡内”同构，不在标签行重复一个图标。 */}
                      {!isMobile && !panel ? <WorkbenchToggle {...workbenchPanelContext} /> : null}
                    </div>
                    {/* 白色圆角内容面板:surface-200 底 + elevation-100,盖住撞色带主体,
                  焦点页签经连接条与面板连体;底部圆角与 wrapper 的 18px 对齐。
                  分栏:面板内是 1..MAX_PANES 个会话列(同容器的二级窗格);工作台卡片
                  在组外与组并列,是左栏的镜像浮卡(见 WorkbenchSide)。 */}
                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[16px] rounded-b-[18px] bg-[var(--ds-surface-200)] shadow-[var(--ds-elevation-100)]">
                      {!isMobile ? (
                        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
                          {columns.map((column, index) => (
                            <React.Fragment key={`${column.container}:${column.paneIndex}`}>
                              {index > 0 ? <ResizableHandle /> : null}
                              <ResizablePanel
                                id={`conversation-column-${column.container}-${column.paneIndex}`}
                                minSize="18%"
                                className="flex min-h-0 flex-col"
                              >
                                {renderColumn(column)}
                              </ResizablePanel>
                            </React.Fragment>
                          ))}
                        </ResizablePanelGroup>
                      ) : (
                        // 窄屏不分栏:只渲染焦点列(其它列的状态保留,回宽屏即恢复)。
                        renderColumn(
                          columns.find(
                            (column) =>
                              column.container === activeContainer &&
                              column.paneIndex === focusedPaneIndex,
                          ) ?? columns[0]!,
                        )
                      )}

                      {isMobile && panel ? (
                        <Drawer
                          open={hasWorkbenchPanel}
                          onOpenChange={(open) => {
                            if (!open) {
                              closePanel();
                            }
                          }}
                          direction="bottom"
                        >
                          <DrawerContent className="h-[85vh] max-h-[85vh]">
                            <WorkbenchHost
                              panel={panel}
                              onClose={closePanel}
                              activeConversationId={activeId}
                            />
                          </DrawerContent>
                        </Drawer>
                      ) : null}
                    </div>
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              // L 轮分区模型分栏:每组 = 撞色带 wrapper(自己的一级标签栏,渲染本组全部
              // 标签)+ 白面板(该组焦点容器的二级列)。右侧工作台在组外,对所有组一视同仁。
              <ResizablePanelGroup
                orientation="horizontal"
                className="relative isolate flex min-h-0 min-w-0 flex-1"
                groupRef={outerGroupRef}
              >
                {groups.map((group, groupIndex) => {
                  const focus = group.includes(activeContainer) ? activeContainer : group[0]!;
                  const groupColumns = columns.filter((column) => column.container === focus);
                  return (
                    // 面板 id 按下标而非焦点容器命名:焦点容器随用户点击切换,若 id 跟着换,
                    // v4 视作新面板注册,宽度记忆全丢。
                    <React.Fragment key={groupIndex}>
                      {groupIndex > 0 ? (
                        <ResizableHandle className="w-1.5 bg-transparent after:w-1.5" />
                      ) : null}
                      <ResizablePanel
                        id={`group-panel-${groupIndex}`}
                        minSize="18%"
                        className="flex min-h-0 flex-col"
                      >
                        <div className="relative isolate flex min-h-0 flex-1 flex-col rounded-[18px] bg-[var(--ds-on-surface)] pt-[2px]">
                          {/* z-[3] 同单组分支:压过面板阴影外环,连体处不出缝(见上方注释) */}
                          <div className="relative z-[3] flex h-[31px] shrink-0 items-end gap-1 px-1">
                            <div className="relative flex h-full min-w-0 flex-1 items-end">
                              <ContainerTabBar
                                group={group}
                                groupIndex={groupIndex}
                                ghostTabs={group.includes(activeContainer) ? ghostTabs : []}
                                headerTrailing={
                                  group.includes(activeContainer) ? <ContainerPlusMenu /> : null
                                }
                              />
                            </div>
                            {/* 同单组分支:面板开着时关闭入口在卡片头部,不在标签行重复。 */}
                            {groupIndex === groups.length - 1 && !panel ? (
                              <WorkbenchToggle {...workbenchPanelContext} />
                            ) : null}
                          </div>
                          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-[16px] rounded-b-[18px] bg-[var(--ds-surface-200)] shadow-[var(--ds-elevation-100)]">
                            <ResizablePanelGroup
                              orientation="horizontal"
                              className="min-h-0 flex-1"
                            >
                              {groupColumns.map((column, index) => (
                                <React.Fragment key={`${column.container}:${column.paneIndex}`}>
                                  {index > 0 ? <ResizableHandle /> : null}
                                  <ResizablePanel
                                    id={`conversation-column-${column.container}-${column.paneIndex}`}
                                    minSize="18%"
                                    className="flex min-h-0 flex-col"
                                  >
                                    {renderColumn(column)}
                                  </ResizablePanel>
                                </React.Fragment>
                              ))}
                            </ResizablePanelGroup>
                          </div>
                        </div>
                      </ResizablePanel>
                    </React.Fragment>
                  );
                })}
              </ResizablePanelGroup>
            )}
            {!isMobile ? (
              <WorkbenchSide
                open={Boolean(panel)}
                onClose={closePanel}
                panel={displayedPanel}
                activeConversationId={activeId}
              />
            ) : null}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
