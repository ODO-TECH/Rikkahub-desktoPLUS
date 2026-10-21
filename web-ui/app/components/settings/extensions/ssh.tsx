// components/settings/extensions/ssh.tsx — 拓展 › SSH 远程设备
//
// 设备是纯本地配置(host/port/认证),不参与对话工具面:这里只做「连接远程机器」的桌面
// 运维入口。凭据与模型 API Key 同级保存在 state.json,只在本机 UI 与服务端进程间流转,
// 不写日志、不进错误文案。
//
// 交互约定:
// - 表单逐键自动保存(useAutosaveDraft);host/username/凭据允许暂时为空——保存边界不拦,
//   连接边界(测试/执行)才校验,避免填写中途频繁弹失败 toast。
// - 测试与执行都带上当前草稿内联给后端:未保存的修改也按眼前的值连接,不必先等防抖。
// - 每次命令新建一条 SSH 连接、用完即断:并发/残留可控,但命令之间不共享 cwd。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { AutosaveStatusRow } from "~/components/settings/autosave-status";
import { EditorShell, pullSettings, type SectionProps } from "~/components/settings/extensions/common";
import {
  clone,
  deleteRowAction,
  moveItem,
  PasswordInput,
  SettingsDetailFooter,
  SettingsDetailHeader,
  SettingsEmpty,
  SettingsField,
  SettingsGroup,
  SettingsStack,
  textValue,
} from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SegmentedControl } from "~/components/ui/segmented-tabs";
import { Textarea } from "~/components/ui/textarea";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { createId } from "~/lib/id";
import api from "~/services/api";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings, SshDevice } from "~/types";

type AuthType = SshDevice["authType"];

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
  | { kind: "ok"; latencyMs: number }
  | { kind: "error"; message: string };

type ExecState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: SshExecResponse }
  | { kind: "error"; message: string };

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
  };
}

function credentialMissing(device: SshDevice): boolean {
  return device.authType === "key" ? !device.privateKey.trim() : !device.password;
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
    autosave.reset();
  }, [selectedId]);

  const patchDraft = (patch: Partial<SshDevice>) => {
    autosave.markDirty();
    setDraft((current) => ({ ...current, ...patch }));
    // 连接参数一改,上一次的测试/执行结果就不再代表眼前这份配置。
    setTestState({ kind: "idle" });
    setExecState({ kind: "idle" });
  };

  const connectionReady = () =>
    Boolean(draft.host.trim() && draft.username.trim() && !credentialMissing(draft));

  const testConnection = async () => {
    if (!connectionReady()) {
      setTestState({ kind: "error", message: t("settings:ssh.required_hint") });
      return;
    }
    setTestState({ kind: "testing" });
    try {
      const result = await api.post<{ latencyMs: number }>("ssh/test", { device: draft });
      setTestState({ kind: "ok", latencyMs: result.latencyMs });
    } catch (error) {
      setTestState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runCommand = async () => {
    if (!command.trim()) return;
    if (!connectionReady()) {
      setExecState({ kind: "error", message: t("settings:ssh.required_hint") });
      return;
    }
    setExecState({ kind: "running" });
    try {
      const result = await api.post<SshExecResponse>("ssh/exec", { device: draft, command });
      setExecState({ kind: "done", result });
    } catch (error) {
      setExecState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
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
      return (
        <span className="text-xs text-success">
          {t("settings:ssh.test_ok", { ms: testState.latencyMs })}
        </span>
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
        return (
          <div className="min-w-0 text-left">
            <div className="truncate">{textValue(item.name) || t("settings:ssh.untitled")}</div>
            <div className="truncate text-xs text-[var(--ds-text-tertiary)]">{target}</div>
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
                  onChange={(event) => patchDraft({ username: event.target.value })}
                />
              </SettingsField>
              <SettingsField
                label={t("settings:ssh.test")}
                description={t("settings:ssh.test_hint")}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="compact"
                    variant="tertiary"
                    disabled={testState.kind === "testing"}
                    onClick={() => void testConnection()}
                  >
                    {testState.kind === "testing" ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("settings:ssh.test")}
                  </Button>
                  {testStatus}
                </div>
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
                />
              </SettingsField>
              {draft.authType === "password" ? (
                <SettingsField label={t("settings:ssh.password")} hint={t("settings:ssh.password_hint")} htmlFor="ssh-password">
                  <PasswordInput
                    id="ssh-password"
                    value={draft.password}
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
                      onChange={(event) => patchDraft({ privateKey: event.target.value })}
                    />
                  </SettingsField>
                  <SettingsField label={t("settings:ssh.passphrase")} hint={t("settings:ssh.passphrase_hint")} htmlFor="ssh-passphrase">
                    <PasswordInput
                      id="ssh-passphrase"
                      value={draft.passphrase}
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

            <SettingsGroup title={t("settings:ssh.console")} description={t("settings:ssh.console_desc")} fields>
              <SettingsField label={t("settings:ssh.command")} hint={t("settings:ssh.command_hint")} htmlFor="ssh-command">
                <Textarea
                  id="ssh-command"
                  value={command}
                  placeholder={t("settings:ssh.command_placeholder")}
                  className="min-h-20 font-mono text-xs"
                  onChange={(event) => setCommand(event.target.value)}
                />
              </SettingsField>
              <div>
                <Button
                  type="button"
                  size="compact"
                  variant="tertiary"
                  disabled={execState.kind === "running" || !command.trim()}
                  onClick={() => void runCommand()}
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
  );
}
