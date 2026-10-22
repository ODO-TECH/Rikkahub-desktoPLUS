import * as React from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, X } from "lucide-react";

import { cn } from "~/lib/utils";

export interface FileTabItem {
  key: string;
  title: string;
  /** 有未保存修改(tab 上显示实心点)。 */
  dirty: boolean;
}

interface FileTabsProps {
  tabs: FileTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** 回到来源列表(activeKey=null)。 */
  onBack: () => void;
}

/** 已打开文件标签条 + 返回来源列表入口(0.0.3 侧边栏)。 */
export function FileTabs({ tabs, activeKey, onSelect, onClose, onBack }: FileTabsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-8 items-stretch border-b bg-muted/20">
      <button
        type="button"
        onClick={onBack}
        aria-label={t("workbench.files.back_to_list")}
        title={t("workbench.files.back_to_list")}
        className={cn(
          "flex w-8 shrink-0 items-center justify-center border-r text-muted-foreground hover:bg-accent hover:text-foreground",
          activeKey === null && "bg-accent text-foreground",
        )}
      >
        <ArrowLeft className="size-3.5" />
      </button>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              className={cn(
                "group flex min-w-0 max-w-44 shrink-0 items-center border-r text-xs",
                active ? "bg-background text-foreground" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-left"
                title={tab.key}
              >
                <span className="min-w-0 truncate">{tab.title}</span>
                {tab.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--ds-brand-primary)]" /> : null}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.key);
                }}
                aria-label={t("workbench.files.close_tab")}
                className="mr-1 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
