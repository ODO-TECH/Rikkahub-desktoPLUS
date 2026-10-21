"use client";

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

// 专题9:本文件原是 ai-elements 套件(StickToBottom 滚动容器/回底按钮/下载按钮等),
// 但聊天列表实际用 react-virtuoso(followOutput 跟底),那些组件从未被引用,已删,
// 依赖 use-stick-to-bottom 一并移除。仅保留真实使用的空态占位组件。

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);
