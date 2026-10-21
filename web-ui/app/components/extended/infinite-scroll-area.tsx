import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "~/lib/utils";

export interface InfiniteScrollAreaProps extends Omit<React.ComponentProps<"div">, "id"> {
  /** 当前已加载条数(数据变化后触发一次贴底重估) */
  dataLength: number;
  /** 加载下一页。必须可安全重复调用(在途去重由数据层负责) */
  next: () => void;
  /** 是否还有更多数据 */
  hasMore: boolean;
  /** hasMore 时显示在列表底部的元素 */
  loader?: React.ReactNode;
  /** 滚动容器的稳定 id(供外部 getElementById 定位,如回到顶部) */
  scrollTargetId?: string;
}

/** 距容器底部多少像素内触发预取 */
const LOAD_THRESHOLD_PX = 200;

// 1.5.0 内测 bug2(旧会话从列表消失、搜索可见、F5 偶尔恢复)的根修:弃用
// react-infinite-scroll-component(2021 年起停更)。该库调用 next() 后置内部闩锁
// actionTriggered=true,且仅在 dataLength 变化时复位 —— 任何一次"next() 被调但列表
// 长度没变"(响应被并发刷新丢弃、请求瞬时失败、整页均为重复项)都会永久锁死后续
// 加载,直到组件重挂(F5)。本实现无闩锁:每次滚动/数据变化都重估"是否近底部",
// 触发去重交给数据层的在途守卫,故任何一次失败或丢弃都能被下一次滚动自然重试。
function InfiniteScrollArea({
  className,
  children,
  dataLength,
  next,
  hasMore,
  loader,
  scrollTargetId = "infinite-scroll-target",
  onScroll,
  ...props
}: InfiniteScrollAreaProps) {
  const { t } = useTranslation();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const maybeLoad = React.useCallback(() => {
    const el = containerRef.current;
    if (!el || !hasMore) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom <= LOAD_THRESHOLD_PX) {
      next();
    }
  }, [hasMore, next]);

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll?.(event);
      maybeLoad();
    },
    [maybeLoad, onScroll],
  );

  // 滚动事件只覆盖"用户滚到近底部";这里补齐另外两类时机:
  // ① 内容不满一屏(无滚动条,滚动事件永不发生)——挂载/翻页后持续拉到填满为止;
  // ② 翻页返回后仍停在近底部 —— 无需再滚一下即可续拉。
  // rAF 等 DOM 提交后再量高度。
  React.useEffect(() => {
    if (!hasMore) return;
    const rafId = requestAnimationFrame(maybeLoad);
    return () => cancelAnimationFrame(rafId);
  }, [dataLength, hasMore, maybeLoad]);

  return (
    <div
      ref={containerRef}
      data-slot="infinite-scroll-area"
      id={scrollTargetId}
      onScroll={handleScroll}
      className={cn("styled-scrollbar min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    >
      {children}
      {hasMore &&
        (loader ?? (
          <div className="px-2 py-2 text-center text-xs text-muted-foreground">
            {t("infinite_scroll.load_more")}
          </div>
        ))}
    </div>
  );
}

export { InfiniteScrollArea };
