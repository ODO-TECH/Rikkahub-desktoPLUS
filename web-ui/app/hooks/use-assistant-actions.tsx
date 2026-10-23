// hooks/use-assistant-actions.tsx — 助手的复制 / 删除流程,设置页与侧栏助手选择器共用。
// 记忆感知的确认(有记忆时先问「同时复制 / 同时删除」)与防复活时序只写一遍:
// 两处入口走同一条代码路径,不会出现「设置页问记忆、侧栏闷头删」的分叉。
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { copyItemName } from "~/lib/copy-name";
import { patchSettingsLocal, upsertById } from "~/lib/settings-patch";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import { confirmDialog } from "~/stores/confirm-store";
import type { AssistantProfile } from "~/types";

interface AssistantActionsOptions {
  /** 复制成功。设置页据此选中副本;侧栏不传——复制不该顺手切走当前助手。 */
  onCopied?: (assistant: AssistantProfile) => void;
  /**
   * 删除确认后、发 DELETE 之前。设置页在这里丢弃待保存脏编辑并等在飞保存收尾,
   * 防止 DELETE 与迟到 POST 乱序把删掉的助手写回来(复审 F1 防复活)。
   */
  beforeDelete?: (assistantId: string) => Promise<void> | void;
  /** 删除成功,nextId 为服务端回退后的当前助手。设置页据此移动本地编辑选中。 */
  onDeleted?: (assistantId: string, nextId: string) => void;
}

export interface AssistantActions {
  startCopyAssistant: (assistantId: string) => Promise<void>;
  removeAssistantById: (assistantId: string) => Promise<void>;
  /** 「同时复制记忆」询问框;由调用方渲染在本页(内部自带 Dialog,可与其它弹层共存)。 */
  copyDialog: React.ReactNode;
}

export function useAssistantActions(options: AssistantActionsOptions = {}): AssistantActions {
  const { onCopied, beforeDelete, onDeleted } = options;
  const { t } = useTranslation();
  const [cloneTarget, setCloneTarget] = React.useState<AssistantProfile | null>(null);
  const [cloneMemoryCount, setCloneMemoryCount] = React.useState(0);
  const [cloneWithMemories, setCloneWithMemories] = React.useState(false);

  // 助手列表一律取 store 最新快照:侧栏与设置页可能同时开着,调用方渲染闭包里的
  // settings 可能已落后于刚复制/刚删除的那一轮。
  const currentAssistants = () => useSettingsStore.getState().settings?.assistants ?? [];

  const copyAssistantById = async (targetId: string, copyMemories: boolean) => {
    const assistants = currentAssistants();
    const target = assistants.find((item) => item.id === targetId);
    if (!target) return;
    const name = copyItemName(
      target.name || t("settings:assistants.default_name"),
      new Set(assistants.map((item) => item.name || t("settings:assistants.default_name"))),
    );
    try {
      const result = await api.post<{ assistant: AssistantProfile }>("settings/assistant/copy", {
        id: targetId,
        name,
        copyMemories,
      });
      patchSettingsLocal((current) => ({
        assistants: upsertById(current.assistants, result.assistant),
      }));
      onCopied?.(result.assistant);
      toast.success(t("settings:assistants.copied", { name }));
    } catch (error) {
      toast.error((error as Error).message || t("settings:assistants.copy_failed"));
    }
  };

  const startCopyAssistant = async (targetId: string) => {
    const target = currentAssistants().find((item) => item.id === targetId);
    if (!target) return;
    let memoryCount = 0;
    try {
      const result = await api.get<{ memories: unknown[] }>(`memory/assistant/${encodeURIComponent(targetId)}`);
      memoryCount = result.memories?.length ?? 0;
    } catch { /* 记忆查询失败按 0 处理(与删除路径同款兜底) */ }
    if (memoryCount > 0) {
      setCloneMemoryCount(memoryCount);
      setCloneWithMemories(false);
      setCloneTarget(target);
      return;
    }
    await copyAssistantById(targetId, false);
  };

  const removeAssistantById = async (targetId: string) => {
    const assistants = currentAssistants();
    // 至少保留一个助手:菜单项按列表长度隐藏,这里再兜一次并发/过期点击。
    if (assistants.length <= 1) return;
    const target = assistants.find((item) => item.id === targetId);
    if (!target) return;
    const nameLabel = target.name || t("settings:assistants.default_name");
    // M4:先查该助手记忆数,有记忆则让用户选"同时删除 / 保留为孤儿"(默认保留,防误删助手连带丢记忆)
    let memoryCount = 0;
    try {
      const result = await api.get<{ memories: unknown[] }>(`memory/assistant/${encodeURIComponent(targetId)}`);
      memoryCount = result.memories?.length ?? 0;
    } catch { /* 记忆查询失败按 0 处理 */ }
    let deleteMemories = false;
    if (memoryCount > 0) {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm_with_memories", { name: nameLabel, n: memoryCount }), danger: true }))) return;
      // 第二步:确定=同时删记忆,取消=保留为孤儿(记忆页可管理)
      deleteMemories = await confirmDialog({
        title: t("settings:assistants.delete_memories_title", { n: memoryCount }),
        description: t("settings:assistants.delete_memories_desc"),
        confirmLabel: t("settings:assistants.delete_memories_label"),
        cancelLabel: t("settings:assistants.keep_memories_label"),
        danger: true,
      });
    } else {
      if (!(await confirmDialog({ title: t("settings:assistants.delete_confirm", { name: nameLabel }), danger: true }))) return;
    }
    await beforeDelete?.(targetId);
    try {
      await api.delete(`settings/assistant/${encodeURIComponent(targetId)}${deleteMemories ? "?deleteMemories=true" : ""}`);
    } catch (error) {
      toast.error((error as Error).message || t("settings:common.save_failed"));
      return;
    }
    // 与服务端同口径回退当前助手,别让 store 里留着已删除的 id(侧栏会短暂显示空选中)。
    let nextId = "";
    patchSettingsLocal((current) => {
      const remaining = current.assistants.filter((item) => item.id !== targetId);
      nextId = remaining[0]?.id ?? "";
      return {
        assistants: remaining,
        assistantId: current.assistantId === targetId ? nextId : current.assistantId,
      };
    });
    onDeleted?.(targetId, nextId);
    toast.success(t("settings:assistants.deleted"));
  };

  // 复制助手的「同时复制记忆」询问:不是单纯确认/取消(confirmDialog 只有 boolean),
  // 要带可勾选项,故用 Dialog(对齐 APP 的带 Checkbox 确认框)。默认不勾——记忆是
  // 高个人化资产,多副本各自演化,保守起步。
  const copyDialog = (
    <Dialog open={cloneTarget !== null} onOpenChange={(open) => !open && setCloneTarget(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings:assistants.copy_title")}</DialogTitle>
          <DialogDescription>
            {t("settings:assistants.copy_desc", {
              name: cloneTarget?.name || t("settings:assistants.default_name"),
              n: cloneMemoryCount,
            })}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-3 rounded-[var(--ds-radius-sm)] px-1 py-1.5 text-sm">
          <Checkbox
            checked={cloneWithMemories}
            onCheckedChange={(checked) => setCloneWithMemories(checked === true)}
          />
          {t("settings:assistants.copy_with_memories")}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCloneTarget(null)}>
            {t("common:confirm_dialog.cancel")}
          </Button>
          <Button
            onClick={() => {
              const target = cloneTarget;
              setCloneTarget(null);
              if (target) void copyAssistantById(target.id, cloneWithMemories);
            }}
          >
            {t("common:confirm_dialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { startCopyAssistant, removeAssistantById, copyDialog };
}
