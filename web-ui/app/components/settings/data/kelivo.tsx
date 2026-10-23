// components/settings/data/kelivo.tsx — Kelivo 双向同步（云同步区的一张卡）。
// 同步范围不在这里选：统一由数据管理首卡「同步选项」决定——「全部数据」开启时取全部 8 类，
// 关闭时取 settings.backupScope 的 8 个实体类别，拼 ?kelivo= 参数；「导出 Kelivo 兼容备份」
// 开关也在那张卡里。本卡只保留导入动作，避免同一组开关在两处各存一份。

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { appendWebAuthQuery } from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import { patchBackupTask, useBackupTaskStore } from "~/stores/backup-task-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { Settings } from "~/types";
import { SettingsGroup } from "~/components/settings/shared";

/** Kelivo 的 8 个同步类别，同时也是 backupScope 的实体键。 */
const KELIVO_SCOPE_KEYS = [
  "conversations",
  "assistants",
  "memories",
  "models",
  "worldBooks",
  "promptInjections",
  "quickMessages",
  "searchServices",
] as const;

function optionsToParam(scope: Settings["backupScope"]): string {
  const keys = KELIVO_SCOPE_KEYS.filter((key) => scope[key]);
  return keys.length > 0 ? keys.join(",") : "none";
}

export function KelivoSyncCard({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { exporting, importing, importPhase, importProgress } = useBackupTaskStore();
  const scope = settings.backupScope;
  // 「全部数据」模式下 Kelivo 导入同样按完整范围执行，逐项开关只在关闭模式后生效。
  const allData = settings.backupAllData !== false;
  const selectedCount = allData
    ? KELIVO_SCOPE_KEYS.length
    : KELIVO_SCOPE_KEYS.filter((key) => scope[key]).length;

  const importKelivo = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (selectedCount === 0) {
      toast.error(t("settings:data.kelivo_none_selected"));
      return;
    }
    if (!(await confirmDialog({ title: t("settings:data.kelivo_import_confirm"), danger: true }))) return;

    patchBackupTask({ importing: true, importPhase: "uploading", importProgress: 0 });
    try {
      const result = await new Promise<{
        status: string;
        source?: string;
        summary?: string[];
        warnings?: string[];
        settings: Settings;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const query = `kelivo=${encodeURIComponent(allData ? KELIVO_SCOPE_KEYS.join(",") : optionsToParam(scope))}`;
        xhr.open("POST", appendWebAuthQuery(`/api/data/import?${query}`));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) patchBackupTask({ importProgress: Math.round((e.loaded / e.total) * 100) });
        };
        xhr.upload.onload = () => patchBackupTask({ importPhase: "processing" });
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error("Invalid server response"));
            }
          } else {
            let message = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText) as { error?: string };
              if (parsed.error) message = parsed.error;
            } catch { /* keep status */ }
            reject(new Error(message));
          }
        };
        xhr.onerror = () => reject(new Error(t("settings:data.import_network_error")));
        xhr.timeout = 0;
        xhr.send(file);
      });
      // 导入会整体替换设置：用本地返回的 settings 而非当前 store，避免拿旧对象覆盖。
      useSettingsStore.getState().setSettings(result.settings);
      const lines = (result.summary ?? []).filter(Boolean);
      toast.success(lines.length
        ? t("settings:data.import_kelivo_lines", { lines: lines.join("；") })
        : t("settings:data.import_done"));
      for (const warning of result.warnings ?? []) toast.warning(warning, { duration: 12000 });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings:data.import_failed"));
    } finally {
      patchBackupTask({ importing: false, importPhase: "idle", importProgress: 0 });
    }
  };

  return (
    <SettingsGroup
      title={t("settings:data.kelivo_title")}
      description={`${t("settings:data.kelivo_desc")} ${t("settings:data.kelivo_selected_count", { count: selectedCount })}`}
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="tertiary"
          size="compact"
          onClick={() => inputRef.current?.click()}
          disabled={exporting || importing}
        >
          {importing ? <Loader2 className="animate-spin" /> : <Upload />}
          {importing
            ? importPhase === "uploading"
              ? t("settings:data.kelivo_importing", { percent: importProgress })
              : t("settings:data.extracting")
            : t("settings:data.kelivo_import_button")}
        </Button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="application/zip,.zip"
          onChange={(event) => void importKelivo(event)}
        />
      </div>
    </SettingsGroup>
  );
}
