// components/settings/general.tsx — 通用(个人资料 / 应用)与个性化(外观 / 快捷键)四页。
// 四页共用 displaySetting,全部经 lib/settings-patch 只提交自己改动的字段。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AvatarCropper } from "~/components/avatar-cropper";
import { FontPickerPair } from "~/components/font-picker";
import { CHAT_CJK_OVERRIDE_FAMILY, UI_CJK_OVERRIDE_FAMILY } from "~/lib/font-chain";
import { KeybindingSettings } from "~/components/keybinding-settings";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Slider } from "~/components/ui/slider";
import { patchDisplay, patchSettingsLocal, saveDisplayPatch, saveSubagentPatch } from "~/lib/settings-patch";
import { normalizeLongTextThreshold } from "~/lib/long-text-paste";
import api from "~/services/api";
import type { AssistantAvatar, Settings } from "~/types";
import {
  InlineEditText,
  SettingsAdvancedRegion,
  SettingsAdvancedToggle,
  SettingsField,
  SettingsGroup,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
  textValue,
} from "~/components/settings/shared";
import {
  SUBAGENT_LIMITS,
  SUBAGENT_TOOL_WHITELIST,
  type SubagentConfig,
  type SubagentToolName,
} from "@server/foundation/types/settings/subagent-config";
import { isTauriEnvironment, isWindowsPlatform, getSystemInfo } from "~/lib/system-info";
import { extractErrorMessage } from "~/lib/error";

interface PageProps {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}

// 「显示思考内容」不在此列:思考卡流式中恒展开(字段保留透传,PC 不再读取)。
// 「Enter 发送」在快捷键页。
const DISPLAY_TOGGLES = [
  ["showUserAvatar", "settings:general.opt.show_user_avatar"],
  ["showModelName", "settings:general.opt.show_model_name"],
  ["showModelIcon", "settings:general.opt.show_model_icon"],
  ["showAssistantBubble", "settings:general.opt.show_assistant_bubble"],
  ["showTokenUsage", "settings:general.opt.show_token_usage"],
  ["enableAutoScroll", "settings:general.opt.auto_scroll"],
] as const;

const FONT_PREVIEW_FALLBACK = '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif';

// 子智能体数值项:区间单源自服务端 SUBAGENT_LIMITS(服务端写入校验同源),前端只拦截并提示。
const SUBAGENT_NUMBER_FIELDS = [
  {
    key: "maxConcurrency",
    labelKey: "settings:general.subagent_max_concurrency",
    hintKey: "settings:general.subagent_max_concurrency_hint",
    step: 1,
  },
  {
    key: "maxTasksPerCall",
    labelKey: "settings:general.subagent_max_tasks_per_call",
    hintKey: "settings:general.subagent_max_tasks_per_call_hint",
    step: 1,
  },
  {
    key: "tokenBudget",
    labelKey: "settings:general.subagent_token_budget",
    hintKey: "settings:general.subagent_token_budget_hint",
    step: 1000,
  },
] as const satisfies readonly {
  key: keyof typeof SUBAGENT_LIMITS;
  labelKey: string;
  hintKey: string;
  step: number;
}[];

/** 数值项:本地受控,失焦/回车提交;越界或非整数就地回退并 toast,不静默夹取。 */
function SubagentNumberField({
  labelKey,
  hintKey,
  value,
  range,
  step,
  onCommit,
}: {
  labelKey: string;
  hintKey: string;
  value: number;
  range: { readonly min: number; readonly max: number };
  step: number;
  onCommit: (next: number) => void;
}) {
  const { t } = useTranslation();
  const id = React.useId();
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const next = Number(text.trim());
    if (!Number.isInteger(next) || next < range.min || next > range.max) {
      setText(String(value));
      toast.error(t("settings:general.subagent_invalid_range", { min: range.min, max: range.max }));
      return;
    }
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <SettingsField
      label={t(labelKey)}
      hint={t(hintKey, { min: range.min, max: range.max })}
      htmlFor={id}
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={step}
        value={text}
        className="w-40 tabular-nums"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setText(String(value));
          }
        }}
      />
    </SettingsField>
  );
}

/** 通用 › 个人资料:头像 + 昵称。分节纵排(标题在上、内容在下),头像点按即换,
 *  昵称行内编辑(显式提交,不走防抖自动保存)。不用 SettingsRow 的左右分栏——
 *  头像行与文字行高差大,左右分栏会把右侧控件顶到行中央、上下错落,右侧也形
 *  不成统一对齐列;纵排让两节共享同一条左基线,标题与内容垂直相邻,读起来顺。 */
export function ProfileSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const display = settings.displaySetting;
  const nickname = textValue(display.userNickname);
  const saveNickname = async (userNickname: string) => {
    try {
      await saveDisplayPatch({ userNickname });
    } catch (error) {
      toast.error(extractErrorMessage(error, t("settings:common.save_failed")));
    }
  };

  return (
    <SettingsStack>
      <SettingsGroup title={t("settings:general.avatar")}>
        <div className="flex items-center gap-4 pt-1">
          <AvatarCropper
            value={display.userAvatar ?? { type: "dummy" }}
            fallbackName={nickname || t("settings:general.nickname")}
            onChange={(avatar: AssistantAvatar) => saveDisplayPatch({ userAvatar: avatar })}
            avatarClassName="size-16"
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("settings:general.nickname")}>
        <div className="pt-1">
          <InlineEditText
            value={nickname}
            placeholder={t("settings:general.nickname_unset")}
            ariaLabel={t("settings:general.nickname")}
            allowEmpty
            className="text-sm"
            onCommit={saveNickname}
          />
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}

/** 通用 › 应用:对话显示、终端(Bash,仅 Windows)、应用窗口(仅桌面壳)。 */
export function AppSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const shellPathId = React.useId();
  const longTextThresholdId = React.useId();
  const display = settings.displaySetting;

  // 长文本粘贴转 txt:PC 独立字段(见 defaults.ts 注释),默认开、阈值 5000。
  const longTextEnabled = display.pcPasteLongTextAsFile !== false;
  const longTextThreshold = normalizeLongTextThreshold(display.pcPasteLongTextThreshold);
  const [thresholdText, setThresholdText] = React.useState(String(longTextThreshold));
  React.useEffect(() => {
    setThresholdText(String(longTextThreshold));
  }, [longTextThreshold]);
  const commitLongTextThreshold = () => {
    const next = normalizeLongTextThreshold(thresholdText);
    setThresholdText(String(next));
    if (next !== longTextThreshold) patchDisplay({ pcPasteLongTextThreshold: next });
  };

  // --- 子智能体(PC 专属)---
  // 高级项(并发 / 任务上限 / token 预算 / 子面工具)收进卡内折叠区,避免默认展开吓人。
  const subagent = settings.subagent;
  const [subagentAdvanced, setSubagentAdvanced] = React.useState(false);
  const subagentAdvancedId = React.useId();
  const patchSubagent = (patch: Partial<SubagentConfig>) => {
    void saveSubagentPatch(patch).catch((error: unknown) => {
      toast.error(extractErrorMessage(error, t("settings:common.save_failed")));
    });
  };
  const toggleSubagentTool = (tool: SubagentToolName, checked: boolean) => {
    const next = new Set<SubagentToolName>(subagent.allowedTools);
    if (checked) next.add(tool);
    else next.delete(tool);
    // 存储顺序恒按白名单顺序,避免勾选先后影响展示/序列化。
    patchSubagent({ allowedTools: SUBAGENT_TOOL_WHITELIST.filter((name) => next.has(name)) });
  };

  // --- 关闭时最小化到托盘 —— 仅桌面壳渲染 ---
  // 该设置存在 Rust 侧的 user-config.json(跟数据目录同处),不走后端 API/SSE,
  // 因为窗口关闭的瞬间需要 Rust 直接读到它,而不是等前端回传。
  // 是否桌面壳同步可知,首帧即决定板块在不在;开关真值异步读,读到之前禁用、不显示勾选态
  // (否则关过托盘的用户会先看到 ON 再跳 OFF)。
  const tauri = isTauriEnvironment();
  const [minimizeToTray, setMinimizeToTray] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!tauri) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = await invoke<boolean>("get_minimize_to_tray");
        if (!cancelled) setMinimizeToTray(value);
      } catch (err) {
        console.warn("[tray] get_minimize_to_tray failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tauri]);

  // --- 终端(Bash)路径:仅 Windows 渲染(Linux/Mac 用系统 shell,无此设置) ---
  // shellPath 是机器级绝对路径,存后端 settings(走 SSE 同步);输入框本地受控,
  // 提交(失焦/回车)才 POST。后端校验 .exe + existsSync,失败 toast 并回滚到上次值。
  const [isWindows, setIsWindows] = React.useState(isWindowsPlatform());
  const [shellPath, setShellPath] = React.useState(settings.shellPath ?? "");
  const [shellBusy, setShellBusy] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void getSystemInfo().then(() => {
      if (!cancelled) setIsWindows(isWindowsPlatform());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // SSE 推送/外部改动时同步回输入框(用户没在编辑时)。
  React.useEffect(() => {
    setShellPath(settings.shellPath ?? "");
  }, [settings.shellPath]);

  const submitShellPath = async () => {
    const trimmed = shellPath.trim();
    if (trimmed === (settings.shellPath ?? "")) return; // 无变化不打扰
    setShellBusy(true);
    try {
      await api.post("settings/shell-path", { shellPath: trimmed });
      patchSettingsLocal({ shellPath: trimmed });
      toast.success(t("settings:general.shell_recheck_ok"));
    } catch (err) {
      setShellPath(settings.shellPath ?? ""); // 回滚
      toast.error(extractErrorMessage(err, t("settings:general.shell_path_invalid")));
    } finally {
      setShellBusy(false);
    }
  };

  return (
    <SettingsStack>
      <SettingsGroup title={t("settings:general.display_title")}>
        <SettingsRows>
          {DISPLAY_TOGGLES.map(([key, labelKey]) => (
            <SettingsSwitchRow
              key={key}
              label={t(labelKey)}
              checked={display[key] !== false}
              onCheckedChange={(checked) => patchDisplay({ [key]: checked })}
            />
          ))}
          {/* 默认关:上排开关是「不写即开」(!== false),此项是「不写即关」,不能进表。 */}
          <SettingsSwitchRow
            label={t("settings:general.opt.collapse_all_steps")}
            checked={display.collapseAllSteps === true}
            onCheckedChange={(checked) => patchDisplay({ collapseAllSteps: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:general.long_text_title")}
        description={t("settings:general.long_text_desc")}
        fields
      >
        <SettingsSwitchRow
          label={t("settings:general.long_text_as_file")}
          description={t("settings:general.long_text_as_file_hint")}
          checked={longTextEnabled}
          onCheckedChange={(checked) => patchDisplay({ pcPasteLongTextAsFile: checked })}
        />
        <SettingsField
          label={t("settings:general.long_text_threshold")}
          hint={t("settings:general.long_text_threshold_hint")}
          htmlFor={longTextThresholdId}
        >
          <div className="flex items-center gap-2">
            <Input
              id={longTextThresholdId}
              type="number"
              inputMode="numeric"
              min={500}
              max={50000}
              step={500}
              value={thresholdText}
              disabled={!longTextEnabled}
              className="w-40 tabular-nums"
              onChange={(event) => setThresholdText(event.target.value)}
              onBlur={commitLongTextThreshold}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitLongTextThreshold();
                } else if (event.key === "Escape") {
                  setThresholdText(String(longTextThreshold));
                }
              }}
            />
            <span className="text-xs text-[var(--ds-text-secondary)]">
              {t("settings:general.long_text_threshold_unit")}
            </span>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:general.subagent_title")}
        description={t("settings:general.subagent_desc")}
        action={
          <SettingsAdvancedToggle
            open={subagentAdvanced}
            onOpenChange={setSubagentAdvanced}
            controls={[subagentAdvancedId]}
            attention={subagent.allowedTools.includes("bash")}
          />
        }
      >
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:general.subagent_enabled")}
            description={t("settings:general.subagent_enabled_hint")}
            checked={subagent.enabled}
            onCheckedChange={(checked) => patchSubagent({ enabled: checked })}
          />
          <SettingsAdvancedRegion id={subagentAdvancedId} open={subagentAdvanced}>
            <div className="space-y-5 pt-3 pb-3">
              {SUBAGENT_NUMBER_FIELDS.map((field) => (
                <SubagentNumberField
                  key={field.key}
                  labelKey={field.labelKey}
                  hintKey={field.hintKey}
                  value={subagent[field.key]}
                  range={SUBAGENT_LIMITS[field.key]}
                  step={field.step}
                  onCommit={(next) => patchSubagent({ [field.key]: next })}
                />
              ))}
              <SettingsField
                label={t("settings:general.subagent_tools")}
                hint={t("settings:general.subagent_tools_hint")}
              >
                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {SUBAGENT_TOOL_WHITELIST.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={subagent.allowedTools.includes(tool)}
                        onCheckedChange={(checked) => toggleSubagentTool(tool, checked === true)}
                      />
                      <span className="font-mono text-xs text-[var(--ds-text-primary)]">{tool}</span>
                      {tool === "bash" && subagent.allowedTools.includes(tool) ? (
                        <span className="text-mini text-[var(--ds-warning)]">
                          {t("settings:general.subagent_bash_warning")}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </SettingsField>
            </div>
          </SettingsAdvancedRegion>
        </SettingsRows>
      </SettingsGroup>

      {isWindows && (
        <SettingsGroup
          title={t("settings:general.shell_title")}
          description={t("settings:general.shell_path_hint")}
          fields
        >
          <SettingsField label={t("settings:general.shell_path")} htmlFor={shellPathId}>
            <div className="flex items-center gap-2">
              <Input
                id={shellPathId}
                value={shellPath}
                disabled={shellBusy}
                placeholder={t("settings:general.shell_path_placeholder")}
                className="flex-1 font-mono text-xs"
                onChange={(event) => setShellPath(event.target.value)}
                onBlur={() => void submitShellPath()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitShellPath();
                }}
              />
              <Button
                type="button"
                variant="tertiary"
                size="compact"
                className="shrink-0"
                disabled={shellBusy}
                onClick={() => void submitShellPath()}
              >
                {t("settings:general.shell_recheck")}
              </Button>
            </div>
          </SettingsField>
        </SettingsGroup>
      )}

      {tauri && (
        <SettingsGroup title={t("settings:general.tray_title")} description={t("settings:general.tray_desc")}>
          <SettingsRows>
            <SettingsSwitchRow
              label={t("settings:general.minimize_to_tray")}
              description={t("settings:general.minimize_to_tray_hint")}
              checked={minimizeToTray === true}
              disabled={minimizeToTray === null}
              onCheckedChange={async (checked) => {
                // 乐观更新:先改 UI,失败回滚。invoke 走 Tauri command 写 user-config.json。
                const prev = minimizeToTray;
                setMinimizeToTray(checked);
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("set_minimize_to_tray", { enabled: checked });
                } catch (err) {
                  setMinimizeToTray(prev);
                  toast.error(t("settings:common.save_failed"));
                  console.warn("[tray] set_minimize_to_tray failed", err);
                }
              }}
            />
          </SettingsRows>
        </SettingsGroup>
      )}
    </SettingsStack>
  );
}

/** 个性化 › 外观:字体与字号。 */
export function AppearanceSection({ settings }: PageProps) {
  const { t } = useTranslation();
  const display = settings.displaySetting;

  // 界面字号滑块的本地镜像值。受控 Slider 的 value 若等 POST→SSE 往返才更新,松手时 thumb 会
  // 被旧 value 弹回(用户体验为"拖过去又弹回来")。改用:onValueChange 只动本地(立即跟随),
  // onValueCommit(松手)才提交后端。display 变化时(重置按钮 / SSE 推送 / Ctrl+滚轮)同步回本地。
  const uiFontSizeValue = display.uiFontSize ?? 1;
  const [uiFontSlider, setUiFontSlider] = React.useState(uiFontSizeValue);
  React.useEffect(() => {
    setUiFontSlider(uiFontSizeValue);
  }, [uiFontSizeValue]);

  return (
    <SettingsStack>
      <SettingsGroup title={t("settings:general.font_title")} fields>
        <div className="grid gap-5 md:grid-cols-2">
          <FontPickerPair
            label={t("settings:general.ui_font")}
            enValue={textValue(display.uiFontFamily)}
            cjkValue={textValue(display.uiFontFamilyCjk)}
            fallbackFamily={FONT_PREVIEW_FALLBACK}
            cjkOverrideFamily={UI_CJK_OVERRIDE_FAMILY}
            onChangeEn={(value, family) => patchDisplay({ uiFontFamily: value, uiFontFamilyCss: family })}
            onChangeCjk={(value, family) => patchDisplay({ uiFontFamilyCjk: value, uiFontFamilyCjkCss: family })}
          />
          {/* 预览兜底固定为默认链,不跟随界面字体——否则改界面字体时对话预览块跟着变,
              用户会误以为两个设置联动(内测反馈)。未设对话字体时实际聊天区仍继承界面字体。 */}
          <FontPickerPair
            label={t("settings:general.chat_font")}
            enValue={textValue(display.chatFontFamily)}
            cjkValue={textValue(display.chatFontFamilyCjk)}
            fallbackFamily={FONT_PREVIEW_FALLBACK}
            cjkOverrideFamily={CHAT_CJK_OVERRIDE_FAMILY}
            onChangeEn={(value, family) => patchDisplay({ chatFontFamily: value, chatFontFamilyCss: family })}
            onChangeCjk={(value, family) =>
              patchDisplay({ chatFontFamilyCjk: value, chatFontFamilyCjkCss: family })
            }
          />
        </div>
        <SettingsField
          label={t("settings:general.ui_font_size")}
          hint={t("settings:general.ui_font_size_hint")}
          trailing={
            <>
              <span className="text-xs tabular-nums text-[var(--ds-text-secondary)]">
                {Math.round(uiFontSlider * 100)}%
              </span>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                disabled={(display.uiFontSize ?? null) === null}
                onClick={() => patchDisplay({ uiFontSize: null })}
              >
                {t("settings:general.reset")}
              </Button>
            </>
          }
        >
          <Slider
            value={[uiFontSlider]}
            min={0.85}
            max={1.8}
            step={0.01}
            aria-label={t("settings:general.ui_font_size")}
            onValueChange={(value) => setUiFontSlider(value[0])}
            onValueCommit={(value) => {
              const next = value[0];
              // 1.00 视为"默认",存 null 以保持根字号完全等同于浏览器默认,
              // 避免任何浮点误差引入的默认态视觉偏差。
              const normalized = Math.abs(next - 1) < 0.001 ? null : Number(next.toFixed(2));
              patchDisplay({ uiFontSize: normalized });
            }}
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  );
}

/** 个性化 › 快捷键:Enter 发送 + 快捷键表。 */
export function ShortcutsSection({ settings }: PageProps) {
  const { t } = useTranslation();
  return (
    <KeybindingSettings
      leading={
        <SettingsSwitchRow
          label={t("settings:general.opt.send_on_enter")}
          description={t("settings:hotkeys.send_on_enter_desc")}
          checked={settings.displaySetting.sendOnEnter !== false}
          onCheckedChange={(checked) => patchDisplay({ sendOnEnter: checked })}
        />
      }
    />
  );
}
