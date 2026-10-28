import * as React from "react";

import { ExternalLink, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";
import type { UIMessageAnnotation, UrlCitationAnnotation } from "~/types";

function getCitationLabel(annotation: UrlCitationAnnotation): string {
  if (annotation.title.trim().length > 0) {
    return annotation.title;
  }

  try {
    const hostname = new URL(annotation.url).hostname.replace(/^www\./, "");
    if (hostname.length > 0) {
      return hostname;
    }
  } catch {
    return annotation.url;
  }

  return annotation.url;
}

export function ChatMessageAnnotationsRow({
  annotations,
  alignRight,
}: {
  annotations?: UIMessageAnnotation[];
  alignRight: boolean;
}) {
  const { t } = useTranslation("message");
  const citations = React.useMemo(
    () =>
      (annotations ?? []).filter(
        (annotation): annotation is UrlCitationAnnotation => annotation.type === "url_citation",
      ),
    [annotations],
  );
  // 阶段四:钉住标记是持久状态而不是"本帧附加信息",所以始终可见(与引用胶囊同排),
  // 让用户一眼能分辨"这条在压缩时会原样保留"。
  const pinned = (annotations ?? []).some((annotation) => annotation.type === "pinned");

  if (citations.length === 0 && !pinned) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center gap-2 px-1",
        alignRight ? "justify-end" : "justify-start",
      )}
    >
      {pinned ? (
        <span
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary"
          title={t("chat_message.pin_hint")}
        >
          <Pin className="size-3" />
          {t("chat_message.pinned")}
        </span>
      ) : null}
      {citations.map((annotation, index) => {
        const label = getCitationLabel(annotation);

        return (
          <a
            key={`${annotation.url}-${index}`}
            href={annotation.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            title={annotation.url || label}
          >
            <span className="max-w-[220px] truncate">{label}</span>
            <ExternalLink className="size-3" />
          </a>
        );
      })}
    </div>
  );
}
