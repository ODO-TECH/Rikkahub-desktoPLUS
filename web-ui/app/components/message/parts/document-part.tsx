import * as React from "react";
import { BookOpen, File, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { resolveFileUrl } from "~/lib/files";

import { useAttachmentSidebarTarget } from "./use-attachment-sidebar";

interface DocumentPartProps {
  url: string;
  fileName: string;
  mime: string;
}

function getDocumentIcon(mime: string) {
  if (mime === "application/epub+zip") {
    return <BookOpen className="h-4 w-4" />;
  }
  if (mime === "application/pdf") {
    return <FileText className="h-4 w-4" />;
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return <FileText className="h-4 w-4" />;
  }
  return <File className="h-4 w-4" />;
}

export function DocumentPart({ url, fileName, mime }: DocumentPartProps) {
  const { t } = useTranslation("message");
  const sidebar = useAttachmentSidebarTarget(url);
  if (!url) return null;

  const documentUrl = resolveFileUrl(url);

  return (
    <a
      className="my-2 inline-flex max-w-full items-center gap-2 rounded-full border border-muted bg-card px-3 py-1.5 text-sm hover:bg-muted/40"
      href={documentUrl}
      rel="noreferrer"
      target="_blank"
      title={sidebar.canOpen ? t("media_part.open_in_sidebar") : undefined}
      onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
        // 单击 = 在侧栏打开;Ctrl/Cmd/Shift/Alt + 单击、中键、键盘 Enter 仍走浏览器新标签。
        if (!sidebar.canOpen || event.detail === 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        sidebar.open();
      }}
    >
      {getDocumentIcon(mime)}
      <span className="max-w-[320px] truncate">{fileName}</span>
    </a>
  );
}
