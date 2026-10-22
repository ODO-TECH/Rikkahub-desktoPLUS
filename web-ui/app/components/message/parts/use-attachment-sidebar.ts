import * as React from "react";

import { fileIdFromUrl } from "~/components/workbench/conversation-files-types";
import { useOpenConversationFile } from "~/components/workbench/conversation-files-launcher";

/** 消息附件(chip/图片/视频/音频)的侧边栏深链目标。URL 不是库内文件
 *  (/api/files/:id/content)或不在会话列内时 canOpen=false,调用方保留原行为。 */
export function useAttachmentSidebarTarget(url: string) {
  const openInSidebar = useOpenConversationFile();
  const fileId = fileIdFromUrl(url);
  const canOpen = openInSidebar !== null && fileId !== null;
  const open = React.useCallback(() => {
    if (openInSidebar && fileId !== null) openInSidebar({ fileId });
  }, [fileId, openInSidebar]);
  return { canOpen, open };
}
