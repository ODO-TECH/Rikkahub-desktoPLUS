// components/settings/data/sync-options.tsx — 数据管理 › 「同步选项」首卡。
// 一份勾选同时决定本地备份、WebDAV / S3 云备份、Kelivo 兼容包与 Kelivo 导入的范围；
// 前 8 类是 Kelivo 的双向同步类别（也是实体级裁剪的依据），后 4 类是桌面端文件组。
// 持久化在 settings.backupScope，后端逐键布尔合并；Kelivo 兼容备份开关也在这里，打开即全局生效。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Checkbox } from "~/components/ui/checkbox";
import { Notice } from "~/components/ui/notice";
import { SettingsGroup, SettingsRows, SettingsSwitchRow } from "~/components/settings/shared";
import api from "~/services/api";
import { patchSettingsLocal } from "~/lib/settings-patch";
import { useSettingsStore } from "~/stores/app-store";
import { useBackupTaskStore } from "~/stores/backup-task-store";
import type { Settings } from "~/types";

type ScopeKey = keyof Settings["backupScope"];

const SYNC_OPTIONS: Array<{ key: ScopeKey; label: string; description: string }> = [
  // ── Kelivo 双向同步的 8 个实体类别 ──
  { key: "conversations", label: "settings:data.kelivo_conversations", description: "settings:data.kelivo_conversations_desc" },
  { key: "assistants", label: "settings:data.kelivo_assistants", description: "settings:data.kelivo_assistants_desc" },
  { key: "memories", label: "settings:data.kelivo_memories", description: "settings:data.kelivo_memories_desc" },
  { key: "models", label: "settings:data.kelivo_models", description: "settings:data.kelivo_models_desc" },
  { key: "worldBooks", label: "settings:data.kelivo_worldbooks", description: "settings:data.kelivo_worldbooks_desc" },
  { key: "promptInjections", label: "settings:data.kelivo_injections", description: "settings:data.kelivo_injections_desc" },
  { key: "quickMessages", label: "settings:data.kelivo_quick", description: "settings:data.kelivo_quick_desc" },
  { key: "searchServices", label: "settings:data.kelivo_search", description: "settings:data.kelivo_search_desc" },
  // ── 桌面端独有的文件组 ──
  { key: "attachments", label: "settings:data.backup_scope_attachments", description: "settings:data.backup_scope_attachments_desc" },
  { key: "skills", label: "settings:data.backup_scope_skills", description: "settings:data.backup_scope_skills_desc" },
  { key: "fonts", label: "settings:data.backup_scope_fonts", description: "settings:data.backup_scope_fonts_desc" },
  { key: "globalAgents", label: "settings:data.backup_scope_agents", description: "settings:data.backup_scope_agents_desc" },
];

export function SyncOptionsCard({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { exporting, importing } = useBackupTaskStore();
  const scope = settings.backupScope;
  const selectedCount = SYNC_OPTIONS.filter((option) => scope[option.key]).length;
  const exportEnabled = settings.exportKelivoBackup !== false;

  const toggleOption = (key: ScopeKey, checked: boolean) => {
    const previous = useSettingsStore.getState().settings?.backupScope ?? scope;
    // 乐观更新：服务端只回合并后的整组，失败再回滚。
    patchSettingsLocal({ backupScope: { ...previous, [key]: checked } });
    api
      .post<{ backupScope: Settings["backupScope"] }>("settings/backup-scope", { scope: { [key]: checked } })
      .then((result) => patchSettingsLocal({ backupScope: result.backupScope }))
      .catch((error) => {
        patchSettingsLocal({ backupScope: previous });
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      });
  };

  const toggleExport = (checked: boolean) => {
    const previous = useSettingsStore.getState().settings?.exportKelivoBackup ?? settings.exportKelivoBackup;
    patchSettingsLocal({ exportKelivoBackup: checked });
    api
      .post<{ exportKelivoBackup: boolean }>("settings/kelivo-sync", { exportKelivoBackup: checked })
      .then((result) => patchSettingsLocal({ exportKelivoBackup: result.exportKelivoBackup }))
      .catch((error) => {
        patchSettingsLocal({ exportKelivoBackup: previous });
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      });
  };

  return (
    <SettingsGroup
      title={t("settings:data.sync_options_title")}
      description={t("settings:data.sync_options_desc")}
      action={
        <span className="text-xs tabular-nums text-[var(--ds-text-tertiary)]">
          {t("settings:data.sync_options_selected", { count: selectedCount })}
        </span>
      }
    >
      <div className="mt-3 space-y-3">
        <Notice>{t("settings:data.sync_options_global")}</Notice>
        <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-2">
          <div className="grid gap-1.5 @xl:grid-cols-2">
            {SYNC_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-start gap-2.5 rounded-[var(--ds-radius-md)] px-2 py-1.5 transition-colors hover:bg-[var(--ds-on-surface)]"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={scope[option.key]}
                  onCheckedChange={(checked) => toggleOption(option.key, checked === true)}
                  disabled={exporting || importing}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-[var(--ds-text-primary)]">{t(option.label)}</span>
                  <span className="block text-xs leading-5 text-[var(--ds-text-tertiary)]">{t(option.description)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4">
          <SettingsRows>
            <SettingsSwitchRow
              label={t("settings:data.kelivo_export_toggle")}
              description={t("settings:data.kelivo_export_toggle_desc")}
              checked={exportEnabled}
              onCheckedChange={toggleExport}
              disabled={exporting || importing}
            />
          </SettingsRows>
        </div>
      </div>
    </SettingsGroup>
  );
}
