// components/settings/extensions/ssh.tsx — 拓展 › SSH 远程设备
//
// 设备是纯本地配置(host/port/认证/授权目录),不参与对话工具面:这里只做「连接远程机器」的桌面
// 运维入口。凭据与模型 API Key 同级保存在 state.json,只在本机 UI 与服务端进程间流转,
// 不写日志、不进错误文案。
//
// 交互约定:
// - 表单逐键自动保存(useAutosaveDraft);host/username/凭据允许暂时为空——保存边界不拦,
//   连接边界(测试/执行)才校验,避免填写中途频繁弹失败 toast。
// - 测试与执行都带上当前草稿内联给后端:未保存的修改也按眼前的值连接,不必先等防抖。
// - 主机密钥是认证之前的门槛(与安卓端一致):未确认的服务器不会收到凭据。服务端把对方当场
//   出示的密钥放进错误体,这里据此弹确认框;用户确认后先落库再重放刚才那一步,不需要再点一次。
// - 改 host/port 就把已确认的密钥清空:那是另一台服务器,旧的确认不作数。
// - 授权目录是远程访问面的唯一边界(文件面板、终端、工作区绑定都只能选这里填完的条目),
//   路径留空的算草稿,能保存但不进任何选择器。
// - 连接复用与空闲回收在 ssh/pool.ts:界面只读 ssh/connections 告诉你哪台还挂着活连接,
//   并提供手动断开(改了服务器上的授权、或怀疑会话残留时用)。
// - 确认框打开期间表单与按钮一起禁用(锁定):此时改 host/凭据会让「信任 + 重放」用到错的值。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Play, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { EditorShell, pullSettings, type SectionProps } from "~/components/settings/extensions/common";
import {
  clone,
  deleteRowAction,
  InlineEditText,
  moveItem,
  PasswordInput,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsListAddButton,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
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
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { extractErrorMessage } from "~/lib/error";
import { createId } from "~/lib/id";
import api, { ApiError } from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings, SshDevice, SshHostKey, SshRemoteDir } from "~/types";

type AuthType = SshDevice["authType"];

/** 探测结果(权威形状在 pc-server/ssh/connection.ts 的 SshProbeResult,这里声明用到的字段)。 */
interface SshProbe {
  hostKey: SshHostKey;
  homeDir: string;
  shell: string;
  remoteDir: string;
  remoteDirExists: boolean;
  latencyMs: number;
}

interface SshExecResponse {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string;
  truncated: boolean;
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; probe: SshProbe }
  | { kind: "error"; message: string };

type ExecState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SshExecResponse }
  | { kind: "error"; message: string };

type DirCheck = "checking" | "exists" | "missing";

/** 信任之后要重放的那一步:参数按当时那份,用户不必再点一次「执行」。 */
type SshAction =
  | { kind: "test" }
  | { kind: "exec"; command: string; dirId?: string }
  | { kind: "dir"; dirId: string };

interface TrustPrompt {
  /** 服务器当场出示的密钥:逐字节比对只认 key,指纹是给人看的。 */
  presented: SshHostKey;
  /** true = 与已信任的那把不一致(比首次确认更危险)。 */
  changed: boolean;
  expectedFingerprint?: string;
  /**
   * 服务端给的核对命令(在远端跑 ssh-keygen -lf 那种)。它来自错误体而不是 SshHostKey:
   * 密钥类型不同,命令也不同,由服务端按当场那把 key 算好,前端不再拼一遍。
   */
  verifyCommand?: string;
  action: SshAction;
}

/** 选择器里「不进入任何目录」的取值:Radix Select 不接受空串,用一个不会撞 id 的哨兵。 */
const NO_DIR = "__none__";

function blankDevice(name = ""): SshDevice {
  return {
    id: createId(),
    name,
    host: "",
    port: 22,
    username: "",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
    hostKey: null,
    dirs: [],
  };
}

function credentialMissing(device: SshDevice): boolean {
  return device.authType === "key" ? !device.privateKey.trim() : !device.password;
}

/** 填完路径的目录才算可用:草稿条目能保存,但不进选择器、也不能检查。 */
function usableDirs(device: SshDevice): SshRemoteDir[] {
  return dirsOf(device).filter((dir) => dir.path.trim() !== "");
}

/**
 * 旧 state.json 里没有 dirs 字段:服务端读档会补齐(persistence/state-load.ts),但客户端的
 * settings 也可能来自别处(导入、部分更新),这里统一兜成数组,免得 `draft.dirs.length` 直接抛。
 */
function dirsOf(device: SshDevice): SshRemoteDir[] {
  return Array.isArray(device.dirs) ? device.dirs : [];
}

/**
 * 错误体里的 hostKey 是服务端下发、但仍是外部输入:字段齐了才拿去弹窗,
 * 缺一样就当普通连接失败显示——半份密钥既没法比对也没法信任。
 */
function presentedHostKey(value: unknown): SshHostKey | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { type?: unknown; key?: unknown; fingerprint?: unknown };
  if (typeof raw.type !== "string" || !raw.type) return null;
  if (typeof raw.key !== "string" || !raw.key) return null;
  return {
    type: raw.type,
    key: raw.key,
    fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : "",
  };
}

/** 只有「未信任 / 已变更」这两种失败需要弹确认框;其余(超时、认证失败、目录越权)按普通错误显示。 */
function trustPromptOf(error: unknown, action: SshAction): TrustPrompt | null {
  if (!(error instanceof ApiError)) return null;
  if (error.errorCode !== "ssh.host_key_unknown" && error.errorCode !== "ssh.host_key_changed") return null;
  const presented = presentedHostKey(error.details?.hostKey);
  if (!presented) return null;
  const expected = error.details?.expectedFingerprint;
  const verify = error.details?.verifyCommand;
  return {
    presented,
    changed: error.errorCode === "ssh.host_key_changed",
    expectedFingerprint: typeof expected === "string" ? expected : undefined,
    verifyCommand: typeof verify === "string" ? verify : undefined,
    action,
  };
}

export function SshSection({ settings, onSettings }: SectionProps) {
  const { t } = useTranslation();
  const items = (settings.sshDevices ?? []) as unknown as Array<Record<string, unknown>>;
  const [selectedId, setSelectedId] = React.useState(textValue(items[0]?.id));
  const selected =
    items.find((item) => String(item.id) === selectedId) ?? items[0];
  const [draft, setDraft] = React.useState<SshDevice>(() =>
    clone((selected as unknown as SshDevice | undefined) ?? blankDevice()),
  );
  const [testState, setTestState] = React.useState<TestState>({ kind: "idle" });
  const [command, setCommand] = React.useState("");
  const [execState, setExecState] = React.useState<ExecState>({ kind: "idle" });
  const [consoleDirId, setConsoleDirId] = React.useState<string>(NO_DIR);
  const [dirChecks, setDirChecks] = React.useState<Record<string, DirCheck>>({});
  const [newDir, setNewDir] = React.useState<{ name: string; path: string } | null>(null);
  const [trust, setTrust] = React.useState<TrustPrompt | null>(null);
  const [trustBusy, setTrustBusy] = React.useState(false);
  const [connectedIds, setConnectedIds] = React.useState<string[]>([]);

  const autosave = useAutosaveDraft(
    async () => {
      await api.post("ssh/device", draft);
      await pullSettings(onSettings);
    },
    { errorLabel: t("settings:ssh.title") },
  );

  // 与其它拓展编辑器同款:只在切换条目时从 settings 回填草稿;自动保存后的 settings 回环
  // 不覆盖正在输入的键(依赖故意只有 selectedId)。
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    const next = itemsRef.current.find((item) => String(item.id) === selectedId) ?? itemsRef.current[0];
    if (!next) return;
    setSelectedId(String(next.id));
    setDraft(clone(next as unknown as SshDevice));
    setTestState({ kind: "idle" });
    setExecState({ kind: "idle" });
    setCommand("");
    setConsoleDirId(NO_DIR);
    setDirChecks({});
    setNewDir(null);
    autosave.reset();
  }, [selectedId]);

  /** 连接状态只是展示,拿不到就当没有:不打扰正在进行的测试与执行。 */
  const refreshConnections = React.useCallback(async () => {
    try {
      const result = await api.get<{ deviceIds: string[] }>("ssh/connections");
      setConnectedIds(Array.isArray(result.deviceIds) ? result.deviceIds : []);
    } catch {
      setConnectedIds([]);
    }
  }, []);

  React.useEffect(() => {
    void refreshConnections();
  }, [refreshConnections, selectedId]);

  const patchDraft = (patch: Partial<SshDevice>) => {
    autosave.markDirty();
    setDraft((current) => {
      const next = { ...current, ...patch };
      // 地址变了就是另一台服务器:已确认的主机密钥作废,强制重新确认(不做「大概还是它」的猜测)。
      if (current.hostKey && (next.host !== current.host || next.port !== current.port)) {
        next.hostKey = null;
      }
      return next;
    });
    // 连接参数一改,上一次的测试/执行/目录检查结果就不再代表眼前这份配置。
    setTestState({ kind: "idle" });
    setExecState({ kind: "idle" });
    setDirChecks({});
  };

  const patchDirs = (update: (dirs: SshRemoteDir[]) => SshRemoteDir[]) => {
    autosave.markDirty();
    setDraft((current) => ({ ...current, dirs: update(dirsOf(current)) }));
  };

  const connectionReady = (device: SshDevice) =>
    Boolean(device.host.trim() && device.username.trim() && !credentialMissing(device));

  const runTest = async (device: SshDevice, dirId?: string): Promise<void> => {
    if (!connectionReady(device)) {
      setTestState({ kind: "error", message: t("settings:ssh.required_hint") });
      return;
    }
    setTestState({ kind: "testing" });
    try {
      const probe = await api.post<SshProbe>("ssh/test", {
        device,
        ...(dirId && dirId !== NO_DIR ? { dirId } : {}),
      });
      setTestState({ kind: "ok", probe });
    } catch (error) {
      const prompt = trustPromptOf(error, { kind: "test" });
      if (prompt) {
        setTrust(prompt);
        return;
      }
      setTestState({ kind: "error", message: extractErrorMessage(error, t("settings:ssh.test_failed_short")) });
    } finally {
      void refreshConnections();
    }
  };

  const runExec = async (device: SshDevice, text: string, dirId?: string): Promise<void> => {
    if (!text.trim()) return;
    if (!connectionReady(device)) {
      setExecState({ kind: "error", message: t("settings:ssh.required_hint") });
      return;
    }
    setExecState({ kind: "running" });
    try {
      const result = await api.post<SshExecResponse>("ssh/exec", {
        device,
        command: text,
        ...(dirId && dirId !== NO_DIR ? { dirId } : {}),
      });
      setExecState({ kind: "done", result });
    } catch (error) {
      const prompt = trustPromptOf(error, { kind: "exec", command: text, dirId });
      if (prompt) {
        setTrust(prompt);
        return;
      }
      setExecState({ kind: "error", message: extractErrorMessage(error, t("settings:ssh.exec_failed")) });
    } finally {
      void refreshConnections();
    }
  };

  /** 目录行的「检查」走探测的 remoteDir 通道:只 stat 一次,不构成授权,也不新建常驻会话。 */
  const checkDir = async (device: SshDevice, dir: SshRemoteDir): Promise<void> => {
    if (!connectionReady(device) || !dir.path.trim()) return;
    setDirChecks((current) => ({ ...current, [dir.id]: "checking" }));
    try {
      const probe = await api.post<SshProbe>("ssh/test", { device, dirId: dir.id });
      setDirChecks((current) => ({ ...current, [dir.id]: probe.remoteDirExists ? "exists" : "missing" }));
    } catch (error) {
      const prompt = trustPromptOf(error, { kind: "dir", dirId: dir.id });
      if (prompt) {
        setTrust(prompt);
        return;
      }
      clearCheck(dir.id);
      toast.error(extractErrorMessage(error, t("settings:ssh.dir_check_failed")));
    } finally {
      void refreshConnections();
    }
  };

  function clearCheck(dirId: string) {
    setDirChecks((current) => {
      if (!(dirId in current)) return current;
      const next = { ...current };
      delete next[dirId];
      return next;
    });
  }

  /** 确认框里点「信任」:先把密钥写进设备并落库,再重放用户原本要做的那一步。 */
  const confirmTrust = async () => {
    if (!trust) return;
    const trusted: SshDevice = { ...draft, hostKey: trust.presented };
    setTrustBusy(true);
    try {
      // 先丢弃防抖里那份没有 hostKey 的旧草稿:它迟到一步就会把刚确认的信任覆盖回未信任。
      await autosave.discard();
      await api.post("ssh/device", trusted);
      await pullSettings(onSettings);
      setDraft(trusted);
      setTrust(null);
      const action = trust.action;
      if (action.kind === "test") await runTest(trusted, consoleDirId === NO_DIR ? undefined : consoleDirId);
      if (action.kind === "exec") await runExec(trusted, action.command, action.dirId);
      if (action.kind === "dir") {
        const dir = dirsOf(trusted).find((item) => item.id === action.dirId);
        if (dir) await checkDir(trusted, dir);
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t("settings:ssh.trust_failed")));
    } finally {
      setTrustBusy(false);
      void refreshConnections();
    }
  };

  /** 拒绝信任 = 这一步不做了:把停在「进行中」的状态收回 idle,不给界面留一个永远转圈的钮。 */
  const declineTrust = () => {
    setTrust(null);
    if (testState.kind === "testing") setTestState({ kind: "idle" });
    if (execState.kind === "running") setExecState({ kind: "idle" });
    setDirChecks((current) => {
      const next: Record<string, DirCheck> = {};
      for (const [key, value] of Object.entries(current)) if (value !== "checking") next[key] = value;
      return next;
    });
  };

  const removeById = async (targetId: string) => {
    const target = items.find((item) => String(item.id) === targetId);
    if (!target) return;
    const name = textValue(target.name) || t("settings:ssh.untitled");
    if (!(await confirmDialog({ title: t("settings:ssh.delete_confirm", { name }), danger: true }))) return;
    // 删除当前条目时先丢弃待保存状态,避免迟到的 POST 把已删设备复活。
    const removingActive = String(draft.id) === targetId;
    if (removingActive) await autosave.discard();
    try {
      const remaining = items.filter((item) => String(item.id) !== targetId);
      await api.delete(`ssh/device/${encodeURIComponent(targetId)}`);
      await pullSettings(onSettings);
      if (removingActive) setSelectedId(remaining.length ? String(remaining[0].id) : "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const createDevice = async () => {
    const next = blankDevice(t("settings:ssh.default_name"));
    try {
      await api.post("ssh/device", next);
      await pullSettings(onSettings);
      setSelectedId(next.id);
      setDraft(next);
      autosave.reset();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("settings:ssh.create_failed"),
      );
    }
  };

  const addDir = () => {
    if (!newDir) return;
    const path = newDir.path.trim();
    if (!path) {
      toast.error(t("settings:ssh.dir_path_required"));
      return;
    }
    patchDirs((dirs) => [
      ...dirs,
      { id: createId(), name: newDir.name.trim() || t("settings:ssh.dir_default_name"), path },
    ]);
    setNewDir(null);
  };

  const removeDir = async (dir: SshRemoteDir) => {
    const label = dir.name || dir.path;
    if (!(await confirmDialog({ title: t("settings:ssh.dir_delete_confirm", { name: label }), description: t("settings:ssh.dir_delete_desc"), danger: true }))) return;
    patchDirs((dirs) => dirs.filter((item) => item.id !== dir.id));
    clearCheck(dir.id);
    if (consoleDirId === dir.id) setConsoleDirId(NO_DIR);
  };

  const disconnect = async () => {
    try {
      await api.post("ssh/disconnect", { deviceId: draft.id });
      toast.success(t("settings:ssh.disconnected"));
      await refreshConnections();
    } catch (error) {
      toast.error(extractErrorMessage(error, t("settings:ssh.disconnect_failed")));
    }
  };

  const live = connectedIds.includes(draft.id);
  const dirs = dirsOf(draft);
  const readyDirs = usableDirs(draft);
  const busy = trust != null || trustBusy;

  const testStatus = (() => {
    if (testState.kind === "testing") {
      return (
        <span className="flex items-center gap-1.5 text-xs text-[var(--ds-text-secondary)]">
          <Loader2 className="size-3.5 animate-spin" />
          {t("settings:ssh.testing")}
        </span>
      );
    }
    if (testState.kind === "ok") {
      const { probe } = testState;
      return (
        <div className="space-y-1">
          <span className="text-xs text-success">
            {t("settings:ssh.test_ok", { ms: probe.latencyMs })}
          </span>
          {/* 探测真正读到的远端实情:shell 与主目录——填错了路径、连上的是另一台机器,这里一眼看得出。 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ds-text-secondary)]">
            <span>
              {t("settings:ssh.probe_shell")}: <code className="font-mono">{probe.shell || "—"}</code>
            </span>
            <span>
              {t("settings:ssh.probe_home")}: <code className="font-mono">{probe.homeDir || "—"}</code>
            </span>
            {probe.remoteDir ? (
              <span>
                {t("settings:ssh.probe_dir")}:{" "}
                <code className="font-mono">{probe.remoteDir}</code>{" "}
                <span className={probe.remoteDirExists ? "text-success" : "text-warning"}>
                  {probe.remoteDirExists ? t("settings:ssh.dir_exists") : t("settings:ssh.dir_missing")}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      );
    }
    if (testState.kind === "error") {
      return <span className="text-xs text-destructive">{t("settings:ssh.test_failed", { message: testState.message })}</span>;
    }
    return null;
  })();

  const output = (() => {
    if (execState.kind === "running") {
      return (
        <div className="flex items-center gap-2 text-xs text-[var(--ds-text-secondary)]">
          <Loader2 className="size-3.5 animate-spin" />
          {t("settings:ssh.running")}
        </div>
      );
    }
    if (execState.kind === "error") {
      return <div className="text-xs text-destructive">{execState.message}</div>;
    }
    if (execState.kind !== "done") {
      return <SettingsEmpty>{t("settings:ssh.no_output")}</SettingsEmpty>;
    }
    const { result } = execState;
    const exitLabel =
      result.code === null
        ? t("settings:ssh.exit_signal", { signal: result.signal || "—" })
        : t("settings:ssh.exit_code", { code: result.code });
    return (
      <div className="overflow-hidden rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ds-divider)] px-3 py-1.5 text-xs text-[var(--ds-text-secondary)]">
          <span className={result.code === 0 ? "text-success" : "text-destructive"}>{exitLabel}</span>
          {result.truncated ? <span className="text-warning">{t("settings:ssh.truncated")}</span> : null}
        </div>
        {result.stdout ? (
          <pre className="max-h-80 overflow-auto bg-[var(--ds-surface-100)] p-3 font-mono text-xs whitespace-pre-wrap break-all text-[var(--ds-text-primary)]">
            {result.stdout}
          </pre>
        ) : null}
        {result.stderr ? (
          <div className="border-t border-[var(--ds-divider)]">
            <div className="px-3 pt-2 text-xs font-medium text-[var(--ds-text-secondary)]">
              {t("settings:ssh.stderr")}
            </div>
            <pre className="max-h-60 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-all text-destructive">
              {result.stderr}
            </pre>
          </div>
        ) : null}
      </div>
    );
  })();

  return (
    <>
      <EditorShell
        items={items}
        selectedId={selectedId}
        emptyLabel={t("settings:ssh.empty")}
        onSelect={setSelectedId}
        titleOf={(item) => textValue(item.name) || t("settings:ssh.untitled")}
        renderItem={(item) => {
          const host = textValue(item.host);
          const username = textValue(item.username);
          const target = host ? `${username ? `${username}@` : ""}${host}` : t("settings:ssh.not_configured");
          // 列表项是未归一的原始记录:只判「有没有这个对象」,不猜它的字段。
          const trusted = item.hostKey != null && typeof item.hostKey === "object";
          return (
            <div className="min-w-0 text-left">
              <div className="truncate">{textValue(item.name) || t("settings:ssh.untitled")}</div>
              <div className="truncate text-xs text-[var(--ds-text-tertiary)]">
                {target}
                {/* 未确认主机密钥的设备连不上(认证前就被拒),列表上先标出来,免得用户对着「连接失败」猜。 */}
                {host && !trusted ? <span className="text-warning"> · {t("settings:ssh.list_untrusted")}</span> : null}
              </div>
            </div>
          );
        }}
        rowMenuOf={(item) => {
          const id = String(item.id ?? "");
          if (!id) return undefined;
          return [deleteRowAction(() => removeById(id))];
        }}
        onMove={async (from, to) => {
          const next = moveItem(items, from, to);
          onSettings({ ...settings, sshDevices: next as unknown as Settings["sshDevices"] });
          await api.post("ssh/reorder", { ids: next.map((item) => String(item.id)) });
        }}
        onCreate={createDevice}
      >
        {items.length === 0 ? (
          <SettingsEmpty size="md">{t("settings:ssh.empty_detail")}</SettingsEmpty>
        ) : (
          <div className="@container">
            <SettingsStack>
              <SettingsDetailHeader
                title={draft.name}
                titlePlaceholder={t("settings:ssh.default_name")}
                titleLabel={t("settings:ssh.name")}
                onTitleCommit={(name) => patchDraft({ name })}
                description={t("settings:ssh.page_desc")}
              />

              <SettingsGroup title={t("settings:ssh.connection")} fields>
                <SettingsField label={t("settings:ssh.host")} hint={t("settings:ssh.host_hint")} htmlFor="ssh-host">
                  <Input
                    id="ssh-host"
                    value={draft.host}
                    placeholder="192.168.1.10"
                    disabled={busy}
                    onChange={(event) => patchDraft({ host: event.target.value })}
                  />
                </SettingsField>
                <SettingsField label={t("settings:ssh.port")} hint={t("settings:ssh.port_hint")} htmlFor="ssh-port">
                  <Input
                    id="ssh-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.port || ""}
                    className="w-32"
                    disabled={busy}
                    onChange={(event) =>
                      patchDraft({ port: event.target.value === "" ? 0 : Number(event.target.value) })
                    }
                    onBlur={() => {
                      if (!draft.port || draft.port < 1 || draft.port > 65535) patchDraft({ port: 22 });
                    }}
                  />
                </SettingsField>
                <SettingsField label={t("settings:ssh.username")} htmlFor="ssh-username">
                  <Input
                    id="ssh-username"
                    value={draft.username}
                    placeholder="root"
                    autoComplete="username"
                    disabled={busy}
                    onChange={(event) => patchDraft({ username: event.target.value })}
                  />
                </SettingsField>
                <SettingsField label={t("settings:ssh.test")} description={t("settings:ssh.test_hint")}>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      size="compact"
                      variant="tertiary"
                      disabled={busy || testState.kind === "testing"}
                      onClick={() => void runTest(draft)}
                    >
                      {testState.kind === "testing" ? <Loader2 className="size-4 animate-spin" /> : null}
                      {t("settings:ssh.test")}
                    </Button>
                    {testStatus}
                  </div>
                </SettingsField>
                {/* 活连接是可观察的(空闲 5 分钟自动回收):这一行同时是「现在就断开」的入口。 */}
                <SettingsField
                  label={t("settings:ssh.live_connection")}
                  hint={t("settings:ssh.live_connection_hint")}
                >
                  {live ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-xs text-success">{t("settings:ssh.live_connection_on")}</span>
                      <Button type="button" size="compact" variant="danger" disabled={busy} onClick={() => void disconnect()}>
                        {t("settings:ssh.disconnect")}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:ssh.live_connection_off")}</span>
                  )}
                </SettingsField>
              </SettingsGroup>

              <SettingsGroup title={t("settings:ssh.auth")} fields>
                <SettingsField label={t("settings:ssh.auth_type")}>
                  <SegmentedControl<AuthType>
                    items={[
                      { value: "password", label: t("settings:ssh.auth_password") },
                      { value: "key", label: t("settings:ssh.auth_key") },
                    ]}
                    value={draft.authType}
                    onChange={(authType) => patchDraft({ authType })}
                    aria-label={t("settings:ssh.auth_type")}
                    disabled={busy}
                  />
                </SettingsField>
                {draft.authType === "password" ? (
                  <SettingsField label={t("settings:ssh.password")} hint={t("settings:ssh.password_hint")} htmlFor="ssh-password">
                    <PasswordInput
                      id="ssh-password"
                      value={draft.password}
                      disabled={busy}
                      onChange={(password) => patchDraft({ password })}
                      aria-label={t("settings:ssh.password")}
                      placeholder={t("settings:ssh.password")}
                      showLabel={t("settings:ssh.show_password")}
                      hideLabel={t("settings:ssh.hide_password")}
                    />
                  </SettingsField>
                ) : (
                  <>
                    <SettingsField label={t("settings:ssh.private_key")} hint={t("settings:ssh.private_key_hint")} htmlFor="ssh-private-key">
                      <Textarea
                        id="ssh-private-key"
                        value={draft.privateKey}
                        placeholder={t("settings:ssh.private_key_placeholder")}
                        className="min-h-44 font-mono text-xs"
                        disabled={busy}
                        onChange={(event) => patchDraft({ privateKey: event.target.value })}
                      />
                    </SettingsField>
                    <SettingsField label={t("settings:ssh.passphrase")} hint={t("settings:ssh.passphrase_hint")} htmlFor="ssh-passphrase">
                      <PasswordInput
                        id="ssh-passphrase"
                        value={draft.passphrase}
                        disabled={busy}
                        onChange={(passphrase) => patchDraft({ passphrase })}
                        aria-label={t("settings:ssh.passphrase")}
                        placeholder={t("settings:ssh.passphrase")}
                        showLabel={t("settings:ssh.show_password")}
                        hideLabel={t("settings:ssh.hide_password")}
                      />
                    </SettingsField>
                  </>
                )}
              </SettingsGroup>

              <SettingsGroup title={t("settings:ssh.host_key")} description={t("settings:ssh.host_key_desc")} fields>
                {draft.hostKey ? (
                  <SettingsField
                    label={t("settings:ssh.host_key_trusted", { type: draft.hostKey.type })}
                    hint={t("settings:ssh.host_key_trusted_hint")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldCheck aria-hidden className="size-4 shrink-0 text-success" />
                      <code className="break-all rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-100)] px-2 py-1 font-mono text-xs text-[var(--ds-text-primary)]">
                        {draft.hostKey.fingerprint || t("settings:ssh.host_key_no_fingerprint")}
                      </code>
                      <Button type="button" size="compact" variant="danger" disabled={busy} onClick={() => patchDraft({ hostKey: null })}>
                        {t("settings:ssh.host_key_revoke")}
                      </Button>
                    </div>
                  </SettingsField>
                ) : (
                  <SettingsField label={t("settings:ssh.host_key_untrusted")} hint={t("settings:ssh.host_key_untrusted_hint")}>
                    <div className="flex items-center gap-2 text-xs text-warning">
                      <ShieldAlert aria-hidden className="size-4 shrink-0" />
                      {t("settings:ssh.host_key_pending")}
                    </div>
                  </SettingsField>
                )}
              </SettingsGroup>

              <SettingsGroup title={t("settings:ssh.dirs")} description={t("settings:ssh.dirs_desc")} fields>
                {dirs.length === 0 ? (
                  <p className="text-xs text-[var(--ds-text-tertiary)]">{t("settings:ssh.dirs_empty")}</p>
                ) : (
                  <div className="divide-y divide-[var(--ds-divider)]">
                    {dirs.map((dir) => {
                      const check = dirChecks[dir.id];
                      return (
                        <div key={dir.id} className="flex flex-wrap items-center gap-2 py-2">
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <InlineEditText
                              value={dir.name}
                              ariaLabel={t("settings:ssh.dir_name")}
                              placeholder={t("settings:ssh.dir_default_name")}
                              className="text-sm"
                              onCommit={(name) =>
                                patchDirs((dirs) => dirs.map((item) => (item.id === dir.id ? { ...item, name } : item)))
                              }
                            />
                            <InlineEditText
                              value={dir.path}
                              ariaLabel={t("settings:ssh.dir_path")}
                              placeholder="/srv/app"
                              className="font-mono text-xs text-[var(--ds-text-secondary)]"
                              inputClassName="w-full font-mono text-xs"
                              allowEmpty
                              onCommit={(path) =>
                                patchDirs((dirs) => dirs.map((item) => (item.id === dir.id ? { ...item, path } : item)))
                              }
                            />
                          </div>
                          {check ? (
                            <span
                              className={
                                check === "checking"
                                  ? "text-xs text-[var(--ds-text-secondary)]"
                                  : check === "exists"
                                    ? "text-xs text-success"
                                    : "text-xs text-warning"
                              }
                            >
                              {check === "checking"
                                ? t("settings:ssh.dir_checking")
                                : check === "exists"
                                  ? t("settings:ssh.dir_exists")
                                  : t("settings:ssh.dir_missing")}
                            </span>
                          ) : null}
                          <Button
                            type="button"
                            size="compact"
                            variant="tertiary"
                            disabled={busy || !dir.path.trim() || check === "checking"}
                            onClick={() => void checkDir(draft, dir)}
                          >
                            {t("settings:ssh.dir_check")}
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t("settings:ssh.dir_delete")}
                            title={t("settings:ssh.dir_delete")}
                            disabled={busy}
                            onClick={() => void removeDir(dir)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {newDir ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <Input
                      className="w-40"
                      value={newDir.name}
                      placeholder={t("settings:ssh.dir_default_name")}
                      aria-label={t("settings:ssh.dir_name")}
                      onChange={(event) => setNewDir({ ...newDir, name: event.target.value })}
                    />
                    <Input
                      className="min-w-48 flex-1 font-mono text-xs"
                      value={newDir.path}
                      placeholder="/srv/app"
                      aria-label={t("settings:ssh.dir_path")}
                      autoFocus
                      onChange={(event) => setNewDir({ ...newDir, path: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          addDir();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setNewDir(null);
                        }
                      }}
                    />
                    <Button type="button" size="compact" onClick={addDir}>
                      {t("settings:ssh.dir_add_confirm")}
                    </Button>
                    <Button type="button" size="compact" variant="ghost" onClick={() => setNewDir(null)}>
                      {t("common:confirm_dialog.cancel")}
                    </Button>
                  </div>
                ) : (
                  <SettingsListAddButton
                    label={t("settings:ssh.dir_add")}
                    onClick={() => setNewDir({ name: "", path: "" })}
                    disabled={busy}
                  />
                )}
                <p className="text-xs text-[var(--ds-text-secondary)]">{t("settings:ssh.dir_path_hint")}</p>
              </SettingsGroup>

              <SettingsGroup title={t("settings:ssh.console")} description={t("settings:ssh.console_desc")} fields>
                <SettingsField label={t("settings:ssh.console_dir")} hint={t("settings:ssh.console_dir_hint")}>
                  <Select value={consoleDirId} onValueChange={setConsoleDirId}>
                    <SelectTrigger size="sm" aria-label={t("settings:ssh.console_dir")} className="w-64 max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_DIR}>{t("settings:ssh.console_dir_none")}</SelectItem>
                      {readyDirs.map((dir) => (
                        <SelectItem key={dir.id} value={dir.id}>
                          {dir.name || dir.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>
                <SettingsField label={t("settings:ssh.command")} hint={t("settings:ssh.command_hint")} htmlFor="ssh-command">
                  <Textarea
                    id="ssh-command"
                    value={command}
                    placeholder={t("settings:ssh.command_placeholder")}
                    className="min-h-20 font-mono text-xs"
                    disabled={busy}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </SettingsField>
                <div>
                  <Button
                    type="button"
                    size="compact"
                    variant="tertiary"
                    disabled={busy || execState.kind === "running" || !command.trim()}
                    onClick={() => void runExec(draft, command, consoleDirId)}
                  >
                    {execState.kind === "running" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    {t("settings:ssh.run")}
                  </Button>
                </div>
                <SettingsField label={t("settings:ssh.output")}>{output}</SettingsField>
              </SettingsGroup>

              <SettingsDetailFooter
                status={<AutosaveStatusRow status={autosave.status} onRetry={() => void autosave.saveNow()} />}
              />
            </SettingsStack>
          </div>
        )}
      </EditorShell>

      <Dialog
        open={trust != null}
        onOpenChange={(open) => {
          if (!open && !trustBusy) declineTrust();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert aria-hidden className={trust?.changed ? "size-5 text-destructive" : "size-5 text-warning"} />
              {trust?.changed ? t("settings:ssh.trust_title_changed") : t("settings:ssh.trust_title")}
            </DialogTitle>
            <DialogDescription>
              {trust?.changed ? t("settings:ssh.trust_desc_changed") : t("settings:ssh.trust_desc_new")}
            </DialogDescription>
          </DialogHeader>
          {trust ? (
            <div className="space-y-3">
              <div className="space-y-1 rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-100)] p-3">
                <div className="text-xs text-[var(--ds-text-secondary)]">
                  {t("settings:ssh.trust_target", { target: `${draft.username}@${draft.host}:${draft.port || 22}` })}
                </div>
                <div className="font-mono text-xs text-[var(--ds-text-primary)]">{trust.presented.type}</div>
                <div className="break-all font-mono text-xs text-[var(--ds-text-primary)]">
                  {trust.presented.fingerprint || t("settings:ssh.host_key_no_fingerprint")}
                </div>
                {trust.expectedFingerprint ? (
                  <div className="break-all font-mono text-xs text-destructive">
                    {t("settings:ssh.trust_expected", { fingerprint: trust.expectedFingerprint })}
                  </div>
                ) : null}
              </div>
              {trust.verifyCommand ? (
                <div className="space-y-1">
                  <div className="text-xs text-[var(--ds-text-secondary)]">{t("settings:ssh.trust_verify")}</div>
                  <code className="block break-all rounded-[var(--ds-radius-sm)] border border-[var(--ds-divider)] p-2 font-mono text-xs">
                    {trust.verifyCommand}
                  </code>
                </div>
              ) : null}
              <p className="text-xs text-[var(--ds-text-secondary)]">{t("settings:ssh.trust_warning")}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={trustBusy} onClick={declineTrust}>
              {t("settings:ssh.trust_decline")}
            </Button>
            <Button type="button" disabled={trustBusy} onClick={() => void confirmTrust()}>
              {trustBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("settings:ssh.trust_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
