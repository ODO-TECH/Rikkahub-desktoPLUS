import * as React from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, FileWarning, Loader2, PencilLine, RefreshCw, Save, X } from "lucide-react";

import { buildMermaidPreviewDocument, HighlightedCode } from "~/components/markdown/code-block";
import { languageForPath } from "~/components/markdown/code-language";
import Markdown from "~/components/markdown/markdown";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { appendWebAuthQuery } from "~/services/api";

import { formatSize, workspaceRawFileUrl, type OpenFileView } from "./conversation-files-types";

// 文件查看器/编辑器(0.0.3 Feature A):只读预览(文本/图片/音视频/二进制)、
// Ctrl+S 保存、外部改动冲突横幅。所有 I/O 由面板持有,本组件纯展示 + 回调。

interface FileViewerProps {
  file: OpenFileView;
  workspaceId: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onReveal: () => void;
}

function MediaPreview({ file }: { file: OpenFileView }) {
  const { t } = useTranslation();
  if (file.preview?.kind !== "media") return null;
  const { url, mime } = file.preview;
  if (mime.startsWith("image/")) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        <img src={url} alt={file.title} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <div className="flex h-full items-center justify-center bg-black/90 p-2">
        <video src={url} controls className="max-h-full max-w-full" />
      </div>
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <span className="max-w-full truncate text-sm">{file.title}</span>
        <audio src={url} controls className="w-full" />
      </div>
    );
  }
  // PDF 交给浏览器内置阅读器;下方常驻“在浏览器中打开”作为阅读器不可用时的退路。
  if (mime === "application/pdf" || /\.pdf(?:[?#]|$)/i.test(url)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <iframe src={url} title={file.title} className="min-h-0 w-full flex-1 border-0 bg-muted/20" />
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-micro text-muted-foreground">
          <span className="truncate">{t("workbench.files.pdf_hint")}</span>
          <a className="inline-flex shrink-0 items-center gap-1 hover:underline" href={url} rel="noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            {t("workbench.files.open_external")}
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileWarning className="size-8 text-muted-foreground" />
      <div className="text-muted-foreground text-xs">{t("workbench.files.document_preview_hint")}</div>
      <Button asChild size="sm" variant="outline">
        <a href={url} target="_blank" rel="noreferrer">
          <ExternalLink className="size-3.5" />
          {t("workbench.files.open_external")}
        </a>
      </Button>
    </div>
  );
}

export function FileViewer({
  file,
  workspaceId,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSave,
  onReload,
  onOverwrite,
  onReveal,
}: FileViewerProps) {
  const { t } = useTranslation();
  const editing = file.draft !== null;
  const dirty = editing && file.draft !== file.savedText;
  const size = file.preview?.size ?? null;
  const canEdit = file.kind === "workspace" && file.preview?.kind === "text";
  // Markdown/HTML/SVG/Mermaid 默认渲染预览,可切源码;其他文本按扩展名交给 shiki 高亮。
  const displayName = file.path ?? file.title;
  const isMarkdown = /\.(md|markdown)$/i.test(displayName);
  const isHtml = /\.(html?|svg)$/i.test(displayName);
  const isMermaid = /\.(mmd|mermaid)$/i.test(displayName);
  const isPdf = /\.pdf$/i.test(displayName);
  const [sourceMode, setSourceMode] = React.useState(false);
  React.useEffect(() => {
    setSourceMode(false);
  }, [file.key]);

  // 编辑器行号:单个文本节点 + 与 textarea 同步 scrollTop,几十万行的文件也不会渲染
  // 成等量 DOM 节点。字号/行高/内边距与编辑区一致,数字才能逐行对齐。
  const draftText = file.draft ?? "";
  const lineCount = React.useMemo(() => (draftText.match(/\n/g)?.length ?? 0) + 1, [draftText]);
  const lineNumbers = React.useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );
  const gutterRef = React.useRef<HTMLDivElement | null>(null);

  // 工作区 PDF 走领域层的 files/raw(仅 .pdf 放行),iframe 需要 web-auth query。
  const pdfUrl = workspaceId && file.path && isPdf
    ? appendWebAuthQuery(workspaceRawFileUrl(workspaceId, file.path))
    : null;

  const editBlockedReason = file.edit && !file.edit.editable
    ? file.edit.reason === "too_large"
      ? t("workbench.files.not_editable_too_large", { limit: formatSize(file.edit.limitBytes) })
      : file.edit.reason === "binary"
        ? t("workbench.files.not_editable_binary")
        : t("workbench.files.not_editable_image")
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path ?? file.title}>
          {file.path ?? file.title}
        </span>
        {dirty ? <span className="shrink-0 rounded-sm bg-[var(--ds-brand-primary)]/12 px-1.5 py-0.5 text-micro text-[var(--ds-brand-primary)]">{t("workbench.files.unsaved")}</span> : null}
        {size !== null ? <span className="shrink-0 text-micro text-muted-foreground">{formatSize(size)}</span> : null}
        {file.kind === "workspace" && workspaceId ? (
          <Button type="button" size="icon-sm" variant="ghost" onClick={onReveal} aria-label={t("workbench.files.reveal")} title={t("workbench.files.reveal")}>
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
        {file.kind === "workspace" ? (
          <Button type="button" size="icon-sm" variant="ghost" onClick={onReload} aria-label={t("workbench.files.reload")} title={t("workbench.files.reload")}>
            <RefreshCw className="size-3.5" />
          </Button>
        ) : null}
        {(isMarkdown || isHtml || isMermaid) && !editing && file.preview?.kind === "text" ? (
          <>
            <Button
              type="button"
              size="sm"
              variant={sourceMode ? "ghost" : "secondary"}
              className="h-6 px-2 text-micro"
              onClick={() => setSourceMode(false)}
            >
              {t("workbench.preview")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={sourceMode ? "secondary" : "ghost"}
              className="h-6 px-2 text-micro"
              onClick={() => setSourceMode(true)}
            >
              {t("workbench.source_code")}
            </Button>
          </>
        ) : null}
        {canEdit && !editing ? (
          <Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-2 text-micro" onClick={onStartEdit}>
            <PencilLine className="size-3" />
            {t("workbench.files.edit")}
          </Button>
        ) : null}
      </div>

      {file.conflict ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-2 text-warning text-xs">
          <span className="min-w-0 flex-1">{t("workbench.files.conflict_hint")}</span>
          <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-micro" onClick={onReload}>
            {t("workbench.files.reload")}
          </Button>
          <Button type="button" size="sm" variant="destructive" className="h-6 px-2 text-micro" onClick={onOverwrite}>
            {t("workbench.files.overwrite")}
          </Button>
        </div>
      ) : null}

      {editBlockedReason ? (
        <div className="border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs">{editBlockedReason}</div>
      ) : null}

      {file.error ? (
        <div className="border-b bg-destructive/10 px-3 py-2 text-destructive text-xs">{file.error}</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {file.loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : file.preview === null ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">{t("workbench.files.empty_content")}</div>
        ) : editing ? (
          <div className="flex h-full min-h-0">
            <div
              ref={gutterRef}
              aria-hidden
              className="h-full shrink-0 select-none overflow-hidden border-r bg-muted/20 px-2 py-2 text-right font-mono text-xs leading-5 text-muted-foreground/60"
            >
              <div className="whitespace-pre">{lineNumbers}</div>
            </div>
            <Textarea
              value={file.draft ?? ""}
              onChange={(event) => onDraftChange(event.target.value)}
              onScroll={(event) => {
                if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  onSave();
                  return;
                }
                // Tab 在代码里是缩进而不是切焦点:插入两个空格并保持光标位置。
                // 受控组件重渲染后光标会跳到末尾,下一帧手动放回插入点之后。
                if (event.key === "Tab") {
                  event.preventDefault();
                  const target = event.currentTarget;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  onDraftChange(`${draftText.slice(0, start)}  ${draftText.slice(end)}`);
                  requestAnimationFrame(() => {
                    target.selectionStart = target.selectionEnd = start + 2;
                  });
                }
              }}
              spellCheck={false}
              wrap="off"
              autoFocus
              className="h-full min-h-0 w-full resize-none rounded-none border-0 bg-transparent font-mono text-xs leading-5 focus-visible:ring-0"
            />
          </div>
        ) : file.preview.kind === "media" ? (
          <MediaPreview file={file} />
        ) : file.preview.kind === "image" ? (
          <div className="flex h-full items-center justify-center overflow-auto p-4">
            <img src={file.preview.dataUrl} alt={file.title} className="max-h-full max-w-full object-contain" />
          </div>
        ) : file.preview.kind === "text" ? (
          <div className="h-full overflow-auto">
            {file.preview.truncated ? (
              <div className="border-b bg-warning/10 px-3 py-1.5 text-warning text-xs">
                {t("workbench.files.preview_truncated")}
              </div>
            ) : null}
            {isHtml && !sourceMode ? (
              // sandbox 空值 = 唯一源、禁脚本:HTML/SVG 里即使带 <script>/onload 也拿不到
              // 应用同源权限。相对资源仍可加载,样式/排版预览不受影响。
              <iframe
                title={file.title}
                srcDoc={file.preview.text}
                sandbox=""
                className="h-full min-h-[320px] w-full border-0 bg-white"
              />
            ) : isMermaid && !sourceMode ? (
              // 与对话代码块同一渲染路径:iframe 内从 esm.sh 动态加载 mermaid 渲染,
              // allow-scripts 是 mermaid 运行的最低要求;文档本身无应用同源权限。
              <iframe
                title={file.title}
                srcDoc={buildMermaidPreviewDocument(file.preview.text)}
                sandbox="allow-scripts"
                className="h-full min-h-[320px] w-full border-0 bg-white"
              />
            ) : isMarkdown && !sourceMode ? (
              <div className="p-4 text-sm">
                <Markdown content={file.preview.text} />
              </div>
            ) : isMarkdown || isHtml || isMermaid ? (
              <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5">{file.preview.text}</pre>
            ) : (
              <HighlightedCode
                code={file.preview.text}
                language={languageForPath(file.path ?? file.title)}
                wrapLines
                className="h-full"
                preClassName="!p-3 !text-xs !leading-5"
              />
            )}
          </div>
        ) : file.preview.kind === "binary" && pdfUrl ? (
          <div className="flex h-full min-h-0 flex-col">
            <iframe src={pdfUrl} title={file.title} className="min-h-0 w-full flex-1 border-0 bg-muted/20" />
            <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-micro text-muted-foreground">
              <span className="truncate">{t("workbench.files.pdf_hint")}</span>
              <a className="inline-flex shrink-0 items-center gap-1 hover:underline" href={pdfUrl} rel="noreferrer" target="_blank">
                <ExternalLink className="size-3" />
                {t("workbench.files.open_external")}
              </a>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
            {t("workbench.files.binary_preview", { size: formatSize(file.preview.size) })}
          </div>
        )}
      </div>

      {editing ? (
        <div className="flex items-center gap-2 border-t px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
            {file.edit?.eol === "\r\n" ? t("workbench.files.eol_crlf") : t("workbench.files.eol_lf")}
            {" · "}
            {t("workbench.files.save_hint")}
          </span>
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-micro" onClick={onCancelEdit}>
            <X className="size-3" />
            {t("workbench.files.cancel_edit")}
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn("h-7 gap-1 px-2 text-micro")}
            disabled={file.saving || !dirty}
            onClick={onSave}
          >
            {file.saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            {t("workbench.files.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
