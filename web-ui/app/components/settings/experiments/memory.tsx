// 设置 › 实验功能 › 记忆与上下文。
// 纪律：本页是实验开关的**唯一入口**，不把开关塞进「记忆」主页面。
// 所有开关默认关闭；关闭时后端零副作用。dry-run 默认开启——打开总开关后的第一轮
// 只生成审计提案，不改任何一条记忆。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import api from "~/services/api";
import type { MemoryExperimentSettings, Settings } from "~/types";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsStack,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { Input } from "~/components/ui/input";
import type { SettingsSectionProps } from "~/components/settings/settings-registry";
import { MergeProposalPanel } from "~/components/settings/experiments/merge-proposals";
import { PromotionProposalPanel } from "~/components/settings/experiments/promotion-proposals";
import { MaintenanceProposalPanel } from "~/components/settings/experiments/maintenance-proposals";
import { confirmDialog } from "~/stores/confirm-store";

const DEFAULT_SETTINGS: MemoryExperimentSettings = {
  enabled: false,
  dryRun: true,
  structuredIntake: false,
  compactionCandidates: false,
  mergeProposals: false,
  mentionScoring: false,
  maintenance: false,
  statusRecall: false,
  dynamicRecall: false,
  llmAssist: false,
  autoApplySafe: false,
  hotMentionThreshold: 5,
  eventDistillDays: 7,
  habitDistillDays: 14,
  purgeAfterDays: 30,
  maxCandidatesPerCompaction: 6,
  dynamicRecallTopK: 6,
};

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
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-24"
      onFocus={() => setFocused(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export function MemoryExperimentSection({ settings, onSettings }: SettingsSectionProps) {
  const { t } = useTranslation();
  const current = settings.memoryExperimentSettings ?? DEFAULT_SETTINGS;

  // 可执行态 = 总开关开 + 试运行关 + 周期维护开。进入该状态后失真与到期清除会
  // 真正执行，必须让用户明确确认一次；保持可执行时再改其他开关不重复打扰。
  const armed = (value: MemoryExperimentSettings) =>
    value.enabled === true && value.dryRun === false && value.maintenance === true;

  const patch = async (
    partial: Partial<MemoryExperimentSettings>,
    options: { acknowledgeIrreversible?: boolean } = {},
  ) => {
    let acknowledged = options.acknowledgeIrreversible === true;
    if (!armed(current) && armed({ ...current, ...partial }) && !acknowledged) {
      const ok = await confirmDialog({
        title: t("settings:experiments.unlock_title"),
        description: t("settings:experiments.unlock_desc", { days: current.purgeAfterDays }),
        confirmLabel: t("settings:experiments.unlock_confirm"),
        danger: true,
      });
      if (!ok) return;
      acknowledged = true;
    }
    const previous = current;
    onSettings({ ...settings, memoryExperimentSettings: { ...previous, ...partial } });
    try {
      const response = await api.post<{ memoryExperimentSettings: MemoryExperimentSettings }>(
        "settings/memory-experiment",
        acknowledged ? { ...partial, acknowledgeIrreversible: true } : partial,
      );
      onSettings({ ...settings, memoryExperimentSettings: response.memoryExperimentSettings });
    } catch (err) {
      onSettings({ ...settings, memoryExperimentSettings: previous });
      toast.error(errorText(err));
    }
  };

  const off = !current.enabled;

  return (
    <SettingsStack>
      <div className="flex gap-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-3">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-[var(--ds-text-tertiary)]" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-[var(--ds-text-primary)]">
            {t("settings:experiments.notice_title")}
          </p>
          <p className="text-xs text-[var(--ds-text-secondary)]">
            {t("settings:experiments.notice_desc")}
          </p>
        </div>
      </div>

      <SettingsGroup title={t("settings:experiments.master_title")} description={t("settings:experiments.master_desc")}>
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.enable")}
            description={t("settings:experiments.enable_desc")}
            checked={current.enabled}
            onCheckedChange={(checked) => void patch({ enabled: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.dry_run")}
            description={t("settings:experiments.dry_run_desc")}
            checked={current.dryRun}
            disabled={off}
            onCheckedChange={(checked) => void patch({ dryRun: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup title={t("settings:experiments.capabilities_title")} description={t("settings:experiments.capabilities_desc")}>
        <SettingsRows>
          <SettingsSwitchRow
            label={t("settings:experiments.structured_intake")}
            description={t("settings:experiments.structured_intake_desc")}
            checked={current.structuredIntake}
            disabled={off}
            onCheckedChange={(checked) => void patch({ structuredIntake: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.compaction_candidates")}
            description={t("settings:experiments.compaction_candidates_desc")}
            checked={current.compactionCandidates}
            disabled={off}
            onCheckedChange={(checked) => void patch({ compactionCandidates: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.merge_proposals")}
            description={t("settings:experiments.merge_proposals_desc")}
            checked={current.mergeProposals}
            disabled={off}
            onCheckedChange={(checked) => void patch({ mergeProposals: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.mention_scoring")}
            description={t("settings:experiments.mention_scoring_desc")}
            checked={current.mentionScoring}
            disabled={off}
            onCheckedChange={(checked) => void patch({ mentionScoring: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.maintenance")}
            description={t("settings:experiments.maintenance_desc")}
            checked={current.maintenance}
            disabled={off}
            onCheckedChange={(checked) => void patch({ maintenance: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.status_recall")}
            description={t("settings:experiments.status_recall_desc")}
            checked={current.statusRecall}
            disabled={off}
            onCheckedChange={(checked) => void patch({ statusRecall: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.dynamic_recall")}
            description={t("settings:experiments.dynamic_recall_desc")}
            checked={current.dynamicRecall}
            disabled={off}
            onCheckedChange={(checked) => void patch({ dynamicRecall: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.llm_assist")}
            description={t("settings:experiments.llm_assist_desc")}
            checked={current.llmAssist}
            disabled={off}
            onCheckedChange={(checked) => void patch({ llmAssist: checked })}
          />
          <SettingsSwitchRow
            label={t("settings:experiments.auto_apply_safe")}
            description={t("settings:experiments.auto_apply_safe_desc")}
            checked={current.autoApplySafe}
            disabled={off || current.dryRun}
            onCheckedChange={(checked) => void patch({ autoApplySafe: checked })}
          />
        </SettingsRows>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings:experiments.rhythm_title")}
        description={t("settings:experiments.rhythm_desc")}
      >
        <SettingsRows>
          <SettingsRow
            label={t("settings:experiments.hot_mention_threshold")}
            description={t("settings:experiments.hot_mention_threshold_desc")}
            control={
              <NumberField
                value={current.hotMentionThreshold}
                min={2}
                max={50}
                disabled={off}
                ariaLabel={t("settings:experiments.hot_mention_threshold")}
                onCommit={(value) => void patch({ hotMentionThreshold: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.event_distill_days")}
            description={t("settings:experiments.event_distill_days_desc")}
            control={
              <NumberField
                value={current.eventDistillDays}
                min={1}
                max={365}
                disabled={off}
                ariaLabel={t("settings:experiments.event_distill_days")}
                onCommit={(value) => void patch({ eventDistillDays: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.habit_distill_days")}
            description={t("settings:experiments.habit_distill_days_desc")}
            control={
              <NumberField
                value={current.habitDistillDays}
                min={1}
                max={365}
                disabled={off}
                ariaLabel={t("settings:experiments.habit_distill_days")}
                onCommit={(value) => void patch({ habitDistillDays: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.purge_after_days")}
            description={t("settings:experiments.purge_after_days_desc")}
            control={
              <NumberField
                value={current.purgeAfterDays}
                min={0}
                max={365}
                disabled={off}
                ariaLabel={t("settings:experiments.purge_after_days")}
                onCommit={(value) => void patch({ purgeAfterDays: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.max_candidates")}
            description={t("settings:experiments.max_candidates_desc")}
            control={
              <NumberField
                value={current.maxCandidatesPerCompaction}
                min={0}
                max={20}
                disabled={off}
                ariaLabel={t("settings:experiments.max_candidates")}
                onCommit={(value) => void patch({ maxCandidatesPerCompaction: value })}
              />
            }
          />
          <SettingsRow
            label={t("settings:experiments.dynamic_recall_top_k")}
            description={t("settings:experiments.dynamic_recall_top_k_desc")}
            control={
              <NumberField
                value={current.dynamicRecallTopK}
                min={1}
                max={20}
                disabled={off}
                ariaLabel={t("settings:experiments.dynamic_recall_top_k")}
                onCommit={(value) => void patch({ dynamicRecallTopK: value })}
              />
            }
          />
        </SettingsRows>
      </SettingsGroup>

      <MergeProposalPanel
        enabled={current.enabled}
        dryRun={current.dryRun}
        active={current.mergeProposals}
      />

      <PromotionProposalPanel
        enabled={current.enabled}
        dryRun={current.dryRun}
        active={current.mentionScoring}
      />

      <MaintenanceProposalPanel
        enabled={current.enabled}
        dryRun={current.dryRun}
        active={current.maintenance}
      />

      <div className="flex items-start gap-2 text-xs text-[var(--ds-text-tertiary)]">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{t("settings:experiments.footer")}</p>
      </div>
    </SettingsStack>
  );
}
