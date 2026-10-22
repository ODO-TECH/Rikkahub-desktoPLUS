import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConversationStore } from "~/stores/conversation-store";
import { useWorkspaceStore } from "~/stores/workspace-store";

import { useOptionalWorkbench } from "./workbench-context";

// 会话文件侧边栏的深链启动器(0.0.3 Feature A3.1)。
// 消息树很深(附件 chip / 工具卡),把 conversationId 一路传下去会穿透大量 memo 组件;
// 改为在会话列外挂一层 Provider,内部用当前焦点会话 + 工作区信息直接 openPanel。
// open 目标只带 fileId(库内媒体)或 path(工具卡原始路径),路径换算由面板读取
// conversationFiles.cwd/workspaceRoot 后完成——与「本次改动」列表同一口径。

export interface ConversationFileOpenTarget {
  /** 库内文件 id(/api/files/:id/content 的媒体附件或产出)。 */
  fileId?: number;
  /** 工具卡拿到的原始路径(相对会话 cwd 或绝对);面板负责换算成工作区相对路径。 */
  path?: string;
}

export type OpenConversationFile = (target: ConversationFileOpenTarget) => void;

const ConversationFilesLauncherContext = React.createContext<OpenConversationFile | null>(null);

export function ConversationFilesLauncherProvider({
  conversationId,
  children,
}: {
  conversationId?: string | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const workbench = useOptionalWorkbench();
  const workspaceId = useConversationStore((state) =>
    conversationId ? (state.entries[conversationId]?.detail?.workspaceId ?? null) : null,
  );
  const workspaceName = useWorkspaceStore((state) =>
    workspaceId ? state.workspaces.find((item) => item.id === workspaceId)?.name : undefined,
  );

  const open = React.useCallback<OpenConversationFile>(
    (target) => {
      if (!workbench || !conversationId) return;
      workbench.openPanel({
        type: "conversation-files",
        title: workspaceName ?? t("workbench.files.title"),
        payload: { conversationId, open: target },
      });
    },
    [conversationId, t, workbench, workspaceName],
  );

  return (
    <ConversationFilesLauncherContext.Provider value={open}>
      {children}
    </ConversationFilesLauncherContext.Provider>
  );
}

/** 当前会话列是否支持“在侧栏打开”;不在会话列内(导出/分享等)返回 null。 */
export function useOpenConversationFile(): OpenConversationFile | null {
  return React.useContext(ConversationFilesLauncherContext);
}
