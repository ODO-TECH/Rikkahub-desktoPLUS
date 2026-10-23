// media-generation/resume.ts — 启动时恢复未完成的媒体任务
// 有 providerTaskId 的继续轮询（上限到创建后 24h）；没有的标失败（应用在提交完成前退出）。
// 0.0.3 只回填「产出」列表，不回写工具卡（见设计书 B6.5）。

import { state } from "../persistence/json-store";
import { resumeMediaGeneration } from "./service";
import { saveMediaState, updateMediaRecord } from "./storage";

export function resumePendingMediaTasks(): void {
  const pending = state.generatedMedia.filter(
    (record) => record.status === "queued" || record.status === "running",
  );
  if (pending.length === 0) return;
  console.log(`[media-generation] 恢复 ${pending.length} 个未完成任务`);
  void (async () => {
    for (const record of pending) {
      try {
        await resumeMediaGeneration(record);
      } catch (err) {
        console.warn("[media-generation] 恢复任务失败", record.id, err);
        updateMediaRecord(record.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        saveMediaState();
      }
    }
  })();
}
