// components/settings/data/storage-overview.tsx — 数据管理 › 存储结构
// 把「对话和记忆到底存在哪」直接摊开：同一个 rikka_hub.db，WAL 模式，计数实时来自 SQL。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SettingsGroup, SettingsRow, SettingsRows } from "~/components/settings/shared";
import { appendWebAuthQuery } from "~/services/api";

interface StorageOverview {
  database: { path: string; bytes: number; walBytes: number; totalBytes: number };
  state: { path: string; bytes: number };
  conversations: { count: number; messageNodes: number; messages: number; ftsRows: number };
  memories: { total: number; global: number; assistant: number; pending: number };
  workspaces: number;
}

const countFormatter = new Intl.NumberFormat();

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function StorageOverviewCard() {
  const { t } = useTranslation();
  const [data, setData] = React.useState<StorageOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(appendWebAuthQuery("/api/data/storage"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as StorageOverview);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const count = (value: number) => countFormatter.format(value);

  return (
    <SettingsGroup
      title={t("settings:data.storage_title")}
      description={t("settings:data.storage_desc")}
      action={
        <Button variant="tertiary" size="compact" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("settings:data.storage_refresh")}
        </Button>
      }
    >
      {data ? (
        <SettingsRows className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
          <SettingsRow
            label={t("settings:data.storage_db")}
            description={<code className="break-all font-mono text-xs">{data.database.path}</code>}
            control={
              <span className="text-sm tabular-nums text-[var(--ds-text-secondary)]">
                {formatBytes(data.database.totalBytes)}
              </span>
            }
          />
          <SettingsRow
            label={t("settings:data.storage_conversations")}
            description={t("settings:data.storage_conversations_detail", {
              nodes: count(data.conversations.messageNodes),
              messages: count(data.conversations.messages),
            })}
            control={<span className="text-sm tabular-nums">{count(data.conversations.count)}</span>}
          />
          <SettingsRow
            label={t("settings:data.storage_memories")}
            description={t("settings:data.storage_memories_detail", {
              global: count(data.memories.global),
              assistant: count(data.memories.assistant),
              pending: count(data.memories.pending),
            })}
            control={<span className="text-sm tabular-nums">{count(data.memories.total)}</span>}
          />
          <SettingsRow
            label={t("settings:data.storage_workspaces")}
            control={<span className="text-sm tabular-nums">{count(data.workspaces)}</span>}
          />
          <SettingsRow
            label={t("settings:data.storage_state_json")}
            description={<code className="break-all font-mono text-xs">{data.state.path}</code>}
            control={
              <span className="text-sm tabular-nums text-[var(--ds-text-secondary)]">
                {formatBytes(data.state.bytes)}
              </span>
            }
          />
        </SettingsRows>
      ) : (
        <p className="mt-3 text-sm text-[var(--ds-text-secondary)]">
          {loading ? t("settings:data.storage_loading") : failed ? t("settings:data.storage_failed") : null}
        </p>
      )}
    </SettingsGroup>
  );
}
