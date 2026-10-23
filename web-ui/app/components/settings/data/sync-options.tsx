// components/settings/data/sync-options.tsx — 数据管理 › 「同步选项」首卡。
// 「全部数据」是独立备份模式：默认开启，开启时一次备齐全部数据（上游桌面端的完整备份
// 逻辑），忽略逐项开关；关闭后才显示并按 12 个类别逐项备份。同一次选择同时决定本地备份、
// WebDAV / S3 云备份与 Kelivo 导入的范围。
// 模式持久化在 settings.backupAllData，逐项选择在 settings.backupScope，分别布尔合并。
// Kelivo 兼容备份默认关闭；它与完整备份不对齐，开启后只能按细项导出——「全部数据」被锁定。

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
  const exportEnabled = settings.exportKelivoBackup === true;
  // 「全部数据」是独立备份模式（上游桌面端的完整备份逻辑）：开启时忽略 12 个逐项开关，
  // 一次备齐全部数据；关闭后才按下面勾选的类别执行，逐项值原样保留供下次使用。
  // Kelivo 兼容包只能按细项生成，开启期间「全部数据」锁定关闭（后端也强制同款规则）。
  const lockedByKelivo = exportEnabled;
  const allData = !lockedByKelivo && settings.backupAllData !== false;
  const selectedCount = SYNC_OPTIONS.filter((option) => scope[option.key]).length;

  const toggleOption = (key: ScopeKey, checked: boolean) => {
    const previous = useSettingsStore.getState().settings?.backupScope ?? scope;
    const next = { ...previous, [key]: checked };
    // 乐观更新：服务端只回合并后的整组，失败再回滚。
    patchSettingsLocal({ backupScope: next });
    api
      .post<{ backupScope: Settings["backupScope"] }>("settings/backup-scope", { scope: { [key]: checked } })
      .then((result) => patchSettingsLocal({ backupScope: result.backupScope }))
      .catch((error) => {
        patchSettingsLocal({ backupScope: previous });
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      });
  };

  const toggleAllData = (checked: boolean) => {
    const previous = useSettingsStore.getState().settings?.backupAllData !== false;
    patchSettingsLocal({ backupAllData: checked });
    api
      .post<{ backupAllData?: boolean }>("settings/backup-scope", { allData: checked })
      .then((result) => {
        if (typeof result.backupAllData === "boolean") patchSettingsLocal({ backupAllData: result.backupAllData });
      })
      .catch((error) => {
        patchSettingsLocal({ backupAllData: previous });
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      });
  };

  const toggleExport = (checked: boolean) => {
    const current = useSettingsStore.getState().settings ?? settings;
    const previousExport = current.exportKelivoBackup === true;
    const previousAllData = current.backupAllData !== false;
    // 开启 Kelivo 兼容备份立即锁定为细项导出，避免「完整 zip + 半套 Kelivo 包」错位。
    patchSettingsLocal({
      exportKelivoBackup: checked,
      ...(checked ? { backupAllData: false } : {}),
    });
    api
      .post<{ exportKelivoBackup: boolean; backupAllData?: boolean }>("settings/kelivo-sync", { exportKelivoBackup: checked })
      .then((result) => {
        patchSettingsLocal({
          exportKelivoBackup: result.exportKelivoBackup,
          ...(typeof result.backupAllData === "boolean" ? { backupAllData: result.backupAllData } : {}),
        });
      })
      .catch((error) => {
        patchSettingsLocal({ exportKelivoBackup: previousExport, backupAllData: previousAllData });
        toast.error(error instanceof Error ? error.message : t("settings:common.save_failed"));
      });
  };

  return (
    <SettingsGroup
      title={t("settings:data.sync_options_title")}
      description={t("settings:data.sync_options_desc")}
      action={
        <span className="text-xs tabular-nums text-[var(--ds-text-tertiary)]">
          {allData
            ? t("settings:data.sync_options_full")
            : t("settings:data.sync_options_selected", { count: selectedCount })}
        </span>
      }
    >
      <div className="mt-3 space-y-3">
        <Notice>
          {lockedByKelivo
            ? t("settings:data.sync_options_kelivo_lock")
            : allData
              ? t("settings:data.sync_options_full_note")
              : t("settings:data.sync_options_global")}
        </Notice>
        <div className="rounded-[var(--ds-radius-md)] border border-[var(--ds-divider)] px-4 py-2">
          <label
            className={`flex items-start gap-2.5 rounded-[var(--ds-radius-md)] px-2 py-1.5 transition-colors ${
              lockedByKelivo ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-[var(--ds-on-surface)]"
            }`}
          >
            <Checkbox
              className="mt-0.5"
              checked={allData}
              onCheckedChange={(checked) => toggleAllData(checked === true)}
              disabled={exporting || importing || lockedByKelivo}
            />
            <span className="min-w-0">
              <span className="block text-sm text-[var(--ds-text-primary)]">{t("settings:data.sync_all")}</span>
              <span className="block text-xs leading-5 text-[var(--ds-text-tertiary)]">{t("settings:data.sync_all_desc")}</span>
            </span>
          </label>
          {allData ? null : (
            <div className="mt-1 grid gap-1.5 border-t border-[var(--ds-divider)] pt-2 @xl:grid-cols-2">
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
          )}
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
