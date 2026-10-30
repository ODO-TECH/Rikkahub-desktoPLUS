// 设置 › 实验功能 › 心情。
// 纪律：与「记忆与上下文」实验平级成页，开关不塞进对方的卡片里。
// 总开关默认关闭；dry-run 默认开启——判定照常记账（会产生模型调用），但不写入提示词。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import api from "~/services/api";
import type { MoodExperimentSettings } from "~/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { SettingsSectionProps } from "~/components/settings/settings-registry";
import { confirmDialog } from "~/stores/confirm-store";

const DEFAULT_SETTINGS: MoodExperimentSettings = {
  enabled: false,
  dryRun: true,
  moodModelId: "",
  moodBase: 70,
  moodFloor: 0,
  decayHalfHours: 12,
  sigMood: 3,
  sigDim: 5,
  injectConfidence: 60,
  injectPerDay: 6,
  injectMode: "event",
};

const FOLLOW_MODEL = "__follow__";

const DIM_KEYS = ["happy", "calm", "sweet", "heartache", "worry", "sad", "jealous"] as const;

interface MoodStatusView {
  mood: number;
  band: string;
  dims: Record<string, number>;
  lastReason: string;
  lastConfidence: number;
  minor: boolean;
  judged: boolean;
  updatedAt: number | null;
  judgeCalls: number;
  judgeFailures: number;
  saidToday: number;
  injectPerDay: number;
  decision: string;
  preview: string;
}

interface MoodStateResponse {
  enabled: boolean;
  dryRun: boolean;
  state: MoodStatusView | null;
}

interface MoodTimelineEntry {
  at: number;
  mood: number;
  delta: number;
  reason: string;
  confidence: number;
  kind: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 失焦 / 回车提交的数字输入：避免每敲一个数字就发一次设置请求。 */
function NumberField({
  value,
  min,
  max,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = React.useState(String(value));
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(parsed)));
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      className="w-24 text-right tabular-nums"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function MoodExperimentSection({ settings, onSettings }: SettingsSectionProps) {
  const { t } = useTranslation();
  const current = settings.moodExperimentSettings ?? DEFAULT_SETTINGS;
  const assistantId = settings.assistantId;
  const [status, setStatus] = React.useState<MoodStateResponse | null>(null);
  const [timeline, setTimeline] = React.useState<MoodTimelineEntry[]>([]);

  const load = React.useCallback(async () => {
    try {
      const query = `assistantId=${encodeURIComponent(assistantId)}`;
      const [stateResponse, timelineResponse] = await Promise.all([
        api.get<MoodStateResponse>(`mood/experiment/state?${query}`),
        api.get<{ timeline: MoodTimelineEntry[] }>(`mood/experiment/timeline?${query}&limit=20`),
      ]);
      setStatus(stateResponse);
      setTimeline(timelineResponse.timeline ?? []);
    } catch (err) {
      toast.error(errorText(err));
    }
  }, [assistantId]);

  React.useEffect(() => {
    void load();
  }, [load, current.enabled]);

  const patch = async (partial: Partial<MoodExperimentSettings>) => {
    const previous = settings.moodExperimentSettings ?? DEFAULT_SETTINGS;
    try {
      const response = await api.post<{ moodExperimentSettings: MoodExperimentSettings }>(
        "settings/mood-experiment",
        partial,
      );
      onSettings({ ...settings, moodExperimentSettings: response.moodExperimentSettings });
      void load();
    } catch (err) {
      onSettings({ ...settings, moodExperimentSettings: previous });
      toast.error(errorText(err));
    }
  };

  const reset = async () => {
    const confirmed = await confirmDialog({
      title: t("settings:experiments.mood.reset"),
      description: t("settings:experiments.mood.reset_confirm"),
      confirmLabel: t("settings:experiments.mood.reset"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post("mood/experiment/reset", { assistantId });
      await load();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const chatModels = React.useMemo(() => {
    const models: Array<{ id: string; label: string }> = [];
    for (const provider of settings.providers ?? []) {
      for (const model of provider.models ?? []) {
        if (model.type !== "CHAT") continue;
        models.push({ id: model.id, label: model.displayName || model.modelId });
      }
    }
    return models;
  }, [settings.providers]);

  const activeAssistant = settings.assistants.find((item) => item.id === assistantId);
  const conversationModelId = activeAssistant?.chatModelId ?? settings.chatModelId;
  const conversationModelLabel = conversationModelId
    ? chatModels.find((model) => model.id === conversationModelId)?.label ?? conversationModelId
    : "";
  const followLabel = conversationModelLabel
    ? t("settings:experiments.mood.model_follow", { model: conversationModelLabel })
    : t("settings:experiments.mood.model_follow_unknown");
  const modelValue = current.moodModelId || FOLLOW_MODEL;
  const modelInList = current.moodModelId === "" || chatModels.some((model) => model.id === current.moodModelId);

  const off = !current.enabled;
  const view = status?.state ?? null;
  const decisionKey = view ? `settings:experiments.mood.decision_${view.decision}` : "settings:experiments.mood.decision_no_change";

  return (
    <SettingsStack>
      <div className="flex gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-text-tertiary)]" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-[var(--ds-text-primary)]">
            {t("settings:experiments.mood.notice_title")}
          </p>
          <p className="text-xs text-[var(--ds-text-secondary)]">
            {t("settings:experiments.mood.notice_desc")}
          </p>
        </div>
      </div>

      <SettingsGroup title={t("settings:experiments.mood.master_title")} description={t("settings:experiments.mood.master_desc")}>
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.mood.enable")}
            description={t("settings:experiments.mood.enable_desc")}
            checked={current.enabled}
            onCheckedChange={(checked) => void patch({ enabled: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.mood.dry_run")}
            description={t("settings:experiments.mood.dry_run_desc")}
            checked={current.dryRun}
            disabled={off}
            onCheckedChange={(checked) => void patch({ dryRun: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup title={t("settings:experiments.mood.model_title")} description={t("settings:experiments.mood.model_desc")}>
        <SettingsRows>
          <SettingsRow
            label={t("settings:experiments.mood.model_row")}
            description={followLabel}
            control={
              <Select
                value={modelValue}
                disabled={off}
                onValueChange={(value) => void patch({ moodModelId: value === FOLLOW_MODEL ? "" : value })}
              >
                <SelectTrigger className="w-full max-w-72">
                  <SelectValue>{modelValue === FOLLOW_MODEL ? followLabel : undefined}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={FOLLOW_MODEL}>{followLabel}</SelectItem>
                  {!modelInList && (
                    <SelectItem value={current.moodModelId}>
                      {current.moodModelId}
                    </SelectItem>
                  )}
                  {chatModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup title={t("settings:experiments.mood.params_title")} description={t("settings:experiments.mood.params_desc")}>
        <SettingsRows>
          <SettingsRow
            label={t("settings:experiments.mood.mood_base")}
            description={t("settings:experiments.mood.mood_base_desc")}
            control={
              <NumberField
                value={current.moodBase}
                min={0}
                max={100}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.mood_base")}
                onCommit={(value) => void patch({ moodBase: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.decay_half_hours")}
            description={t("settings:experiments.mood.decay_half_hours_desc")}
            control={
              <NumberField
                value={current.decayHalfHours}
                min={1}
                max={72}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.decay_half_hours")}
                onCommit={(value) => void patch({ decayHalfHours: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.sig_mood")}
            description={t("settings:experiments.mood.sig_mood_desc")}
            control={
              <NumberField
                value={current.sigMood}
                min={1}
                max={20}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.sig_mood")}
                onCommit={(value) => void patch({ sigMood: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.sig_dim")}
            description={t("settings:experiments.mood.sig_dim_desc")}
            control={
              <NumberField
                value={current.sigDim}
                min={1}
                max={30}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.sig_dim")}
                onCommit={(value) => void patch({ sigDim: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.inject_confidence")}
            description={t("settings:experiments.mood.inject_confidence_desc")}
            control={
              <NumberField
                value={current.injectConfidence}
                min={0}
                max={100}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.inject_confidence")}
                onCommit={(value) => void patch({ injectConfidence: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.inject_per_day")}
            description={t("settings:experiments.mood.inject_per_day_desc")}
            control={
              <NumberField
                value={current.injectPerDay}
                min={0}
                max={48}
                disabled={off}
                ariaLabel={t("settings:experiments.mood.inject_per_day")}
                onCommit={(value) => void patch({ injectPerDay: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.mood.inject_mode")}
            description={t("settings:experiments.mood.inject_mode_desc")}
            control={
              <Select
                value={current.injectMode}
                disabled={off}
                onValueChange={(value) => void patch({ injectMode: value as MoodExperimentSettings["injectMode"] })}
              >
                <SelectTrigger className="w-56" aria-label={t("settings:experiments.mood.inject_mode")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="event">{t("settings:experiments.mood.inject_mode_event")}</SelectItem>
                  <SelectItem value="label">{t("settings:experiments.mood.inject_mode_label")}</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:experiments.mood.status_title")}
        description={t("settings:experiments.mood.status_desc")}
      >
        <SettingsRows>
          {off || !view || !view.judged ? (
            <SettingsRow
              label={off ? t("settings:experiments.mood.status_off") : t("settings:experiments.mood.status_empty")}
              control={
                <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                  <RefreshCw aria-hidden className="size-4" />
                  {t("settings:experiments.mood.refresh")}
                </Button>
              }
            />
          ) : (
            <>
              <SettingsRow
                label={t("settings:experiments.mood.status_mood")}
                description={`${view.band}${view.lastReason ? ` · ${view.lastReason}` : ""}`}
                control={<span className="text-lg font-semibold tabular-nums">{view.mood}</span>}
              />
              <div className="space-y-2 px-4 py-3">
                {DIM_KEYS.map((dim) => {
                  const value = Math.max(0, Math.min(100, Number(view.dims?.[dim] ?? 0)));
                  return (
                    <div key={dim} className="flex items-center gap-3">
                      <span className="w-12 shrink-0 text-xs text-[var(--ds-text-secondary)]">
                        {t(`settings:experiments.mood.dim_${dim}`)}
                      </span>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ds-divider)]">
                        <div
                          className="h-full rounded-full bg-[var(--ds-text-secondary)]"
                          style={{ width: `${value}%` }}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-[var(--ds-text-tertiary)]">
                        {Math.round(value)}
                      </span>
                    </div>
                  );
                })}
              </div>
              <SettingsRow
                label={t("settings:experiments.mood.status_confidence")}
                description={`${t("settings:experiments.mood.status_calls")} ${view.judgeCalls} · ${t("settings:experiments.mood.status_failures")} ${view.judgeFailures} · ${t("settings:experiments.mood.status_said_today")} ${view.saidToday}/${view.injectPerDay}`}
                control={
                  <span className="text-sm tabular-nums text-[var(--ds-text-secondary)]">
                    {view.lastConfidence}
                  </span>
                }
              />
              <SettingsRow
                label={t("settings:experiments.mood.preview_title")}
                description={t(decisionKey)}
                control={
                  <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
                    <RefreshCw aria-hidden className="size-4" />
                    {t("settings:experiments.mood.refresh")}
                  </Button>
                }
              />
              {view.preview ? (
                <div className="mx-4 mb-3 rounded-[var(--ds-radius-md)] bg-[var(--ds-surface-muted)] px-3 py-2 text-xs whitespace-pre-wrap text-[var(--ds-text-secondary)]">
                  {view.preview}
                </div>
              ) : null}
            </>
          )}
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:experiments.mood.timeline_title")}
        description={t("settings:experiments.mood.timeline_desc")}
      >
        {timeline.length === 0 ? (
          <SettingsRows>
            <SettingsRow label={t("settings:experiments.mood.timeline_empty")} />
          </SettingsRows>
        ) : (
          <div className="space-y-1 px-4 py-3">
            {timeline.map((entry) => (
              <div key={`${entry.at}-${entry.mood}`} className="flex gap-3 text-xs">
                <span className="w-28 shrink-0 tabular-nums text-[var(--ds-text-tertiary)]">
                  {new Date(entry.at).toLocaleString()}
                </span>
                <span className="w-16 shrink-0 tabular-nums text-[var(--ds-text-secondary)]">
                  {Math.round(entry.mood)}
                  {entry.delta ? ` (${entry.delta > 0 ? "+" : ""}${entry.delta})` : ""}
                </span>
                <span className="min-w-0 flex-1 text-[var(--ds-text-secondary)]">{entry.reason}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end px-4 pb-3">
          <Button type="button" variant="ghost" size="sm" disabled={off} onClick={() => void reset()}>
            <ShieldAlert aria-hidden className="size-4" />
            {t("settings:experiments.mood.reset")}
          </Button>
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}
