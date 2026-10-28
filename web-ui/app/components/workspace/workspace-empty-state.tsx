import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderGit2, FolderOpen, FolderSearch, Server, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { EmptyGreeting } from "~/components/empty-greeting";
import { WorkspaceShellNotice } from "~/components/workspace/workspace-shell-notice";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import api from "~/services/api";
import { useWorkspaceStore } from "~/stores/workspace-store";
import { openSettingsDialog } from "~/stores/settings-dialog-store";
import { extractErrorMessage } from "~/lib/error";
import type { WorkspaceDto } from "~/types";

// 工作区容器首屏空态(M3-6;前端重构A3 复刻参考项目首页):顶部工作区上下文胶囊 +
// 时段问候大标题。示例提示词 chip 已按用户要求移除(2026-10-26)——工作区首屏该干什
// 么,胶囊里一句话已经说明白。
// folder 型的信任门已在创建流完成首次引导,这里不再二次打扰。
//
// B6-①b:folder 型根目录丢失(status=missing)时,空态改为"警告 + 失效路径 + 重绑表单"——
// 工作区实体与项目文件夹解耦,缺失不等于降级成普通对话;用户在此直接绑定到新文件夹,
// 底下会话原样跟着。重绑后信任门重置(后端 trusted_at 置空),下次激活过信任门。
//
// B6-①c:ssh 型 missing 是配置层绑定失效(设备/授权目录没了、密钥未确认),不是磁盘丢了:
// 这里没有可输入的本地路径,出口只有「拓展 › SSH」与编辑工作区里的换绑。本机 bash 探测
// 对远程工作区也无意义(远端总有 shell),所以 ssh 型不渲染 WorkspaceShellNotice。

/** folder 型 missing 态的重绑面板:内嵌路径输入 + 浏览,提交 PATCH root。 */
function MissingRebindPanel({ workspace }: { workspace: WorkspaceDto }) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [root, setRoot] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const browse = async () => {
    try {
      const { open: openPicker } = await import("@tauri-apps/plugin-dialog");
      const picked = await openPicker({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) setRoot(picked);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.pick_failed")));
    }
  };

  const submit = async () => {
    const trimmed = root.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}`, { root: trimmed });
      await refresh();
      toast.success(t("workspace.menu.rebind") + " ✓");
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.menu.rebind_failed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-6 flex flex-col items-center">
      <div className="w-full max-w-md rounded-[var(--ds-radius-lg)] border border-warning/30 bg-warning/5 px-4 py-4 text-left">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <div className="text-compact font-medium text-foreground">{t("workspace.empty.missing_title")}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{t("workspace.empty.missing_desc")}</div>
            <div className="mt-1.5 truncate font-mono text-mini text-[var(--ds-text-tertiary)]" title={workspace.root}>
              {workspace.root}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                placeholder={t("workspace.create.folder_path_placeholder")}
                className="h-8 flex-1 font-mono text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void browse()}>
                <FolderSearch className="mr-1 size-3.5" />
                {t("workspace.create.browse")}
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              className="mt-2.5 h-8"
              disabled={!root.trim() || submitting}
              onClick={() => void submit()}
            >
              {t("workspace.empty.missing_rebind")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ssh 型绑定失效面板:原因按 errorCode 查本地化文案(四类失效的下一步动作各不相同),
 * 出口是「拓展 › SSH」——重绑到另一条授权目录走工作区编辑对话框,这里不给本机路径输入框,
 * 因为失效的根因不在本机磁盘上。
 */
function MissingBindingPanel({ workspace }: { workspace: WorkspaceDto }) {
  const { t } = useTranslation("page");
  const { t: tc } = useTranslation("common");
  const reason = workspace.unavailableErrorCode
    ? tc(`errors.${workspace.unavailableErrorCode}`)
    : workspace.unavailableReason;
  return (
    <div className="mb-6 flex flex-col items-center">
      <div className="w-full max-w-md rounded-[var(--ds-radius-lg)] border border-warning/30 bg-warning/5 px-4 py-4 text-left">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <div className="text-compact font-medium text-foreground">{t("workspace.ssh.missing_title")}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{t("workspace.ssh.missing_desc")}</div>
            {reason ? <div className="mt-1 text-xs leading-5 text-warning">{reason}</div> : null}
            <div className="mt-1.5 truncate font-mono text-mini text-[var(--ds-text-tertiary)]" title={[workspace.sshTarget, workspace.root].filter(Boolean).join(" · ")}>
              {workspace.sshTarget ? `${workspace.sshTarget} · ${workspace.root}` : workspace.root}
            </div>
            <Button type="button" size="sm" className="mt-2.5 h-8" onClick={() => openSettingsDialog("?section=extensions&sub=ssh")}>
              <Server className="mr-1 size-3.5" strokeWidth={1.75} />
              {t("workspace.ssh.open_settings")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkspaceEmptyState({
  workspace,
}: {
  workspace: WorkspaceDto;
}) {
  const { t } = useTranslation("page");
  const Icon = workspace.type === "folder" ? FolderOpen : workspace.type === "ssh" ? Server : FolderGit2;

  // folder 型根目录丢失:不再渲染示例提示词(AI 此时无法读写文件),改呈现重绑面板。
  if (workspace.type === "folder" && workspace.status === "missing") {
    return (
      <div className="mb-6">
        <WorkspaceShellNotice />
        <MissingRebindPanel workspace={workspace} />
      </div>
    );
  }

  // ssh 型绑定失效:同理不给示例提示词(工具一个都没法用),面板只给"为什么不行 + 去哪儿修"。
  if (workspace.type === "ssh" && workspace.status === "missing") {
    return (
      <div className="mb-6">
        <MissingBindingPanel workspace={workspace} />
      </div>
    );
  }

  return (
    <div className="mb-6 text-center">
      {/* 工作区上下文胶囊:名称 + 类型说明(folder 型 hover 展示真实路径),
          对应参考项目首页大标题上方的提示胶囊位。 */}
      <div className="mb-4 flex max-w-full justify-center px-4">
        <span
          className="inline-flex min-w-0 max-w-md items-center gap-1.5 rounded-full bg-[var(--ds-surface-input)] px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--ds-input-shadow)]"
          title={
            workspace.type === "ssh"
              ? [workspace.sshTarget, workspace.root].filter(Boolean).join(" · ")
              : workspace.type === "folder" && workspace.root
                ? workspace.root
                : undefined
          }
        >
          <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
          {/* 名称 shrink-0 保证可见;介绍文案 min-w-0 truncate——此前介绍是 shrink-0,
              长文案会把名称挤没并溢出胶囊底色(2026-10-26 用户反馈)。 */}
          <span className="shrink-0 font-medium text-foreground/80">{workspace.name}</span>
          <span className="min-w-0 truncate">
            {workspace.type === "ssh"
              ? t("workspace.empty.ssh_intro")
              : workspace.type === "folder"
                ? t("workspace.empty.folder_intro")
                : t("workspace.empty.managed_intro")}
          </span>
        </span>
      </div>
      {workspace.type === "ssh" ? null : <WorkspaceShellNotice />}
      <EmptyGreeting />
    </div>
  );
}
