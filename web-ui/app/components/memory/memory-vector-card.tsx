// 记忆语义索引卡片(特性 C)。挂在「设置 › 记忆」的写入策略之后。
// 模型不在这里选:嵌入/重排都读「设置 › 模型 › 场景模型」的全局档位,本卡只显示当前用的是哪个,
// 未配置时给一个跳转按钮。索引任务在后台单飞,进度走 memory-index 事件,计数由 status 现算。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ExternalLink, Loader2, Play, RefreshCw, Search, Trash2 } from "lucide-react";

import api from "~/services/api";
import { useMemoryStore } from "~/stores";
import { confirmDialog } from "~/stores/confirm-store";
import {
  useMemoryVectorStore,
  useMemoryVectorSubscription,
  type MemoryVectorStatus,
  type RecallPreviewItem,
} from "~/stores/memory-vector-store";
import type { MemorySnapshot, MemoryVectorSettings, Settings } from "~/types";
import {
  SettingsFold,
  SettingsGroup,
  SettingsRow,
  SettingsRows,
  SettingsSwitchRow,
} from "~/components/settings/shared";
import { SettingsLink } from "~/components/settings/settings-link";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { cn } from "~/lib/utils";

const DEFAULT_SETTINGS: MemoryVectorSettings = {
  enabled: false,
  autoIndex: true,
  topK: 20,
  minMemories: 24,
  expandNeighbors: true,
  rerankEnabled: true,
  rerankTopN: 40,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 设计稿口径:粗略 token 估算 = 字符数 / 2。断网/无快照时返回 null,确认文案省略这一段。 */
function estimateTokens(snapshot: MemorySnapshot | null): number | null {
  if (!snapshot) return null;
  let chars = 0;
  for (const memory of snapshot.globalMemories) chars += memory.content.length;
  for (const group of snapshot.assistantMemories) {
    for (const memory of group.memories) chars += memory.content.length;
  }
  return Math.ceil(chars / 2);
}

function formatIndexedAt(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 失焦/回车提交的数字输入:避免每敲一个数字就发一次设置请求。 */
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

function StatusLine({ status }: { status: MemoryVectorStatus }) {
  const { t } = useTranslation();
  const parts: string[] = [
    t("settings:memory.vector_status_counts", { indexed: status.indexed, total: status.total }),
    status.modelName
      ? t("settings:memory.vector_status_model", { model: status.modelName })
      : t("settings:memory.vector_model_unset"),
  ];
  if (status.dim != null) parts.push(t("settings:memory.vector_status_dim", { dim: status.dim }));
  if (status.indexedAt != null) {
    parts.push(t("settings:memory.vector_status_time", { time: formatIndexedAt(status.indexedAt) }));
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--ds-text-secondary)]">
      <span>{parts.join(" · ")}</span>
      {status.stale > 0 ? (
        <span className="text-[var(--ds-text-tertiary)]">
          {t("settings:memory.vector_status_stale", { n: status.stale })}
        </span>
      ) : null}
      {status.needsRebuild ? (
        <span className="font-medium text-[var(--ds-danger)]">
          {t("settings:memory.vector_needs_rebuild")}
        </span>
      ) : null}
    </div>
  );
}

export function MemoryVectorCard({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const status = useMemoryVectorStore((s) => s.status);
  const refresh = useMemoryVectorStore((s) => s.refresh);
  const snapshot = useMemoryStore((s) => s.snapshot);
  useMemoryVectorSubscription();

  const mv = settings.memoryVectorSettings ?? DEFAULT_SETTINGS;
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<RecallPreviewItem[] | null>(null);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = async (partial: Partial<MemoryVectorSettings>) => {
    const previous = settings.memoryVectorSettings ?? DEFAULT_SETTINGS;
    onSettings({ ...settings, memoryVectorSettings: { ...previous, ...partial } });
    try {
      const response = await api.post<{ memoryVectorSettings: MemoryVectorSettings }>(
        "settings/memory-vector",
        partial,
      );
      onSettings({ ...settings, memoryVectorSettings: response.memoryVectorSettings });
      void refresh();
    } catch (err) {
      onSettings({ ...settings, memoryVectorSettings: previous });
      toast.error(errorText(err));
    }
  };

  const toggleEnabled = async (checked: boolean) => {
    if (checked) {
      const tokens = estimateTokens(snapshot);
      const ok = await confirmDialog({
        title: t("settings:memory.vector_enable_confirm_title"),
        description: t("settings:memory.vector_enable_confirm_desc", {
          n: status?.total ?? 0,
          tokens: tokens == null ? "?" : tokens.toLocaleString(),
        }),
        confirmLabel: t("settings:memory.vector_enable_confirm_action"),
      });
      if (!ok) return;
    }
    await patch({ enabled: checked });
  };

  const startIndex = async (mode: "rebuild" | "missing") => {
    if (mode === "rebuild") {
      const tokens = estimateTokens(snapshot);
      const ok = await confirmDialog({
        title: t("settings:memory.vector_rebuild_confirm_title"),
        description: t("settings:memory.vector_rebuild_confirm_desc", {
          n: status?.total ?? 0,
          tokens: tokens == null ? "?" : tokens.toLocaleString(),
        }),
      });
      if (!ok) return;
    }
    try {
      await api.post("memory/vector/index", { mode });
      toast.success(t("settings:memory.vector_started"));
      await refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const cancelIndex = async () => {
    try {
      await api.post("memory/vector/cancel");
      toast.success(t("settings:memory.vector_cancel_requested"));
      await refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const clearIndex = async () => {
    const ok = await confirmDialog({
      title: t("settings:memory.vector_clear_confirm_title"),
      description: t("settings:memory.vector_clear_confirm_desc"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post("memory/vector/clear");
      toast.success(t("settings:memory.vector_clear_done"));
      setResults(null);
      await refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  const runPreview = async () => {
    const text = query.trim();
    if (!text || searching) return;
    setSearching(true);
    try {
      setResults(await api.post<RecallPreviewItem[]>("memory/vector/search", { query: text, limit: 10 }));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSearching(false);
    }
  };

  const configured = status?.configured ?? false;
  const busy = status?.running ?? false;
  const total = status?.total ?? 0;
  const stale = status?.stale ?? 0;
  const progress = status?.progress;
  const progressTotal = progress?.total ?? 0;

  return (
    <SettingsGroup
      title={t("settings:memory.vector_title")}
      description={t("settings:memory.vector_subtitle")}
    >
      <SettingsRows>
        <SettingsSwitchRow
          label={t("settings:memory.vector_enable")}
          description={t("settings:memory.vector_enable_desc")}
          checked={mv.enabled}
          disabled={!mv.enabled && !configured}
          onCheckedChange={(checked) => void toggleEnabled(checked)}
        />
        <SettingsRow
          label={t("settings:memory.vector_embedding_model")}
          description={t("settings:memory.vector_embedding_model_desc")}
          control={
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "max-w-52 truncate text-sm",
                  configured
                    ? "text-[var(--ds-text-primary)]"
                    : "text-[var(--ds-text-tertiary)]",
                )}
              >
                {status?.modelName ?? t("settings:memory.vector_model_unset")}
              </span>
              <Button asChild variant="tertiary" size="compact">
                <SettingsLink search="?section=models&sub=scenes">
                  <ExternalLink />
                  {t("settings:memory.vector_open_scenes")}
                </SettingsLink>
              </Button>
            </div>
          }
        />
      </SettingsRows>

      <div className="space-y-2 pt-3">
        {!status ? (
          <div className="text-xs text-[var(--ds-text-tertiary)]">
            {t("settings:memory.vector_status_loading")}
          </div>
        ) : (
          <>
            <StatusLine status={status} />
            {!configured ? (
              <p className="text-xs text-[var(--ds-text-secondary)]">
                {t("settings:memory.vector_not_configured")}
              </p>
            ) : null}
            {status.lastError && !status.running ? (
              <p className="break-words text-xs text-[var(--ds-danger)]">
                {t("settings:memory.vector_last_error", { message: status.lastError })}
              </p>
            ) : null}

            {status.running ? (
              <div className="space-y-1.5 rounded-[var(--ds-radius-md)] bg-[var(--ds-on-surface)] p-3">
                <Progress
                  value={progressTotal > 0 ? (Math.min(progress?.done ?? 0, progressTotal) / progressTotal) * 100 : null}
                />
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--ds-text-secondary)]">
                  <span>
                    {t("settings:memory.vector_progress", {
                      done: progress?.done ?? 0,
                      total: progressTotal,
                    })}
                  </span>
                  <Button variant="ghost" size="compact" onClick={() => void cancelIndex()}>
                    {t("settings:memory.vector_running_cancel")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="tertiary"
                size="compact"
                disabled={!configured || busy || total === 0}
                onClick={() => void startIndex("rebuild")}
              >
                <RefreshCw />
                {t("settings:memory.vector_action_rebuild")}
              </Button>
              <Button
                variant="tertiary"
                size="compact"
                disabled={!mv.enabled || !configured || busy || stale === 0}
                onClick={() => void startIndex("missing")}
              >
                <Play />
                {t("settings:memory.vector_action_missing")}
              </Button>
              <Button
                variant="ghost"
                size="compact"
                className="text-[var(--ds-danger)]"
                disabled={busy || (status.indexed === 0 && status.dim == null)}
                onClick={() => void clearIndex()}
              >
                <Trash2 />
                {t("settings:memory.vector_action_clear")}
              </Button>
              <Button
                variant="ghost"
                size="compact"
                disabled={total === 0}
                onClick={() => setPreviewOpen((open) => !open)}
              >
                <Search />
                {previewOpen
                  ? t("settings:memory.vector_action_preview_hide")
                  : t("settings:memory.vector_action_preview")}
              </Button>
            </div>

            {previewOpen ? (
              <div className="space-y-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] p-3">
                <div className="flex gap-2">
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void runPreview();
                      }
                    }}
                    placeholder={t("settings:memory.vector_preview_placeholder")}
                    aria-label={t("settings:memory.vector_preview_placeholder")}
                  />
                  <Button
                    variant="tertiary"
                    size="compact"
                    className="shrink-0"
                    disabled={searching || query.trim() === ""}
                    onClick={() => void runPreview()}
                  >
                    {searching ? <Loader2 className="animate-spin" /> : <Search />}
                    {t("settings:memory.vector_preview_run")}
                  </Button>
                </div>
                <p className="text-xs text-[var(--ds-text-tertiary)]">
                  {t("settings:memory.vector_preview_hint")}
                </p>
                {results != null && results.length === 0 ? (
                  <p className="py-2 text-xs text-[var(--ds-text-secondary)]">
                    {t("settings:memory.vector_preview_empty")}
                  </p>
                ) : null}
                {results?.map((item) => (
                  <div
                    key={item.id}
                    className="space-y-1 border-t border-[var(--ds-divider)] pt-2 text-xs first:border-t-0 first:pt-0"
                  >
                    <div className="line-clamp-2 whitespace-pre-wrap break-words text-[var(--ds-text-primary)]">
                      {item.content}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--ds-text-tertiary)]">
                      <span>{t("settings:memory.vector_preview_lex", { score: item.lex.toFixed(2) })}</span>
                      <span>{t("settings:memory.vector_preview_cos", { score: item.cos.toFixed(2) })}</span>
                      <span>{t("settings:memory.vector_preview_score", { score: item.score.toFixed(2) })}</span>
                      {!item.hasVector ? (
                        <span className="text-[var(--ds-danger)]">
                          {t("settings:memory.vector_preview_no_vector")}
                        </span>
                      ) : null}
                      {item.reranked ? (
                        <Badge variant="secondary">{t("settings:memory.vector_preview_reranked")}</Badge>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="pt-3">
        <SettingsFold
          id="memory-vector-advanced"
          title={t("settings:common.advanced")}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
        >
          <SettingsRows>
            <SettingsSwitchRow
              label={t("settings:memory.vector_auto_index")}
              description={t("settings:memory.vector_auto_index_desc")}
              checked={mv.autoIndex}
              onCheckedChange={(checked) => void patch({ autoIndex: checked })}
            />
            <SettingsRow
              label={t("settings:memory.vector_top_k")}
              description={t("settings:memory.vector_top_k_desc")}
              control={
                <NumberField
                  value={mv.topK}
                  min={5}
                  max={50}
                  ariaLabel={t("settings:memory.vector_top_k")}
                  onCommit={(value) => void patch({ topK: value })}
                />
              }
            />
            <SettingsRow
              label={t("settings:memory.vector_min_memories")}
              description={t("settings:memory.vector_min_memories_desc")}
              control={
                <NumberField
                  value={mv.minMemories}
                  min={0}
                  max={200}
                  ariaLabel={t("settings:memory.vector_min_memories")}
                  onCommit={(value) => void patch({ minMemories: value })}
                />
              }
            />
            <SettingsSwitchRow
              label={t("settings:memory.vector_expand_neighbors")}
              description={t("settings:memory.vector_expand_neighbors_desc")}
              checked={mv.expandNeighbors}
              onCheckedChange={(checked) => void patch({ expandNeighbors: checked })}
            />
            <SettingsSwitchRow
              label={t("settings:memory.vector_rerank_enable")}
              description={
                status?.rerank.configured
                  ? t("settings:memory.vector_rerank_model", { model: status.rerank.modelName ?? "" })
                  : t("settings:memory.vector_rerank_unconfigured")
              }
              checked={mv.rerankEnabled}
              disabled={!status?.rerank.configured}
              onCheckedChange={(checked) => void patch({ rerankEnabled: checked })}
            />
            <SettingsRow
              label={t("settings:memory.vector_rerank_top_n")}
              description={t("settings:memory.vector_rerank_top_n_desc")}
              control={
                <NumberField
                  value={mv.rerankTopN}
                  min={10}
                  max={100}
                  disabled={!mv.rerankEnabled || !status?.rerank.configured}
                  ariaLabel={t("settings:memory.vector_rerank_top_n")}
                  onCommit={(value) => void patch({ rerankTopN: value })}
                />
              }
            />
          </SettingsRows>
        </SettingsFold>
      </div>
    </SettingsGroup>
  );
}
