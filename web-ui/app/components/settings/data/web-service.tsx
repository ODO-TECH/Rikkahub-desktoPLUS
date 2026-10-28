// components/settings/data/web-service.tsx — 数据管理 › Web 服务:服务端口 + 实际监听地址 +
// 访问密码 + 出站 User-Agent。
// 2026-10-21「网络 › 端口与请求」整页搬进本页:改端口与"进程真正绑上的端口"是同一件事的两面,
// 拆在两页会让人对着配置值去配反代——顺延一次就配错了。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Notice } from "~/components/ui/notice";
import { StatusBadge } from "~/components/ui/status-badge";
import {
  clearWebAuthToken,
  fetchWebAuthStatus,
  requestWebAuthToken,
  setWebPassword,
  type WebAuthStatus,
} from "~/services/api";
import api from "~/services/api";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { isDesktopShell, isTauriEnvironment } from "~/lib/system-info";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { copyTextToClipboard } from "~/lib/clipboard";
import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { confirmDialog } from "~/stores/confirm-store";
import { saveProxyFields, statusOf, useProxyStatus } from "~/components/settings/proxy";
import { loadSandboxStatus, type SandboxStatusDto } from "~/lib/sandbox-status";
import type { Settings } from "~/types";
import {
  PasswordInput,
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";

/** 反代 proxy_pass 目标:取绑定组里第一个可直接拨号的 IPv4。0.0.0.0/:: 是通配而非可拨地址
 *  (本机经回环照样通),::1 在 URL 里要加方括号、反代配置里容易写错,故都不作首选。 */
function proxyUpstream(hostnames: string[], port: number): string {
  const usable = hostnames.find((host) => host !== "::1" && host !== "0.0.0.0" && host !== "::");
  return `http://${usable ?? "127.0.0.1"}:${port}`;
}

/** 空串 = 未设置(用平台默认), 与后端 settings/port 的 null 同义。 */
function parsePort(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : "invalid";
}

/** 数据管理 › Web 服务:端口(配置值 + 实际绑定)、访问密码、出站 UA。对外暴露时密码必备。 */
export function WebServiceSection({
  settings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const portId = React.useId();
  const uaId = React.useId();
  // 端口是否被容器部署锁死、平台默认端口与默认 UA 都由代理状态端点下发(与代理页共用)。
  const { status, setStatus } = useProxyStatus();
  const portLocked = status === null || status.containerMode;

  // ── 服务端口:启动期配置,写入后要重启才生效。只接受直接输入(文本框无上下步进),
  //    点「保存」才落库;保存 8080 时先给一次建议性提醒(可继续),已保存的值不再重复弹窗 ──
  const initialPort = settings.preferredPort ?? null;
  const [portDraft, setPortDraft] = React.useState<string>(
    initialPort == null ? "" : String(initialPort),
  );
  const [portSaving, setPortSaving] = React.useState(false);
  React.useEffect(() => {
    // 焦点在输入框时不回推,避免吞掉正在敲的内容;切页/他端改动则同步。
    if (document.activeElement?.id === portId) return;
    setPortDraft(initialPort == null ? "" : String(initialPort));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPort]);

  const desktopShell = isDesktopShell();
  const [restarting, setRestarting] = React.useState(false);

  // ── 重启机制(端口与受限沙盒共用)──
  // 两条壳路径: Tauri 先拿到 relaunch 再停机(插件不可用时绝不先停后端造成死页面),
  // 保存 → POST app/shutdown → 等 600ms → relaunch;
  // WebView2 轻量壳没有 Tauri IPC,保存后导航到 rikkahub://restart,由壳停掉后端、
  // 重新拉起并重新导航(壳自己保证释放端口与数据目录锁)。
  // 受限沙盒开启时,重启的后端会在启动编排里自降级(标目录 → Low 令牌重启 → 准备进程
  // 退出),壳要等的是"慢半拍的同一端口"(S4)。
  const restartWith = async (save: () => Promise<boolean>) => {
    setRestarting(true);
    try {
      if (isTauriEnvironment()) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        if (!(await save())) {
          setRestarting(false);
          return;
        }
        try {
          await api.post("app/shutdown", {});
        } catch {
          // 停机请求可能因服务端立即退出而断开——属预期,继续重启。
        }
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        await relaunch();
        return;
      }
      if (!(await save())) {
        setRestarting(false);
        return;
      }
      window.location.href = "rikkahub://restart";
    } catch (err) {
      setRestarting(false);
      toast.error(t("settings:proxy.restart_failed"));
      console.warn("[restart] failed", err);
    }
  };

  /** 把端口草稿落库。返回 false = 校验失败或用户在 8080 提醒里选择换端口,
   *  「保存并重启」据此中止,不白重启一次。 */
  const savePort = React.useCallback(async (): Promise<boolean> => {
    const parsed = parsePort(portDraft);
    if (parsed === "invalid") {
      toast.error(t("settings:proxy.port_invalid"));
      return false;
    }
    if (parsed === (settings.preferredPort ?? null)) return true;
    if (parsed === 8080) {
      const proceed = await confirmDialog({
        title: t("settings:proxy.port_8080_title"),
        description: t("settings:proxy.port_8080_desc"),
        confirmLabel: t("settings:proxy.port_8080_confirm"),
        cancelLabel: t("settings:proxy.port_8080_cancel"),
      });
      if (!proceed) {
        document.getElementById(portId)?.focus();
        return false;
      }
    }
    setPortSaving(true);
    try {
      await api.post<{ preferredPort: number | null }>("settings/port", { port: parsed });
      patchSettingsLocal({ preferredPort: parsed });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:proxy.port_save_failed"));
      return false;
    } finally {
      setPortSaving(false);
    }
  }, [portDraft, settings.preferredPort, t, portId]);

  // ── 出站 User-Agent:与代理同写 proxyConfig,只提交 userAgent 一个字段 ──
  const initialUa = settings.proxyConfig.userAgent ?? "";
  const [uaDraft, setUaDraft] = React.useState(initialUa);
  const uaAutosave = useAutosaveDraft(
    async () => {
      setStatus(statusOf(await saveProxyFields({ userAgent: uaDraft })));
    },
    {
      delayMs: 600,
      onSaveError: (error) =>
        toast.error(error instanceof Error ? error.message : t("settings:proxy.save_failed")),
    },
  );
  React.useEffect(() => {
    if (uaAutosave.isDirty()) return;
    setUaDraft(initialUa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUa]);
  const patchUa = (value: string) => {
    uaAutosave.markDirty();
    setUaDraft(value);
  };

  // ── 保存并重启(仅桌面壳渲染按钮)──
  const restartApp = async () => restartWith(savePort);

  // ── 受限沙盒(S2b):Windows 低完整性机制才给开关;容器由挂载表决定,只给提示。──
  const [sandbox, setSandbox] = React.useState<SandboxStatusDto | null>(null);
  const [sandboxSaving, setSandboxSaving] = React.useState(false);
  React.useEffect(() => {
    void loadSandboxStatus().then(setSandbox);
  }, []);
  const sandboxOn = settings.sandboxRestricted === true;
  const saveSandbox = React.useCallback(
    async (checked: boolean): Promise<boolean> => {
      setSandboxSaving(true);
      try {
        await api.post("settings/sandbox-restricted", { sandboxRestricted: checked });
        patchSettingsLocal({ sandboxRestricted: checked });
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("settings:data.sandbox_save_failed"),
        );
        return false;
      } finally {
        setSandboxSaving(false);
      }
    },
    [t],
  );
  // 开关(下次启动生效)与运行实测分开陈述:开着开关但还没重启 = 待重启;
  // 重启过但实测仍未生效 = 启动编排降级了,以 notes 的说明为准,不粉饰。
  const sandboxPending = sandboxOn !== (sandbox?.tier === "restricted");
  const sandboxBadge = sandbox?.boundaryActive
    ? t("settings:data.sandbox_badge_enforced")
    : sandbox?.measured === "unknown"
      ? t("settings:data.sandbox_badge_unknown")
      : t("settings:data.sandbox_badge_not_enforced");

  // —— 访问密码:状态经独立端点 /api/web-auth/status(只回布尔,不含哈希)。——
  const [webAuthStatus, setWebAuthStatus] = React.useState<WebAuthStatus | null>(null);
  const [webPwCurrent, setWebPwCurrent] = React.useState("");
  const [webPwNew, setWebPwNew] = React.useState("");
  const [webPwBusy, setWebPwBusy] = React.useState(false);
  const refreshWebAuthStatus = React.useCallback(async () => {
    try {
      setWebAuthStatus(await fetchWebAuthStatus());
    } catch {
      // 状态探测失败(网络抖动)→ 保持现状,密码表单按已有 settings.webServerJwtEnabled 兜底显示。
    }
  }, []);
  React.useEffect(() => {
    void refreshWebAuthStatus();
  }, [refreshWebAuthStatus]);
  const webAuthConfigured = webAuthStatus?.configured ?? settings.webServerJwtEnabled === true;
  const submitWebPassword = React.useCallback(
    async (clear: boolean) => {
      if (webPwBusy) return;
      setWebPwBusy(true);
      try {
        await setWebPassword({
          currentPassword: webAuthConfigured ? webPwCurrent : undefined,
          newPassword: clear ? "" : webPwNew,
        });
        // 改/设密码后旧 token 已失效:立刻用新密码换发,避免下次请求 401 弹登录墙的假锁定。
        // 清密码则清掉本地 token。
        if (clear) clearWebAuthToken();
        else await requestWebAuthToken(webPwNew);
        setWebPwCurrent("");
        setWebPwNew("");
        await refreshWebAuthStatus();
        patchSettingsLocal({ webServerJwtEnabled: !clear });
        toast.success(
          t(clear ? "settings:data.web_password_cleared" : "settings:data.web_password_saved"),
        );
      } catch (error) {
        toast.error((error as Error).message || t("settings:data.web_password_failed"));
      } finally {
        setWebPwBusy(false);
      }
    },
    [webPwBusy, webAuthConfigured, webPwCurrent, webPwNew, refreshWebAuthStatus, t],
  );

  const listen = webAuthStatus?.listen ?? null;
  const upstream = listen?.port ? proxyUpstream(listen.hostnames, listen.port) : "";
  const copyUpstream = React.useCallback(async () => {
    if (!upstream) return;
    try {
      await copyTextToClipboard(upstream);
      toast.success(t("settings:data.web_listen_copied"));
    } catch {
      toast.error(t("settings:data.web_listen_copy_failed"));
    }
  }, [upstream, t]);

  return (
    <SettingsStack>
      {/* 端口两面:上面是配置值(改完要重启),下面三行是进程自己报的实际绑定结果。
          端口顺延 / OS 兜底后两者会不同,而浏览器地址栏在反代之后显示的是代理侧端口——
          配反代只能认「本机端口」。 */}
      <SettingsGroup
        title={t("settings:data.web_listen_title")}
        description={t("settings:data.web_listen_desc")}
        action={
          upstream ? (
            <Button variant="tertiary" size="compact" onClick={() => void copyUpstream()}>
              <Copy />
              {t("settings:data.web_listen_copy")}
            </Button>
          ) : undefined
        }
      >
        <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
          <SettingsRow
            label={t("settings:proxy.port_number")}
            htmlFor={portId}
            description={t("settings:proxy.port_number_hint", { port: status?.defaultPort ?? "…" })}
            control={
              <Input
                id={portId}
                className="w-28 font-mono tabular-nums"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                disabled={portLocked || portSaving}
                value={portDraft}
                onChange={(event) =>
                  setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void savePort();
                }}
                placeholder={status?.defaultPort != null ? String(status.defaultPort) : ""}
              />
            }
          />
          <SettingsRow
            label={t("settings:data.web_listen_port")}
            description={t("settings:data.web_listen_port_desc")}
            control={
              <span className="font-mono text-sm tabular-nums text-[var(--ds-text-secondary)]">
                {listen?.port ?? "—"}
              </span>
            }
          />
          <SettingsRow
            label={t("settings:data.web_listen_hosts")}
            description={t("settings:data.web_listen_hosts_desc")}
            control={
              <code className="break-all font-mono text-xs text-[var(--ds-text-secondary)]">
                {listen?.hostnames.join(", ") || "—"}
              </code>
            }
          />
          <SettingsRow
            label={t("settings:data.web_listen_upstream")}
            description={t("settings:data.web_listen_upstream_desc")}
            control={
              <code className="break-all font-mono text-xs text-[var(--ds-text-secondary)]">
                {upstream || "—"}
              </code>
            }
          />
        </SettingsRows>
        {/* 端口直接输入、显式应用:不做上下步进(一点点加太慢),也不自动保存——
            保存 8080 前要先看到建议换端口的提醒。重启仅在桌面壳里提供。 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="compact"
            onClick={() => void savePort()}
            disabled={
              portLocked ||
              portSaving ||
              restarting ||
              portDraft === (initialPort == null ? "" : String(initialPort))
            }
          >
            {portSaving ? <Loader2 className="animate-spin" /> : null}
            {t("settings:proxy.port_save")}
          </Button>
          {desktopShell ? (
            <Button
              type="button"
              variant="tertiary"
              size="compact"
              onClick={() => void restartApp()}
              disabled={portLocked || portSaving || restarting}
            >
              {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {t("settings:proxy.port_save_restart")}
            </Button>
          ) : null}
        </div>
        {status?.containerMode ? (
          <div className="mt-3 text-xs text-[var(--ds-text-secondary)]">
            {t("settings:proxy.port_container_locked")}
          </div>
        ) : status ? (
          <Notice className="mt-3" tone="warning">
            {t("settings:proxy.port_restart_note")}
          </Notice>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:data.web_password_title")}
        description={t("settings:data.web_password_desc")}
        action={
          <StatusBadge tone={webAuthConfigured ? "success" : "neutral"}>
            {webAuthConfigured ? t("settings:data.enabled") : t("settings:data.disabled")}
          </StatusBadge>
        }
      >
        {/* 访问密码(P1):对外暴露(Docker/反代)时必备。部署者锁定(argv/env)时只读提示;
            否则就地设/改/清。密码存派生哈希,这里只见布尔状态。 */}
        {webAuthStatus?.lockedByDeployment ? (
          <Notice className="mt-3">{t("settings:data.web_password_locked")}</Notice>
        ) : (
          <div className="mt-3 max-w-md space-y-2">
            {webAuthConfigured ? (
              <PasswordInput
                value={webPwCurrent}
                onChange={setWebPwCurrent}
                placeholder={t("settings:data.web_password_current")}
                aria-label={t("settings:data.web_password_current")}
              />
            ) : null}
            <PasswordInput
              value={webPwNew}
              onChange={setWebPwNew}
              placeholder={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
              aria-label={
                webAuthConfigured
                  ? t("settings:data.web_password_new")
                  : t("settings:data.web_password_set")
              }
            />
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="compact"
                disabled={webPwBusy || (webAuthConfigured ? !webPwCurrent || !webPwNew : !webPwNew)}
                onClick={() => void submitWebPassword(false)}
              >
                {webAuthConfigured
                  ? t("settings:data.web_password_change")
                  : t("settings:data.web_password_set_action")}
              </Button>
              {webAuthConfigured ? (
                <Button
                  size="compact"
                  variant="danger"
                  disabled={webPwBusy || !webPwCurrent}
                  onClick={() => void submitWebPassword(true)}
                >
                  {t("settings:data.web_password_clear")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </SettingsGroup>

      {sandbox && sandbox.mechanism === "container_mounts" ? (
        <SettingsGroup
          title={t("settings:data.sandbox_title")}
          description={t("settings:data.sandbox_desc")}
        >
          <Notice className="mt-3">{t("settings:data.sandbox_container_hint")}</Notice>
        </SettingsGroup>
      ) : null}
      {sandbox && sandbox.mechanism === "windows_integrity" ? (
        <SettingsGroup
          title={t("settings:data.sandbox_title")}
          description={t("settings:data.sandbox_desc")}
          action={
            <StatusBadge tone={sandbox.boundaryActive ? "success" : "neutral"}>
              {sandboxBadge}
            </StatusBadge>
          }
        >
          <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
            <SettingsSwitchRow
              label={t("settings:data.sandbox_switch")}
              description={t("settings:data.sandbox_switch_hint")}
              checked={sandboxOn}
              disabled={sandboxSaving || restarting}
              onCheckedChange={(checked) => void saveSandbox(checked)}
            />
            <SettingsRow
              label={t("settings:data.sandbox_measured")}
              description={t("settings:data.sandbox_measured_desc")}
              control={
                <span className="text-sm text-[var(--ds-text-secondary)]">{sandboxBadge}</span>
              }
            />
          </SettingsRows>
          {/* 后端的差异说明(探针失败原因、各目录标注结果、降级原因)——只在受限档
              且有事可说时出现,是最诚实的故障定位入口。 */}
          {sandbox.tier === "restricted" && sandbox.notes.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-[var(--ds-text-secondary)]">
              {sandbox.notes.map((note, index) => (
                <li key={index} className="break-all">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
          {sandboxPending ? (
            <Notice className="mt-3" tone="warning">
              {t("settings:data.sandbox_restart_pending")}
            </Notice>
          ) : null}
          {desktopShell && sandboxPending ? (
            <div className="mt-3">
              <Button
                type="button"
                variant="tertiary"
                size="compact"
                onClick={() => void restartWith(() => saveSandbox(sandboxOn))}
                disabled={sandboxSaving || restarting}
              >
                {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {t("settings:data.sandbox_restart_now")}
              </Button>
            </div>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title={t("settings:proxy.ua_title")}
        description={t("settings:proxy.ua_desc")}
        action={
          <AutosaveStatusRow status={uaAutosave.status} onRetry={() => void uaAutosave.saveNow()} />
        }
        fields
      >
        <SettingsField
          label={t("settings:proxy.ua_label")}
          htmlFor={uaId}
          trailing={
            uaDraft ? (
              <Button type="button" variant="ghost" size="compact" onClick={() => patchUa("")}>
                <RotateCcw />
                {t("settings:proxy.ua_reset")}
              </Button>
            ) : null
          }
        >
          <Input
            id={uaId}
            className="font-mono text-sm"
            value={uaDraft}
            onChange={(event) => patchUa(event.target.value)}
            placeholder={status?.defaultUserAgent ?? ""}
            autoComplete="off"
            spellCheck={false}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  );
}
