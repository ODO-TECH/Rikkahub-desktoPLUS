// components/sidebar-brand.tsx — 侧边栏品牌行(问题7回访:设计延续)。
// 主界面/设置页/图像生成页三处同源:Logo + "RikkaHub" 字样,行内即窗口拖拽区
// (双击最大化,行为与窗控条一致)。品牌形态改动只动这里,三页同步生效。

import { cn } from "~/lib/utils";
import { windowDragRegionProps } from "~/components/window-controls";

export function SidebarBrandRow({ className }: { className?: string }) {
  // data-titlebar-chrome:顶带 chrome 标记。data-titlebar-brand:品牌行专属标记——
  // 设置模态打开时品牌行不隐去,留在原地被模态毛玻璃遮罩盖住(模糊可见,用户要求),
  // 关模态无需重现;窗控条 [-口×] 则由 app.css 的隐藏规则交给替身清晰副本。
  return (
    <div
      data-titlebar-chrome=""
      data-titlebar-brand=""
      className={cn("flex h-7 items-center", className)}
      {...windowDragRegionProps()}
    >
      <div className="flex min-w-0 items-center gap-2">
        <img src="/app-icon.png" alt="" aria-hidden className="size-5 shrink-0" />
        <span className="truncate text-sm font-semibold text-[var(--ds-text-primary)]">RikkaHub</span>
      </div>
    </div>
  );
}
