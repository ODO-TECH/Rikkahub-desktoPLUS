import * as React from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Server, ShieldAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { extractErrorMessage } from "~/lib/error";
import api from "~/services/api";
import { openSettingsDialog } from "~/stores/settings-dialog-store";
import { useSettingsStore } from "~/stores/app-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";
import type { SshDevice, SshRemoteDir } from "~/types/settings";

// 容器创建流(工作区 M2-4,方案 §3.1/§3.3):
// - 打开现有文件夹:系统目录选择器(Tauri dialog 插件;浏览器/远程访问退化为手输路径),
//   服务端 validateFolderRoot 做安全准入(存在性/系统目录黑名单/dataDir 嵌套)。
// - 信任门(移植 pi project-trust):folder 型创建后必须显式授权——明示 AI 将能读写
//   该目录并执行命令,列出真实路径;确认写 trustedAt,取消则删除刚建的记录(不留
//   未信任的悬空工作区)。managed 型无信任门(创建即信任)。
// - SSH 工作区:凭据与「授权的远程目录」都只在「拓展 › SSH」维护,这里只做绑定
//   (选一台设备 + 它的一条授权目录),界面上没有 host/端口/密码输入框——用户改的
//   是引用,不是凭据。创建即信任:登记目录 + 确认主机密钥已经是两次知情同意。

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function CreateFolderWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功(尚未信任)。调用方接力信任门。 */
  onCreated: (workspace: WorkspaceDto) => void;
}) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [root, setRoot] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [tauri] = React.useState(isTauri);

  React.useEffect(() => {
    if (open) setRoot("");
  }, [open]);

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
      const res = await api.post<{ workspace: WorkspaceDto }>("workspaces", { type: "folder", root: trimmed });
      await refresh();
      onOpenChange(false);
      onCreated(res.workspace);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("workspace.create.folder")}</DialogTitle>
          <DialogDescription>{t("workspace.create.folder_dialog_desc")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            placeholder={t("workspace.create.folder_path_placeholder")}
            className="flex-1 font-mono text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          {tauri ? (
            <Button type="button" variant="outline" onClick={() => void browse()}>
              <FolderOpen className="mr-1.5 size-4" />
              {t("workspace.create.browse")}
            </Button>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("workspace.create.cancel")}
          </Button>
          <Button type="button" disabled={!root.trim() || submitting} onClick={() => void submit()}>
            {t("workspace.create.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── SSH 绑定(设备 + 授权远程目录)选择器 ──────────────────────────────────────

export interface SshDeviceOption {
  device: SshDevice;
  dirs: SshRemoteDir[];
}

/**
 * 可绑定的设备清单:只有「填了路径的授权目录」的设备进选择器(与设置页 usableDirs 同判据,
 * 草稿目录不进)。一个可用目录都没有的设备绑不出工作区,列出来只会让用户选了拿 400。
 */
export function sshDeviceOptions(devices: SshDevice[] | undefined | null): SshDeviceOption[] {
  return (Array.isArray(devices) ? devices : [])
    .map((device) => ({
      device,
      dirs: (Array.isArray(device.dirs) ? device.dirs : []).filter((dir) => dir && dir.path.trim() !== ""),
    }))
    .filter((option) => option.dirs.length > 0);
}

/** 设备下拉项:`名字 (user@host:port)`;名字里不带身份,身份由后端 label 补齐。 */
function sshDeviceOptionLabel(device: SshDevice): string {
  const target = `${device.username}@${device.host}:${device.port}`;
  return device.name.trim() ? `${device.name.trim()} (${target})` : target;
}

/** 目录下拉项:名字优先,回落到真实路径——路径才是边界的权威。 */
function sshDirOptionLabel(dir: SshRemoteDir): string {
  return dir.name.trim() ? `${dir.name.trim()} — ${dir.path}` : dir.path;
}

/** 设置里的可绑定设备(创建对话框与换绑对话框共用)。 */
export function useSshDeviceOptions(): SshDeviceOption[] {
  const devices = useSettingsStore((state) => state.settings?.sshDevices);
  return React.useMemo(() => sshDeviceOptions(devices), [devices]);
}

/**
 * 设备 + 目录两个下拉。换设备时目录重置为该设备的第一条(不存在"跨设备残留 id"这种状态:
 * 后端按 (deviceId, dirId) 解析,带着上一台设备的 dirId 提交只会拿到 binding_dir_unauthorized)。
 */
export function SshBindingFields({
  options,
  deviceId,
  dirId,
  onDeviceChange,
  onDirChange,
  disabled,
}: {
  options: SshDeviceOption[];
  deviceId: string;
  dirId: string;
  onDeviceChange: (deviceId: string) => void;
  onDirChange: (dirId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("page");
  const selected = options.find((option) => option.device.id === deviceId) ?? null;

  if (options.length === 0) {
    return (
      <div className="space-y-3 rounded-[var(--ds-radius-md)] border border-dashed px-3 py-3">
        <p className="text-sm text-muted-foreground">{t("workspace.ssh.none_configured")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => openSettingsDialog("?section=extensions&sub=ssh")}>
          <Server className="mr-1.5 size-4" />
          {t("workspace.ssh.open_settings")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-compact font-medium text-[var(--ds-text-secondary)]">{t("workspace.ssh.device")}</label>
        <Select
          value={deviceId}
          disabled={disabled}
          onValueChange={(next) => {
            onDeviceChange(next);
            const dirs = options.find((option) => option.device.id === next)?.dirs ?? [];
            onDirChange(dirs[0]?.id ?? "");
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("workspace.ssh.device_placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.device.id} value={option.device.id}>
                {sshDeviceOptionLabel(option.device)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label className="text-compact font-medium text-[var(--ds-text-secondary)]">{t("workspace.ssh.dir")}</label>
        <Select value={dirId} disabled={disabled || !selected} onValueChange={onDirChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("workspace.ssh.dir_placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {(selected?.dirs ?? []).map((dir) => (
              <SelectItem key={dir.id} value={dir.id}>
                {sshDirOptionLabel(dir)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* 主机密钥未确认 = 后端判定的不可用绑定(ssh.binding_host_key_unconfirmed):
          这里提前说破并给出跳转,不让用户在"点确定 → 报错"里绕一圈。 */}
      {selected && !selected.device.hostKey ? (
        <div className="flex items-start gap-2 rounded-[var(--ds-radius-md)] bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          <button
            type="button"
            className="text-left underline underline-offset-2"
            onClick={() => openSettingsDialog("?section=extensions&sub=ssh")}
          >
            {t("workspace.ssh.host_key_unconfirmed")}
          </button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("workspace.ssh.capability_hint")}</p>
    </div>
  );
}

export function CreateSshWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功(ssh 型创建即信任,调用方直接开容器,不进信任门)。 */
  onCreated: (workspace: WorkspaceDto) => void;
}) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const options = useSshDeviceOptions();
  const [deviceId, setDeviceId] = React.useState("");
  const [dirId, setDirId] = React.useState("");
  const [name, setName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // 打开时预选第一台设备的第一个目录:绝大多数人只有一台,少两次点击。
  React.useEffect(() => {
    if (!open) return;
    setName("");
    const first = options[0];
    setDeviceId(first?.device.id ?? "");
    setDirId(first?.dirs[0]?.id ?? "");
  }, [open, options]);

  const submit = async () => {
    if (!deviceId || !dirId || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>("workspaces", {
        type: "ssh",
        sshDeviceId: deviceId,
        sshDirId: dirId,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      await refresh();
      onOpenChange(false);
      onCreated(res.workspace);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.create.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const ready = !!deviceId && !!dirId && options.some((option) => option.device.id === deviceId && !!option.dirs.some((dir) => dir.id === dirId) && !!option.device.hostKey);

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-5" strokeWidth={1.75} />
            {t("workspace.create.ssh")}
          </DialogTitle>
          <DialogDescription>{t("workspace.create.ssh_dialog_desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <SshBindingFields
            options={options}
            deviceId={deviceId}
            dirId={dirId}
            onDeviceChange={setDeviceId}
            onDirChange={setDirId}
            disabled={submitting}
          />
          <div className="space-y-1.5">
            <label className="text-compact font-medium text-[var(--ds-text-secondary)]">
              {t("workspace.create.ssh_name_label")}
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("workspace.create.ssh_name_placeholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("workspace.create.cancel")}
          </Button>
          <Button type="button" disabled={!ready || submitting} onClick={() => void submit()}>
            {t("workspace.create.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceTrustDialog({
  workspace,
  onOpenChange,
  onTrusted,
  onDeclinedDelete,
}: {
  workspace: WorkspaceDto | null;
  onOpenChange: (open: boolean) => void;
  onTrusted: (workspace: WorkspaceDto) => void;
  /** 拒绝授权时是否删除该工作区记录(创建流=true;重开已有工作区=false,仅关门)。 */
  onDeclinedDelete: boolean;
}) {
  const { t } = useTranslation("page");
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [busy, setBusy] = React.useState(false);

  const trust = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      const res = await api.post<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}/trust`);
      await refresh();
      onOpenChange(false);
      onTrusted(res.workspace);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.trust.failed")));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    try {
      if (onDeclinedDelete) {
        await api.delete(`workspaces/${workspace.id}`, { parseJson: () => ({}) });
        await refresh();
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace.trust.failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={workspace !== null} onOpenChange={(next) => !busy && !next && void decline()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warning" />
            {t("workspace.trust.title")}
          </DialogTitle>
          <DialogDescription>{t("workspace.trust.description")}</DialogDescription>
        </DialogHeader>
        <div className="break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">{workspace?.root}</div>
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>{t("workspace.trust.point_rw")}</li>
          <li>{t("workspace.trust.point_shell")}</li>
          <li>{t("workspace.trust.point_revoke")}</li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void decline()}>
            {t("workspace.trust.decline")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void trust()}>
            {t("workspace.trust.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
