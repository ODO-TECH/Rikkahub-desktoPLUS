// 实验 › 记忆与上下文 › 周期维护计划面板。
// 展示 distill_plan 的 proposed 计划、已执行记录（宽限期内可撤销）与到期清除入口。
// 执行 / 清除都要先关闭试运行；执行的是面板里展示过的预览（不二次改稿），
// 服务端另有 memoryExperimentMutates + 审计快照守卫。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import api from "~/services/api";
import { Button } from "~/components/ui/button";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsRows,
} from "~/components/settings/shared";
import { confirmDialog } from "~/stores/confirm-store";

type MaintenanceOp = "fidelity" | "coarsen" | "theme_merge";

const OP_LABEL_KEY: Record<MaintenanceOp, string> = {
  fidelity: "settings:experiments.maintenance_op_fidelity",
  coarsen: "settings:experiments.maintenance_op_coarsen",
  theme_merge: "settings:experiments.maintenance_op_theme",
};

interface MaintenanceRecord {
  auditId: string;
  status: string;
  at: number;
  op: MaintenanceOp;
  targetId: number;
  memberIds: number[];
  content: string;
  currentContent: string;
  reason: string;
  confidence: number;
  fromGeneration: number;
  toGeneration: number;
  cadenceDays: number;
  scopeLabel: string;
  estimatedModelCalls: number;
  estimatedTokens: number;
  involved: Array<{ id: number; content: string; role: "target" | "source" }>;
}

interface ForgetAppliedRecord {
  auditId: string;
  at: number;
  op: MaintenanceOp;
  targetId: number;
  content: string;
  currentContent: string;
  scopeLabel: string;
  modelUsed: boolean;
  purgedAt: number | null;
}

interface ForgettingSummary {
  now: number;
  lastPurgeAt: number | null;
  pendingRawPurges: number;
  pendingTombstones: number;
  scheduledPurges: number;
  earliestPurgeAt: number | null;
  applied: ForgetAppliedRecord[];
}

interface PurgeResult {
  dryRun: boolean;
  scanned: number;
  due: number;
  purgedRaw: number;
  tombstoned: number;
  cleaned: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}

export function MaintenanceProposalPanel({
  enabled,
  dryRun,
  active,
}: {
  enabled: boolean;
  dryRun: boolean;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [proposals, setProposals] = React.useState<MaintenanceRecord[]>([]);
  const [summary, setSummary] = React.useState<ForgettingSummary | null>(null);
  const [lastRunAt, setLastRunAt] = React.useState<number | null>(null);
  const [cost, setCost] = React.useState({ calls: 0, tokens: 0 });
  const [loading, setLoading] = React.useState(false);
  const [planning, setPlanning] = React.useState(false);
  const [purging, setPurging] = React.useState(false);
  const [acting, setActing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!active || !enabled) {
      setProposals([]);
      setSummary(null);
      setLastRunAt(null);
      setCost({ calls: 0, tokens: 0 });
      return;
    }
    setLoading(true);
    try {
      const [maintenance, forget] = await Promise.all([
        api.get<{
          lastRunAt: number | null;
          proposals: MaintenanceRecord[];
          estimatedModelCalls: number;
        }>("memory/experiment/maintenance"),
        api.get<ForgettingSummary>("memory/experiment/forget"),
      ]);
      const list = Array.isArray(maintenance.proposals) ? maintenance.proposals : [];
      setProposals(list);
      setLastRunAt(maintenance.lastRunAt ?? null);
      setCost({
        calls: Number(maintenance.estimatedModelCalls) || 0,
        tokens: list.reduce((sum, item) => sum + (Number(item.estimatedTokens) || 0), 0),
      });
      setSummary(forget && Array.isArray(forget.applied) ? forget : null);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [active, enabled]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const plan = async () => {
    setPlanning(true);
    try {
      const result = await api.post<{ due: number; created: number; estimatedModelCalls: number }>(
        "memory/experiment/maintenance/plan",
        {},
      );
      toast.success(
        t("settings:experiments.maintenance_toast_planned", {
          due: result.due,
          created: result.created,
        }),
      );
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setPlanning(false);
    }
  };

  const apply = async (auditId: string) => {
    setActing(`apply:${auditId}`);
    try {
      await api.post("memory/experiment/maintenance/apply", { auditId });
      toast.success(t("settings:experiments.maintenance_toast_applied"));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setActing(null);
    }
  };

  const reject = async (auditId: string) => {
    setActing(`reject:${auditId}`);
    try {
      await api.post("memory/experiment/maintenance/reject", { auditId });
      toast.success(t("settings:experiments.maintenance_toast_reject"));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setActing(null);
    }
  };

  const undo = async (auditId: string) => {
    setActing(`undo:${auditId}`);
    try {
      await api.post("memory/experiment/maintenance/undo", { auditId });
      toast.success(t("settings:experiments.maintenance_toast_undone"));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setActing(null);
    }
  };

  const purge = async () => {
    if (!dryRun) {
      const ok = await confirmDialog({
        title: t("settings:experiments.forget_purge_confirm_title"),
        description: t("settings:experiments.forget_purge_confirm_desc", {
          raw: summary?.pendingRawPurges ?? 0,
          tombstones: summary?.pendingTombstones ?? 0,
        }),
        danger: true,
      });
      if (!ok) return;
    }
    setPurging(true);
    try {
      const response = await api.post<{ result: PurgeResult }>(
        "memory/experiment/forget/purge",
        {},
      );
      const result = response.result;
      if (result.dryRun) {
        toast.success(t("settings:experiments.forget_purge_dry_run_toast", { due: result.due }));
      } else {
        toast.success(
          t("settings:experiments.forget_purge_toast", {
            raw: result.purgedRaw,
            tombstones: result.tombstoned,
          }),
        );
      }
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setPurging(false);
    }
  };

  if (!active) return null;

  const applied = summary?.applied ?? [];
  const purgePending = (summary?.pendingRawPurges ?? 0) + (summary?.pendingTombstones ?? 0);

  return (
    <SettingsGroup
      title={t("settings:experiments.maintenance_title")}
      description={t("settings:experiments.maintenance_panel_desc")}
      action={
        <Button
          type="button"
          size="compact"
          variant="tertiary"
          disabled={!enabled || planning || loading}
          onClick={() => void plan()}
        >
          {planning ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {planning ? t("settings:experiments.maintenance_scanning") : t("settings:experiments.maintenance_scan")}
        </Button>
      }
    >
      {!enabled ? (
        <p className="pt-3 text-xs text-[var(--ds-text-tertiary)]">
          {t("settings:experiments.maintenance_disabled_hint")}
        </p>
      ) : (
        <div className="space-y-2 pt-3">
          <p className="text-xs text-[var(--ds-text-tertiary)]">
            {lastRunAt
              ? t("settings:experiments.maintenance_last_run", { time: formatTime(lastRunAt) })
              : t("settings:experiments.maintenance_never_run")}
          </p>
          {summary ? (
            <div className="space-y-1 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-3 py-2">
              <p className="text-xs text-[var(--ds-text-secondary)]">
                {t("settings:experiments.forget_summary", {
                  raw: summary.pendingRawPurges,
                  tombstones: summary.pendingTombstones,
                  scheduled: summary.scheduledPurges,
                })}
              </p>
              {summary.earliestPurgeAt ? (
                <p className="text-xs text-[var(--ds-text-tertiary)]">
                  {t("settings:experiments.forget_earliest", { time: formatTime(summary.earliestPurgeAt) })}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="compact"
                  variant="ghost"
                  disabled={purging || loading || (!dryRun && purgePending === 0)}
                  onClick={() => void purge()}
                >
                  {purging ? <Loader2 className="size-4 animate-spin" /> : null}
                  {dryRun
                    ? t("settings:experiments.forget_purge_check")
                    : t("settings:experiments.forget_purge_run")}
                </Button>
              </div>
            </div>
          ) : null}
          {proposals.length === 0 ? (
            <SettingsEmpty>{t("settings:experiments.maintenance_empty")}</SettingsEmpty>
          ) : (
            <>
              <p className="text-xs text-[var(--ds-text-secondary)]">
                {t("settings:experiments.maintenance_cost", {
                  calls: cost.calls,
                  tokens: cost.tokens,
                })}
              </p>
              <SettingsRows>
                {proposals.map((proposal) => {
                  const busy = acting?.endsWith(proposal.auditId) ?? false;
                  const ladder = proposal.op === "fidelity"
                    ? t("settings:experiments.maintenance_fidelity_badge", {
                        level: proposal.fromGeneration + 1,
                      })
                    : t("settings:experiments.maintenance_ladder", {
                        from: proposal.fromGeneration + 1,
                        to: proposal.toGeneration + 1,
                      });
                  return (
                    <div key={proposal.auditId} className="space-y-1.5 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-on-surface)] px-2 py-0.5 font-medium text-[var(--ds-brand-primary)]">
                          {t(OP_LABEL_KEY[proposal.op])}
                        </span>
                        <span className="rounded-[var(--ds-radius-pill)] border border-[var(--ds-divider)] px-2 py-0.5 text-[var(--ds-text-secondary)]">
                          {ladder}
                        </span>
                        <span className="text-[var(--ds-text-tertiary)]">
                          {t("settings:experiments.maintenance_cadence", { days: proposal.cadenceDays })}
                        </span>
                        <span className="text-[var(--ds-text-tertiary)]">{proposal.scopeLabel}</span>
                        {proposal.estimatedModelCalls > 0 ? (
                          <span className="ml-auto text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_calls_badge", {
                              calls: proposal.estimatedModelCalls,
                            })}
                          </span>
                        ) : null}
                      </div>
                      <div className="space-y-1">
                        {proposal.involved.map((item) => (
                          <div key={`${proposal.auditId}-${item.id}`} className="flex gap-2 text-sm">
                            <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                              {item.id === proposal.targetId
                                ? t("settings:experiments.merge_keep")
                                : t("settings:experiments.promotion_members")}
                            </span>
                            <span className="min-w-0 text-[var(--ds-text-primary)]">{item.content}</span>
                          </div>
                        ))}
                      </div>
                      {proposal.content ? (
                        <div className="flex gap-2 text-sm">
                          <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_preview")}
                          </span>
                          <span className="min-w-0 text-[var(--ds-text-secondary)]">{proposal.content}</span>
                        </div>
                      ) : null}
                      <p className="text-xs text-[var(--ds-text-secondary)]">{proposal.reason}</p>
                      <div className="flex justify-end gap-2 pt-1">
                        <Button
                          type="button"
                          size="compact"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void reject(proposal.auditId)}
                        >
                          {t("settings:experiments.maintenance_reject")}
                        </Button>
                        <Button
                          type="button"
                          size="compact"
                          variant="tertiary"
                          disabled={busy || dryRun}
                          onClick={() => void apply(proposal.auditId)}
                        >
                          {acting === `apply:${proposal.auditId}` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : null}
                          {t("settings:experiments.maintenance_apply")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </SettingsRows>
            </>
          )}
          <div className="space-y-2 border-t border-[var(--ds-divider)] pt-2">
            <p className="text-xs font-medium text-[var(--ds-text-secondary)]">
              {t("settings:experiments.maintenance_applied_title")}
            </p>
            {applied.length === 0 ? (
              <SettingsEmpty>{t("settings:experiments.maintenance_applied_empty")}</SettingsEmpty>
            ) : (
              <SettingsRows>
                {applied.map((record) => {
                  const untouchable = record.purgedAt != null;
                  const busy = acting?.endsWith(record.auditId) ?? false;
                  return (
                    <div key={record.auditId} className="space-y-1 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-on-surface)] px-2 py-0.5 font-medium text-[var(--ds-brand-primary)]">
                          {t(OP_LABEL_KEY[record.op])}
                        </span>
                        <span className="text-[var(--ds-text-tertiary)]">{record.scopeLabel}</span>
                        <span className="text-[var(--ds-text-tertiary)]">{formatTime(record.at)}</span>
                        {untouchable ? (
                          <span className="rounded-[var(--ds-radius-pill)] border border-[var(--ds-divider)] px-2 py-0.5 text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_purged_badge")}
                          </span>
                        ) : null}
                      </div>
                      <div className="space-y-1">
                        <div className="flex gap-2 text-sm">
                          <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_applied_original")}
                          </span>
                          <span className="min-w-0 text-[var(--ds-text-secondary)]">{record.currentContent}</span>
                        </div>
                        <div className="flex gap-2 text-sm">
                          <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_applied_result")}
                          </span>
                          <span className="min-w-0 text-[var(--ds-text-primary)]">{record.content}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-1">
                        {untouchable ? (
                          <span className="text-xs text-[var(--ds-text-tertiary)]">
                            {t("settings:experiments.maintenance_undo_expired")}
                          </span>
                        ) : (
                          <Button
                            type="button"
                            size="compact"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void undo(record.auditId)}
                          >
                            {acting === `undo:${record.auditId}` ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : null}
                            {t("settings:experiments.maintenance_undo")}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </SettingsRows>
            )}
          </div>
          <p className="text-xs text-[var(--ds-text-tertiary)]">
            {dryRun
              ? t("settings:experiments.maintenance_apply_hint")
              : t("settings:experiments.maintenance_undo_hint")}
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}
