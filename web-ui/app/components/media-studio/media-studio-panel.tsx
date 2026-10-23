// components/media-studio/media-studio-panel.tsx — 右侧栏里的媒体生成面板。
// payload 只在每次点击输入框按钮时换新（token 变化 → 整体重挂载，导入最新提示词）；
// 换会话不重挂载，插入目标跟随当前焦点会话。

import type { WorkbenchPanel } from "~/components/workbench/workbench-context";
import type { MediaKind } from "~/types";

import { MediaStudio } from "./media-studio";

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

export function MediaStudioPanel({
  panel,
  activeConversationId,
}: {
  panel: WorkbenchPanel;
  activeConversationId: string | null | undefined;
}) {
  const payloadConversationId = readString(panel.payload, "conversationId");
  const conversationId = activeConversationId || payloadConversationId || null;
  const draftKey = conversationId ? null : readString(panel.payload, "draftKey") || null;
  const kind: MediaKind = panel.payload.kind === "video" ? "video" : "image";
  const prompt = readString(panel.payload, "prompt");
  const autoOptimize = panel.payload.autoOptimize === true;
  const token = readString(panel.payload, "token") || "initial";

  return (
    <MediaStudio
      key={token}
      conversationId={conversationId}
      draftKey={draftKey}
      initialPrompt={prompt}
      initialKind={kind}
      autoOptimize={autoOptimize}
      compact
    />
  );
}
