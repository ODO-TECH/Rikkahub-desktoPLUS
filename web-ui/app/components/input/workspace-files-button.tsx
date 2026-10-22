import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderTree } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useOptionalWorkbench } from "~/components/workbench/workbench-context";
import { usePaneContainer } from "~/components/workspace/pane-container-context";
import { cn } from "~/lib/utils";
import { CHAT_CONTAINER } from "~/stores/container-tabs-store";
import { useConversationStore } from "~/stores/conversation-store";
import { useWorkspaceStore } from "~/stores/workspace-store";

/** 文件侧边栏入口(0.0.3 Feature A):普通对话里显示会话文件面板(改动/工作区/附件/产出
 *  + 预览编辑);工作区容器里没有会话时退化为只读工作区树。 */
export function WorkspaceFilesButton({
  className,
  conversationId,
}: {
  className?: string;
  conversationId?: string | null;
}) {
  const { t } = useTranslation();
  const workbench = useOptionalWorkbench();
  const container = usePaneContainer();
  // 普通对话:工作区归属在会话详情里(标题/图标用);工作区容器:容器 id 即工作区 id。
  const conversationWorkspaceId = useConversationStore((state) =>
    container === CHAT_CONTAINER && conversationId
      ? state.entries[conversationId]?.detail?.workspaceId ?? null
      : null,
  );
  const workspaceId = container === CHAT_CONTAINER ? conversationWorkspaceId : container;
  const workspace = useWorkspaceStore((state) =>
    workspaceId ? state.workspaces.find((item) => item.id === workspaceId) : undefined,
  );

  if (!workbench || (!conversationId && !workspace)) return null;

  // 会话面板只带 conversationId:面板每次渲染按“当前焦点会话”解析工作区,
  // 换会话/换工作区后不会沿用旧工作区的树。
  const isOpen = workbench.panel?.type === "conversation-files"
    && (conversationId
      ? workbench.panel.payload.conversationId === conversationId
      : !workbench.panel.payload.conversationId && workbench.panel.payload.workspaceId === workspace?.id);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-8 gap-1 rounded-full px-2.5 text-muted-foreground hover:text-foreground",
        isOpen && "text-foreground",
        className,
      )}
      title={workspace?.name ?? t("workbench.files.title")}
      aria-pressed={isOpen}
      onClick={() => {
        if (isOpen) {
          workbench.closePanel();
          return;
        }
        workbench.openPanel({
          type: "conversation-files",
          title: workspace?.name ?? t("workbench.files.title"),
          payload: conversationId
            ? { conversationId }
            : { workspaceId: workspace?.id },
        });
      }}
    >
      <FolderTree className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
