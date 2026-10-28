// 实验 › 记忆与上下文 › 合并提案面板。
// 只展示审计里的 proposed 提案；扫描与批准/拒绝都是显式动作，页面加载时不会自动扫描。
// 试运行中批准按钮禁用——执行入口在服务端还有一道 memoryExperimentMutates 守卫。
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

type MergeOp = "overwrite" | "complete" | "merge";

interface InvolvedMemory {
  id: number;
  content: string;
  role: "target" | "source";
}

interface MergeProposalRecord {
  auditId: string;
  status: string;
  at: number;
  op: MergeOp;
  targetId: number;
  sourceIds: number[];
  deleteIds: number[];
  content: string;
  reason: string;
  confidence: number;
  scopeKey: string;
  scopeLabel: string;
  protectedIds: number[];
  involved: InvolvedMemory[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const OP_KEY: Record<MergeOp, string> = {
  overwrite: "settings:experiments.merge_op_overwrite",
  merge: "settings:experiments.merge_op_merge",
  complete: "settings:experiments.merge_op_complete",
};

function roleLabel(op: MergeOp, role: InvolvedMemory["role"], t: (key: string) => string): string {
  if (role === "target") return t("settings:experiments.merge_keep");
  if (op === "overwrite") return t("settings:experiments.merge_overwritten");
  if (op === "complete") return t("settings:experiments.merge_delete");
  return t("settings:experiments.merge_absorb");
}

export function MergeProposalPanel({
  enabled,
  dryRun,
  active,
}: {
  enabled: boolean;
  dryRun: boolean;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [proposals, setProposals] = React.useState<MergeProposalRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [planning, setPlanning] = React.useState(false);
  const [acting, setActing] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!active || !enabled) {
      setProposals([]);
      return;
    }
    setLoading(true);
    try {
      const response = await api.get<{ proposals: MergeProposalRecord[] }>(
        "memory/experiment/merge/proposals",
      );
      setProposals(Array.isArray(response.proposals) ? response.proposals : []);
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
      const result = await api.post<{ proposed: number; created: number }>(
        "memory/experiment/merge/plan",
        {},
      );
      toast.success(
        t("settings:experiments.merge_toast_planned", {
          proposed: result.proposed,
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

  const act = async (auditId: string, action: "apply" | "reject") => {
    setActing(`${action}:${auditId}`);
    try {
      await api.post(`memory/experiment/merge/${action}`, { auditId });
      toast.success(t(`settings:experiments.merge_toast_${action}`));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setActing(null);
    }
  };

  if (!active) return null;

  return (
    <SettingsGroup
      title={t("settings:experiments.merge_title")}
      description={t("settings:experiments.merge_desc")}
      action={
        <Button
          type="button"
          size="compact"
          variant="tertiary"
          disabled={!enabled || planning || loading}
          onClick={() => void plan()}
        >
          {planning ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {planning ? t("settings:experiments.merge_scanning") : t("settings:experiments.merge_scan")}
        </Button>
      }
    >
      {!enabled ? (
        <p className="pt-3 text-xs text-[var(--ds-text-tertiary)]">
          {t("settings:experiments.merge_disabled_hint")}
        </p>
      ) : proposals.length === 0 ? (
        <div className="pt-3">
          <SettingsEmpty>{t("settings:experiments.merge_empty")}</SettingsEmpty>
        </div>
      ) : (
        <SettingsRows className="pt-3">
          {proposals.map((proposal) => {
            const busy = acting?.endsWith(proposal.auditId) ?? false;
            return (
              <div key={proposal.auditId} className="space-y-1.5 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-on-surface)] px-2 py-0.5 font-medium text-[var(--ds-brand-primary)]">
                    {t(OP_KEY[proposal.op])}
                  </span>
                  <span className="text-[var(--ds-text-tertiary)]">{proposal.scopeLabel}</span>
                  <span className="ml-auto text-[var(--ds-text-tertiary)]">
                    {Math.round(proposal.confidence * 100)}%
                  </span>
                </div>
                <div className="space-y-1">
                  {proposal.involved.map((item) => (
                    <div key={`${proposal.auditId}-${item.id}-${item.role}`} className="flex gap-2 text-sm">
                      <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                        {roleLabel(proposal.op, item.role, t)}
                      </span>
                      <span className="min-w-0 text-[var(--ds-text-primary)]">{item.content}</span>
                    </div>
                  ))}
                  {proposal.op === "merge" && proposal.content ? (
                    <div className="flex gap-2 text-sm">
                      <span className="shrink-0 text-xs leading-5 text-[var(--ds-text-tertiary)]">
                        {t("settings:experiments.merge_new_content")}
                      </span>
                      <span className="min-w-0 font-medium text-[var(--ds-text-primary)]">
                        {proposal.content}
                      </span>
                    </div>
                  ) : null}
                </div>
                <p className="text-xs text-[var(--ds-text-secondary)]">{proposal.reason}</p>
                {dryRun ? (
                  <p className="text-xs text-[var(--ds-text-tertiary)]">
                    {t("settings:experiments.merge_dry_run_hint")}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(proposal.auditId, "reject")}
                  >
                    {t("settings:experiments.merge_reject")}
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="tertiary"
                    disabled={busy || dryRun}
                    onClick={() => void act(proposal.auditId, "apply")}
                  >
                    {acting === `apply:${proposal.auditId}` ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t("settings:experiments.merge_approve")}
                  </Button>
                </div>
              </div>
            );
          })}
        </SettingsRows>
      )}
    </SettingsGroup>
  );
}
