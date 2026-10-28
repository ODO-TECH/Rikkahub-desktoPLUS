// components/settings/im-access.tsx — 网络 › 外部接入:QQ 机器人与微信把消息送进本机会话。
//
// 这一页只管「绑定与授权」,回答本身在会话引擎里:每个 IM 对话绑定到一条本机会话
// (imAccess.chats),所以桌面端看得见、也能接着往下聊。三条纪律:
// ① 扫码绑定的会话活在服务端(start/poll 一对端点),对话框关掉再打开还能接上;关闭时
//    主动 cancel,不在后台留一个没人看了的轮询。
// ② 陌生人默认拒绝:机器人只认配对码带进来的用户,一码一人、一小时有效。配对码不是秘密,
//    但它打开的是「能让本机模型烧额度、能读到助手人设与记忆」的门,所以这页把它讲清楚。
// ③ 凭据只在服务端落库:界面看得到 appId / accountId 这类识别信息,拿不回明文密钥
//    (绑定接口也刻意不回传),与 SSH 口令、供应商 apiKey 同等待遇。

import * as React from "react";
import dayjs from "dayjs";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { Notice } from "~/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { StatusBadge } from "~/components/ui/status-badge";
import { useWorkspaceStore } from "~/stores/workspace-store";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { copyTextToClipboard } from "~/lib/clipboard";
import { extractErrorMessage } from "~/lib/error";
import { patchSettingsLocal } from "~/lib/settings-patch";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";
import type {
  ImChatBinding,
  ImPairedUser,
  ImPlatformId,
  ImPlatformStatus,
} from "@server/foundation/types/settings/im-access";

/** Radix Select 不允许空串做选项值;空串(跟随默认助手 / 不绑工作区)在这里编成哨兵。 */
const ASSISTANT_DEFAULT = "__default__";
const WORKSPACE_NONE = "__none__";

const PLATFORM_LABEL: Record<ImPlatformId, string> = { qq: "QQ", wechat: "微信" };

/** GET im/status 的响应(与 pc-server/api/handlers/im.ts 同形)。 */
interface ImStatusPayload {
  platforms: ImPlatformStatus[];
  pairing: { enabled: boolean; code: string | null; expiresAt: number | null };
  chats: Pick<ImChatBinding, "key" | "platform" | "displayName" | "conversationId" | "lastActiveAt">[];
  pairedUsers: Record<ImPlatformId, ImPairedUser[]>;
}

type PlatformPatch = Partial<Record<string, string | boolean>>;

function formatTime(ts: number | null | undefined): string {
  return ts ? dayjs(ts).format("YYYY-MM-DD HH:mm") : "—";
}

/** 状态徽标:认服务端的运行态,不认本地开关——开关只是"想让它跑",连没连上要问 registry。 */
function StatusBadgeFor({ status }: { status: ImPlatformStatus | null }) {
  const { t } = useTranslation();
  if (!status || !status.configured) {
    return <StatusBadge>{t("settings:im.status_unbound")}</StatusBadge>;
  }
  if (status.connected) return <StatusBadge tone="success">{t("settings:im.status_connected")}</StatusBadge>;
  if (status.enabled) {
    return status.lastError ? (
      <StatusBadge tone="danger">{t("settings:im.status_error")}</StatusBadge>
    ) : (
      <StatusBadge tone="warning">{t("settings:im.status_connecting")}</StatusBadge>
    );
  }
  return <StatusBadge>{t("settings:im.status_disabled")}</StatusBadge>;
}

export function ImAccessSection({ settings }: { settings: Settings; onSettings: (settings: Settings) => void }) {
  const { t } = useTranslation();
  const im = settings.imAccess;
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [status, setStatus] = React.useState<ImStatusPayload | null>(null);
  const [binding, setBinding] = React.useState<ImPlatformId | null>(null);

  React.useEffect(() => {
    void useWorkspaceStore.getState().refresh();
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api.get<ImStatusPayload>("im/status"));
    } catch {
      // 状态端点失败(启动期 / 网络抖动)不打断配置编辑:开关与表单仍可保存,徽标先空着。
    }
  }, []);

  // 运行态不进 SSE(它是内存态),这页开着时低频轮询,离开即停。
  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const statusOf = (platform: ImPlatformId) =>
    status?.platforms.find((item) => item.platform === platform) ?? null;

  /** 先乐观写 store(开关要跟手),再提交字段级合并;服务端 SSE 快照到达后以其为准。 */
  const savePlatform = React.useCallback(
    async (platform: ImPlatformId, patch: PlatformPatch) => {
      patchSettingsLocal((current) => ({
        imAccess: { ...current.imAccess, [platform]: { ...current.imAccess[platform], ...patch } },
      }));
      try {
        await api.post(`im/${platform}`, patch);
      } catch (error) {
        toast.error(extractErrorMessage(error, t("settings:im.save_failed")));
      } finally {
        void refresh();
      }
    },
    [refresh, t],
  );

  const unbind = React.useCallback(
    async (platform: ImPlatformId) => {
      if (
        !(await confirmDialog({
          title: t("settings:im.unbind_confirm", { platform: PLATFORM_LABEL[platform] }),
          description: t("settings:im.unbind_desc"),
          danger: true,
        }))
      ) {
        return;
      }
      await savePlatform(
        platform,
        platform === "qq"
          ? { enabled: false, appId: "", appSecret: "", botName: "" }
          : { enabled: false, botToken: "", accountId: "", userId: "", botName: "" },
      );
    },
    [savePlatform, t],
  );

  const onBound = React.useCallback(
    (platform: ImPlatformId) => {
      toast.success(t("settings:im.bind_success"));
      void refresh();
      void savePlatform(platform, { enabled: true });
    },
    [refresh, savePlatform, t],
  );

  const pairCode = status?.pairing.code ?? null;
  const pairExpiresAt = status?.pairing.expiresAt ?? null;
  const pairingEnabled = im.pairing.enabled;

  /** 开关要跟手:先乐观写 store,失败由错误提示兜底;服务端 SSE 快照到达后以其为准。 */
  const togglePairing = React.useCallback(
    async (enabled: boolean) => {
      patchSettingsLocal((current) => ({
        imAccess: {
          ...current.imAccess,
          pairing: enabled
            ? { ...current.imAccess.pairing, enabled: true }
            : { enabled: false, code: null, expiresAt: null },
        },
      }));
      try {
        await api.post("im/pairing", { enabled });
      } catch (error) {
        toast.error(extractErrorMessage(error, t("settings:im.save_failed")));
      } finally {
        void refresh();
      }
    },
    [refresh, t],
  );

  const issuePairing = React.useCallback(async () => {
    try {
      await api.post("im/pairing", {});
      void refresh();
    } catch (error) {
      toast.error(extractErrorMessage(error, t("settings:im.pairing_failed")));
    }
  }, [refresh, t]);

  const revokePairing = React.useCallback(async () => {
    try {
      await api.post("im/pairing", { action: "revoke" });
      void refresh();
    } catch (error) {
      toast.error(extractErrorMessage(error, t("settings:im.pairing_failed")));
    }
  }, [refresh, t]);

  const copyPairCode = React.useCallback(async () => {
    if (!pairCode) return;
    try {
      await copyTextToClipboard(pairCode);
      toast.success(t("settings:im.pairing_copied"));
    } catch {
      toast.error(t("settings:im.pairing_copy_failed"));
    }
  }, [pairCode, t]);

  const removePairedUser = React.useCallback(
    async (platform: ImPlatformId, user: ImPairedUser) => {
      if (
        !(await confirmDialog({
          title: t("settings:im.unpair_confirm", { name: user.displayName }),
          description: t("settings:im.unpair_desc"),
          danger: true,
        }))
      ) {
        return;
      }
      try {
        await api.post("im/pairing/unpair", { platform, userId: user.userId });
      } catch (error) {
        toast.error(extractErrorMessage(error, t("settings:im.save_failed")));
      } finally {
        void refresh();
      }
    },
    [refresh, t],
  );

  const removeChat = React.useCallback(
    async (chat: ImChatBinding) => {
      if (
        !(await confirmDialog({
          title: t("settings:im.chat_unbind_confirm"),
          description: t("settings:im.chat_unbind_desc"),
          danger: true,
        }))
      ) {
        return;
      }
      try {
        await api.delete(`im/chat/${encodeURIComponent(chat.key)}`);
      } catch (error) {
        toast.error(extractErrorMessage(error, t("settings:im.save_failed")));
      }
    },
    [t],
  );

  const assistantSelect = (platform: ImPlatformId, value: string) => (
    <Select
      value={value || ASSISTANT_DEFAULT}
      onValueChange={(next) => void savePlatform(platform, { assistantId: next === ASSISTANT_DEFAULT ? "" : next })}
    >
      <SelectTrigger className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ASSISTANT_DEFAULT}>{t("settings:im.assistant_default")}</SelectItem>
        {settings.assistants.map((assistant) => (
          <SelectItem key={assistant.id} value={assistant.id}>
            {assistant.name || t("settings:assistants.default_name")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  /** 与工作区运行时的三道闸对齐:根目录健在、folder 型已过信任门。不可用的照样列出来
   *  (用户得能看见自己建的那个),但选不了并注明原因——绑上去只会静默退回纯聊天。 */
  const workspaceBlockReason = (workspace: (typeof workspaces)[number]) => {
    if (workspace.status !== "ready") return t("settings:im.workspace_missing_dir");
    if (workspace.type === "folder" && workspace.trustedAt == null) return t("settings:im.workspace_untrusted");
    return "";
  };

  const workspaceSelect = (platform: ImPlatformId, value: string) => {
    const known = workspaces.some((workspace) => workspace.id === value);
    return (
      <Select
        value={value || WORKSPACE_NONE}
        onValueChange={(next) => void savePlatform(platform, { workspaceId: next === WORKSPACE_NONE ? "" : next })}
      >
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={WORKSPACE_NONE}>{t("settings:im.workspace_none")}</SelectItem>
          {value && !known ? (
            <SelectItem value={value} disabled>
              {t("settings:im.workspace_deleted")}
            </SelectItem>
          ) : null}
          {workspaces.map((workspace) => {
            const reason = workspaceBlockReason(workspace);
            return (
              <SelectItem key={workspace.id} value={workspace.id} disabled={Boolean(reason)}>
                {reason ? `${workspace.name} · ${reason}` : workspace.name}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    );
  };

  /** 两平台卡片的骨架一致,差异只在凭据摘要与文案,故由一处拼装、三处各给内容。 */
  const platformCard = (platform: ImPlatformId) => {
    const slice = platform === "qq" ? im.qq : im.wechat;
    const platformStatus = statusOf(platform);
    const bound = platform === "qq" ? Boolean(im.qq.appId) : Boolean(im.wechat.accountId);
    const isQq = platform === "qq";

    const summary = isQq
      ? [
          { label: t("settings:im.qq_app_id"), value: im.qq.appId },
          { label: t("settings:im.qq_bot_name"), value: im.qq.botName || "—" },
        ]
      : [
          { label: t("settings:im.wechat_account_id"), value: im.wechat.accountId },
          { label: t("settings:im.wechat_user"), value: im.wechat.userId || "—" },
          { label: t("settings:im.wechat_base_url"), value: im.wechat.baseUrl },
        ];

    return (
      <SettingsGroup
        key={platform}
        title={t(isQq ? "settings:im.qq_title" : "settings:im.wechat_title")}
        description={t(isQq ? "settings:im.qq_desc" : "settings:im.wechat_desc")}
        action={<StatusBadgeFor status={platformStatus} />}
      >
        <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
          <SettingsSwitchRow
            label={t(isQq ? "settings:im.qq_enabled" : "settings:im.wechat_enabled")}
            description={t(isQq ? "settings:im.qq_enabled_desc" : "settings:im.wechat_enabled_desc")}
            checked={bound && slice.enabled}
            disabled={!bound}
            onCheckedChange={(checked) => void savePlatform(platform, { enabled: checked })}
          />
          <SettingsRow
            label={t(isQq ? "settings:im.qq_credentials" : "settings:im.wechat_credentials")}
            description={
              bound ? (
                <span className="block space-y-0.5">
                  {summary.map((entry) => (
                    <span key={entry.label} className="block break-all">
                      <span className="text-[var(--ds-text-tertiary)]">{entry.label}</span>{" "}
                      <span className="font-mono text-xs">{entry.value}</span>
                    </span>
                  ))}
                </span>
              ) : (
                t(isQq ? "settings:im.qq_credentials_unbound" : "settings:im.wechat_credentials_unbound")
              )
            }
            control={
              <>
                <Button variant="tertiary" size="compact" onClick={() => setBinding(platform)}>
                  {bound ? t("settings:im.rebind") : t("settings:im.bind")}
                </Button>
                {bound ? (
                  <Button variant="ghost" size="compact" onClick={() => void unbind(platform)}>
                    {t("settings:im.unbind")}
                  </Button>
                ) : null}
              </>
            }
          />
          <SettingsRow
            label={t(isQq ? "settings:im.qq_assistant" : "settings:im.wechat_assistant")}
            description={t("settings:im.assistant_desc")}
            control={assistantSelect(platform, slice.assistantId)}
          />
          <SettingsRow
            label={t(isQq ? "settings:im.qq_workspace" : "settings:im.wechat_workspace")}
            description={t("settings:im.workspace_desc")}
            control={workspaceSelect(platform, slice.workspaceId)}
          />
          <SettingsSwitchRow
            label={t(isQq ? "settings:im.qq_plaintext" : "settings:im.wechat_plaintext")}
            description={t(isQq ? "settings:im.qq_plaintext_desc" : "settings:im.wechat_plaintext_desc")}
            checked={slice.plainText}
            onCheckedChange={(checked) => void savePlatform(platform, { plainText: checked })}
          />
        </SettingsRows>
        {platformStatus?.lastError ? (
          <Notice className="mt-3" tone="danger">
            {platformStatus.lastError}
          </Notice>
        ) : null}
      </SettingsGroup>
    );
  };

  const pairedRows = (["qq", "wechat"] as const).flatMap((platform) =>
    im[platform].pairedUsers.map((user) => ({ platform, user })),
  );

  return (
    <SettingsStack>
      <Notice>{t("settings:im.intro")}</Notice>

      {platformCard("qq")}
      {platformCard("wechat")}

      <SettingsGroup
        title={t("settings:im.pairing_title")}
        description={t("settings:im.pairing_desc")}
        action={
          pairingEnabled ? (
            pairCode ? (
              <Button variant="ghost" size="compact" onClick={() => void revokePairing()}>
                {t("settings:im.pairing_revoke")}
              </Button>
            ) : (
              <Button size="compact" onClick={() => void issuePairing()}>
                {t("settings:im.pairing_generate")}
              </Button>
            )
          ) : null
        }
      >
        <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
          <SettingsSwitchRow
            label={t("settings:im.pairing_enabled")}
            description={t("settings:im.pairing_enabled_desc")}
            checked={pairingEnabled}
            onCheckedChange={(checked) => void togglePairing(checked)}
          />
        </SettingsRows>
        {pairingEnabled ? (
          pairCode ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
              <button
                type="button"
                className="font-mono text-2xl tracking-[0.3em] text-[var(--ds-text-primary)] transition-opacity hover:opacity-70"
                title={t("settings:im.pairing_copy")}
                onClick={() => void copyPairCode()}
              >
                {pairCode}
              </button>
              <span className="text-xs text-[var(--ds-text-secondary)]">
                {t("settings:im.pairing_expires", { time: formatTime(pairExpiresAt) })}
              </span>
            </div>
          ) : (
            <p className="mt-3 text-xs text-[var(--ds-text-secondary)]">{t("settings:im.pairing_none")}</p>
          )
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("settings:im.paired_title")} description={t("settings:im.paired_desc")}>
        {pairedRows.length === 0 ? (
          <SettingsEmpty className="mt-3">{t("settings:im.paired_empty")}</SettingsEmpty>
        ) : (
          <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
            {pairedRows.map(({ platform, user }) => (
              <SettingsRow
                key={`${platform}:${user.userId}`}
                label={user.displayName}
                description={`${PLATFORM_LABEL[platform]} · ${user.userId} · ${formatTime(user.pairedAt)}`}
                control={
                  <Button variant="ghost" size="compact" onClick={() => void removePairedUser(platform, user)}>
                    {t("settings:im.unpair")}
                  </Button>
                }
              />
            ))}
          </SettingsRows>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings:im.chats_title")} description={t("settings:im.chats_desc")}>
        {im.chats.length === 0 ? (
          <SettingsEmpty className="mt-3">{t("settings:im.chats_empty")}</SettingsEmpty>
        ) : (
          <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
            {im.chats.map((chat) => (
              <SettingsRow
                key={chat.key}
                label={chat.displayName}
                description={`${PLATFORM_LABEL[chat.platform]} · ${t("settings:im.chat_last_active", { time: formatTime(chat.lastActiveAt) })}`}
                control={
                  <Button variant="ghost" size="compact" onClick={() => void removeChat(chat)}>
                    {t("settings:im.chat_unbind")}
                  </Button>
                }
              />
            ))}
          </SettingsRows>
        )}
      </SettingsGroup>

      {binding ? (
        <QrBindDialog
          platform={binding}
          onClose={() => setBinding(null)}
          onBound={() => onBound(binding)}
        />
      ) : null}
    </SettingsStack>
  );
}

/** 扫码绑定的轮询结果(与 pc-server/api/handlers/im.ts 的 poll 响应同形)。 */
interface BindPollResult {
  connected: boolean;
  state?: "waiting" | "expired" | "failed" | "not_started";
  message?: string;
  verificationUrl?: string;
  qrDataUrl?: string | null;
}

/**
 * 二维码对话框。会话活在服务端:关掉对话框 = cancel(下次打开是新码),成功则服务端已经
 * 销毁会话(凭据也写进 settings 了),这里只负责把「已连上」说清楚。
 */
function QrBindDialog({
  platform,
  onClose,
  onBound,
}: {
  platform: ImPlatformId;
  onClose: () => void;
  onBound: () => void;
}) {
  const { t } = useTranslation();
  const isQq = platform === "qq";
  const [sessionKey, setSessionKey] = React.useState<string | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(true);
  const [bound, setBound] = React.useState(false);
  const sessionRef = React.useRef<string | null>(null);
  const onBoundRef = React.useRef(onBound);
  onBoundRef.current = onBound;

  const start = React.useCallback(async () => {
    setStarting(true);
    setError(null);
    setBound(false);
    setQr(null);
    setUrl("");
    setMessage("");
    setSessionKey(null);
    try {
      // QQ 侧首次出码最多等 20s(见 im/qq/bind.ts),默认 30s 的超时贴得太近。
      const result = await api.post<{
        sessionKey: string;
        qrDataUrl?: string | null;
        verificationUrl?: string;
        qrcodeUrl?: string;
        message?: string;
      }>(`im/${platform}/bind/start`, {}, { timeout: 45_000 });
      sessionRef.current = result.sessionKey;
      setSessionKey(result.sessionKey);
      setQr(result.qrDataUrl ?? null);
      setUrl(result.verificationUrl ?? result.qrcodeUrl ?? "");
      setMessage(result.message ?? "");
    } catch (err) {
      setError(extractErrorMessage(err, t("settings:im.bind_failed")));
    } finally {
      setStarting(false);
    }
  }, [platform, t]);

  React.useEffect(() => {
    void start();
    return () => {
      const key = sessionRef.current;
      sessionRef.current = null;
      // 重新生成会换 key:取消的只该是"没人再看"的那一次,不是新的这次。
      if (key) void api.post(`im/${platform}/bind/cancel`, { sessionKey: key }).catch(() => undefined);
    };
  }, [start, platform]);

  React.useEffect(() => {
    if (!sessionKey || bound) return;
    let stopped = false;
    let timer = 0;
    let failures = 0;
    const poll = async () => {
      try {
        const result = await api.post<BindPollResult>(`im/${platform}/bind/poll`, { sessionKey });
        if (stopped) return;
        failures = 0;
        if (result.connected) {
          stopped = true;
          sessionRef.current = null;
          setBound(true);
          onBoundRef.current();
          return;
        }
        if (result.message) setMessage(result.message);
        // 平台换码时才会带新图(见 im/qq/bind.ts 的 urlVersion),其余轮询不重画。
        if (result.qrDataUrl) setQr(result.qrDataUrl);
        if (result.verificationUrl) setUrl(result.verificationUrl);
        if (result.state === "expired" || result.state === "failed" || result.state === "not_started") {
          stopped = true;
          setError(result.message ?? t("settings:im.bind_expired"));
          return;
        }
      } catch (err) {
        if (stopped) return;
        failures += 1;
        if (failures >= 3) {
          stopped = true;
          setError(extractErrorMessage(err, t("settings:im.bind_failed")));
          return;
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sessionKey, bound, platform, t]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(isQq ? "settings:im.qq_bind_title" : "settings:im.wechat_bind_title")}</DialogTitle>
          <DialogDescription>
            {t(isQq ? "settings:im.qq_bind_desc" : "settings:im.wechat_bind_desc")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-1">
          {starting ? (
            <div className="flex h-44 items-center justify-center">
              <Loader2 className="animate-spin" />
            </div>
          ) : bound ? (
            <Notice className="w-full" tone="success">
              {t("settings:im.bind_success")}
            </Notice>
          ) : qr ? (
            <img
              src={qr}
              alt={t("settings:im.qr_alt")}
              className="size-44 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] bg-white p-2"
            />
          ) : (
            <Notice className="w-full" tone="warning">
              {t("settings:im.qr_unavailable")}
            </Notice>
          )}
          {!starting && !bound && url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full break-all text-center font-mono text-[11px] text-[var(--ds-brand-primary)] hover:underline"
            >
              {url}
            </a>
          ) : null}
          {!starting && !bound && message && !error ? (
            <p className="text-center text-xs text-[var(--ds-text-secondary)]">{message}</p>
          ) : null}
          {error ? (
            <Notice className="w-full" tone="danger">
              {error}
            </Notice>
          ) : null}
        </div>
        <DialogFooter>
          {bound ? (
            <Button onClick={onClose}>{t("settings:im.done")}</Button>
          ) : (
            <>
              <Button variant="tertiary" onClick={() => void start()} disabled={starting}>
                {t("settings:im.regenerate")}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {t("common:confirm_dialog.cancel")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
