import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { extractErrorMessage } from "~/lib/error";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { loadSandboxStatus, type SandboxStatusDto } from "~/lib/sandbox-status";
import { usePaneContainer } from "~/components/workspace/pane-container-context";
import { CHAT_CONTAINER } from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 权限档位下拉(工作区 M2-3):输入框旁,映射到按工具粒度的审批矩阵,
// workspace 级持久化(PATCH workspaces/:id),可随时切换。仅工作区容器内显示。
// 三档语义(与 pc-server/workspace/approval.ts 一致,2026-08-01 改版):
// - confirm_each 询问批准:write/edit/bash 均审批;read 免审
// - balanced 默认权限(新建默认,并记住上次选择):区内写免审,仅危险命令/区外写入审批
// - full_access 完全访问:全部免审,读写不限于区内、无路径黑名单(2026-08-23 起
//   系统目录/pc-data 也可写;恒生效的只剩体积闸门与 Windows 保留设备名阻断)

type Preset = WorkspaceDto["permissionPreset"];

const PRESETS: Array<{ value: Preset; icon: typeof Shield }> = [
  { value: "confirm_each", icon: ShieldAlert },
  { value: "balanced", icon: Shield },
  { value: "full_access", icon: ShieldCheck },
];

export function WorkspacePermissionPicker({ className }: { className?: string }) {
  const { t } = useTranslation("input");
  const container = usePaneContainer();
  const workspace = useWorkspaceStore((state) =>
    container === CHAT_CONTAINER
      ? undefined
      : state.workspaces.find((item) => item.id === container),
  );
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [saving, setSaving] = React.useState(false);
  const [sandbox, setSandbox] = React.useState<SandboxStatusDto | null>(null);

  // 系统沙盒状态按需拉取（展开下拉时）：它是部署级的实情，与工作区档位无关，
  // 但用户在这里问"这个档位到底拦不拦得住"时，答案就在这里。
  const refreshSandbox = React.useCallback(() => {
    void loadSandboxStatus().then((status) => setSandbox(status));
  }, []);

  if (!workspace) return null;

  const current =
    PRESETS.find((preset) => preset.value === workspace.permissionPreset) ?? PRESETS[1]!;
  const CurrentIcon = current.icon;

  const applyPreset = async (preset: Preset) => {
    if (preset === workspace.permissionPreset || saving) return;
    setSaving(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}`, {
        permissionPreset: preset,
      });
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace_permission.save_failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) refreshSandbox();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // 权限模式胶囊:pill-bg 底 + 品牌色文字(skill-pill 类提供 hover 加深)。
          // 窄容器(分栏)下收起文字与箭头,只留盾牌图标——档位靠图形区分(ShieldAlert/
          // Shield/ShieldCheck),信息不丢;文字标签在窄栏里会把工具条挤到元素重叠。
          // 不设 title:盾牌图形 + 文字已自明,悬停注解与文案重复(2026-10-26 用户反馈)。
          className={cn(
            "skill-pill h-8 shrink gap-1.5 whitespace-nowrap rounded-full bg-[var(--ds-pill-bg)] px-2.5 !text-[var(--ds-brand-primary)] @max-2xl/composer:size-8 @max-2xl/composer:gap-0 @max-2xl/composer:px-0",
            className,
          )}
        >
          <CurrentIcon className="size-4" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-xs font-medium @max-2xl/composer:hidden">
            {t(`workspace_permission.${current.value}`)}
          </span>
          <ChevronDown className="size-3 opacity-60 @max-2xl/composer:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <SandboxStateLine status={sandbox} />
        {PRESETS.map(({ value, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => void applyPreset(value)}>
            <Icon className="size-4" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t(`workspace_permission.${value}`)}</div>
              <div className="text-xs text-muted-foreground">
                {t(`workspace_permission.${value}_hint`)}
              </div>
            </div>
            {value === workspace.permissionPreset ? (
              <Check className="size-4 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 系统边界实情（与应用层档位分开陈述）。
 *  档位决定"要不要弹卡"，系统边界决定"弹了卡也拦不拦得住"——两件事必须分开说，
 *  否则用户会把审批卡当成真正的隔离。 */
function SandboxStateLine({ status }: { status: SandboxStatusDto | null }) {
  const { t } = useTranslation("input");
  if (!status) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        {t("workspace_permission.sandbox_unknown")}
      </div>
    );
  }
  const mechanism =
    status.mechanism === "windows_integrity"
      ? t("workspace_permission.sandbox_mechanism_windows")
      : status.mechanism === "container_mounts"
        ? t("workspace_permission.sandbox_mechanism_container")
        : t("workspace_permission.sandbox_mechanism_none");
  if (status.boundaryActive) {
    return (
      <div className="px-2 py-2 text-xs">
        <div className="font-medium text-emerald-600 dark:text-emerald-400">
          {t("workspace_permission.sandbox_enforced")} · {mechanism}
        </div>
        <div className="mt-0.5 text-muted-foreground">
          {t("workspace_permission.sandbox_enforced_detail")}
          {status.writableAreas.length > 0
            ? ` ${t("workspace_permission.sandbox_writable", { areas: status.writableAreas.join("、") })}`
            : ""}
        </div>
      </div>
    );
  }
  const mismatch = status.tier === "restricted";
  // Windows 部署没开受限档时,给出"去哪开"的指引;容器/其他机制没有应用内开关,不指路。
  const canEnable = status.mechanism === "windows_integrity";
  return (
    <div className="px-2 py-2 text-xs">
      <div
        className={cn(
          "font-medium",
          mismatch ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        {mismatch
          ? t("workspace_permission.sandbox_mismatch")
          : t("workspace_permission.sandbox_not_enforced")}
      </div>
      <div className="mt-0.5 text-muted-foreground">
        {mismatch
          ? t("workspace_permission.sandbox_mismatch_detail")
          : t("workspace_permission.sandbox_off_detail")}
      </div>
      {canEnable ? (
        <div className="mt-0.5 text-muted-foreground">
          {t("workspace_permission.sandbox_enable_hint")}
        </div>
      ) : null}
    </div>
  );
}
