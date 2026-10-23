import * as React from "react";

import { ArrowLeft, PanelLeftClose, PanelLeftOpen, SlidersHorizontal } from "lucide-react";
import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";

import { MediaStudio } from "~/components/media-studio/media-studio";
import { SettingsLink } from "~/components/settings/settings-link";
import { SidebarBrandRow } from "~/components/sidebar-brand";
import { Button } from "~/components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
} from "~/components/ui/sidebar";
import { UIAvatar } from "~/components/ui/ui-avatar";
import { WindowControlsBar, windowDragRegionProps } from "~/components/window-controls";
import { useIsDesktop } from "~/hooks/use-mobile";
import i18n from "~/i18n";
import { cn } from "~/lib/utils";
import { useSettingsStore } from "~/stores/app-store";
import type { MediaKind } from "~/types";

export function meta() {
  return [{ title: `${i18n.t("common:media_studio.title")} - RikkaHub` }];
}

interface ImagesPageState {
  prompt?: unknown;
  autoOptimize?: unknown;
  kind?: unknown;
}

// 侧栏固定宽度、不可拖宽:图像页随时要回对话,侧栏只占一条窄边(与图三定稿一致)。
// 尺寸对齐对话工作区左栏:卡面 16rem、左右各 8px 画布留白(阴影不被裁),总占位 17rem。
// 开合纯靠 React 状态驱动 CSS 过渡,没有命令式布局,状态与 DOM 不会脱钩。
const SIDEBAR_LAYOUT_KEY = "images-sidebar-layout";

function readSidebarOpen(): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_LAYOUT_KEY) ?? "");
    if (typeof parsed?.open === "boolean") return parsed.open;
  } catch {
    // 解析失败走默认。
  }
  return true;
}

function saveSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify({ open }));
  } catch {
    // 存不进(隐私模式等)就只保留内存态。
  }
}

export default function ImagesPage() {
  const { t } = useTranslation();
  const { t: tPage } = useTranslation("page");
  const location = useLocation();
  const state = (location.state ?? {}) as ImagesPageState;
  const initialPrompt = typeof state.prompt === "string" ? state.prompt : "";
  const autoOptimize = state.autoOptimize === true;
  const initialKind: MediaKind = state.kind === "video" ? "video" : "image";
  const isDesktop = useIsDesktop();
  const settings = useSettingsStore((store) => store.settings);
  const userName =
    settings?.displaySetting.userNickname?.trim() || tPage("conversations.user.default_name");

  const [sidebarOpen, setSidebarOpen] = React.useState(readSidebarOpen);

  const toggleSidebar = React.useCallback((open: boolean) => {
    setSidebarOpen(open);
    saveSidebarOpen(open);
  }, []);

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      {isDesktop ? (
        // 顶带与对话工作区同源:品牌行坐在画布上,窗控贴右;侧栏浮卡自其下缘起。
        <div
          data-app-titlebar=""
          {...windowDragRegionProps()}
          className="flex h-[var(--app-band-h)] shrink-0 select-none items-start"
        >
          <SidebarBrandRow className="ml-4 mt-1" />
          {/* 收起后的展开入口。放在常驻顶带里,出现/消失不会推动下方内容(工作区收起时
              的触发器也固定在标签行内)。 */}
          {!sidebarOpen ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-2 mt-0.5 text-muted-foreground hover:text-foreground"
              aria-label={t("image_page.expand_sidebar")}
              title={t("image_page.expand_sidebar")}
              onClick={() => toggleSidebar(true)}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          ) : null}
          <WindowControlsBar className="ml-auto mt-1.5 mr-2" />
        </div>
      ) : null}

      {isDesktop ? (
        <div className="flex min-h-0 flex-1">
          {/* 固定宽侧栏:外层只管裁切与宽度过渡,内层定宽——收起时文字不重排,
              与对话工作区左栏「定宽卡片平移」同一观感。无命令式布局,状态即真相。 */}
          <div
            className={cn(
              "relative h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear",
              sidebarOpen ? "w-[17rem]" : "w-0",
            )}
          >
            <div className="flex h-full min-h-0 w-[17rem] pb-2 pl-2 pr-2">
              <aside
                data-sidebar-surface=""
                // 与对话工作区左栏同款卡面:18px 圆角、sidebar 底色 + elevation 阴影,
                // 左/下留画布边距;内部沿用 SidebarHeader/Group 的排版节奏。
                className={cn(
                  "flex h-full min-h-0 w-[16rem] shrink-0 flex-col overflow-hidden rounded-[18px]",
                  "bg-sidebar text-sidebar-foreground shadow-[var(--ds-elevation-100)]",
                  "transition-transform duration-200 ease-linear",
                  !sidebarOpen && "-translate-x-[17rem]",
                )}
              >
                <SidebarHeader className="p-2 pt-3">
                  {/* 用户资料行:与工作区一致(头像 + 昵称 + 欢迎回来);此处是纯展示,
                      资料编辑仍在设置页,不给假入口。 */}
                  <div className="flex items-center gap-1">
                    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2.5">
                      <UIAvatar
                        size="default"
                        name={userName}
                        avatar={settings?.displaySetting.userAvatar}
                        className="ring-1 ring-sidebar-border/70"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium leading-none">{userName}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {t("conversation_sidebar.welcome_back")}
                        </div>
                      </div>
                    </div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="mr-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={t("image_page.collapse_sidebar")}
                      title={t("image_page.collapse_sidebar")}
                      onClick={() => toggleSidebar(false)}
                    >
                      <PanelLeftClose className="size-4" />
                    </Button>
                  </div>
                </SidebarHeader>
                <SidebarContent className="min-h-0">
                  {/* 操作组复用工作区的「分组面板」配方:radius-md 卡面 + 6px 内边距。 */}
                  <SidebarGroup>
                    <div className="space-y-1 rounded-[var(--ds-radius-md)] bg-[var(--sidebar-module-card-bg)] p-1.5">
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-9 w-full justify-start gap-3 rounded-[var(--ds-radius-sm)] px-2 font-medium text-[13px] text-[var(--ds-text-primary)]"
                      >
                        <Link to="/">
                          <ArrowLeft
                            className="size-[18px] text-[var(--ds-icon)]"
                            strokeWidth={1.75}
                          />
                          {t("image_page.back_to_chat")}
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-9 w-full justify-start gap-3 rounded-[var(--ds-radius-sm)] px-2 font-medium text-[13px] text-[var(--ds-text-primary)]"
                      >
                        <SettingsLink search="?section=media&sub=providers">
                          <SlidersHorizontal
                            className="size-[18px] text-[var(--ds-icon)]"
                            strokeWidth={1.75}
                          />
                          {t("media_studio.manage")}
                        </SettingsLink>
                      </Button>
                    </div>
                  </SidebarGroup>

                  <SidebarGroup>
                    <SidebarGroupLabel>{t("media_studio.title")}</SidebarGroupLabel>
                    <div className="rounded-[var(--ds-radius-md)] bg-[var(--sidebar-module-card-bg)] p-3">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("media_studio.description")}
                      </p>
                    </div>
                  </SidebarGroup>
                </SidebarContent>
              </aside>
            </div>
          </div>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
              <MediaStudio
                initialPrompt={initialPrompt}
                initialKind={initialKind}
                autoOptimize={autoOptimize}
                rewritePicker
              />
            </div>
          </main>
        </div>
      ) : (
        // 窄屏不走分栏:隐藏侧栏,顶部保留返回/服务入口。
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-start justify-end">
            <WindowControlsBar className="mt-1.5 mr-2" data-app-titlebar="" />
          </div>
          <div className="border-b px-4 py-3">
            <div className="flex items-center justify-between">
              <Link className="text-sm text-muted-foreground" to="/">
                {t("image_page.back_to_chat")}
              </Link>
              <SettingsLink
                className="text-sm text-muted-foreground"
                search="?section=media&sub=providers"
              >
                {t("media_studio.manage")}
              </SettingsLink>
            </div>
          </div>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
              <MediaStudio
                initialPrompt={initialPrompt}
                initialKind={initialKind}
                autoOptimize={autoOptimize}
                rewritePicker
              />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
