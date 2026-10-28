import { useEffect } from "react";
import { create } from "zustand";

import api from "~/services/api";
import { onAppEvent, type MemoryIndexEvent } from "~/services/app-events";

// 与服务端 pc-server/memory/vector-index.ts 的 MemoryVectorStatus 同形。
// 进度事件只载 phase/done/total；计数、模型、维度一律以 status 端点现算值为准。

export interface MemoryVectorStatus {
  enabled: boolean;
  configured: boolean;
  needsRebuild: boolean;
  modelKey: string | null;
  modelName: string | null;
  dim: number | null;
  total: number;
  indexed: number;
  stale: number;
  running: boolean;
  progress: MemoryIndexEvent;
  lastError: string | null;
  indexedAt: number | null;
  rerank: { configured: boolean; modelName: string | null };
}

/** 会话侧召回状态(pc-server/memory/recall.ts readRecallInfo)。 */
export interface RecallInfo {
  enabled: boolean;
  active: boolean;
  selected: number;
  total: number;
  reranked: boolean;
  builtAt: number | null;
}

/** 设置页「测试召回」的一行(pc-server/memory/recall.ts RecallPreviewItem)。 */
export interface RecallPreviewItem {
  id: number;
  content: string;
  lex: number;
  cos: number;
  score: number;
  hasVector: boolean;
  reranked: boolean;
}

interface MemoryVectorStoreState {
  status: MemoryVectorStatus | null;
  /** 拉取失败静默:设置卡自己显示「状态不可用」,不弹 toast。 */
  refresh: () => Promise<void>;
  applyIndexEvent: (event: MemoryIndexEvent) => void;
}

let inflight: Promise<void> | null = null;

export const useMemoryVectorStore = create<MemoryVectorStoreState>((set, get) => ({
  status: null,
  refresh: () => {
    if (inflight) return inflight;
    inflight = api
      .get<MemoryVectorStatus>("memory/vector/status")
      .then((status) => set({ status }))
      .catch(() => {})
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  applyIndexEvent: (event) => {
    const current = get().status;
    if (current) {
      set({ status: { ...current, running: event.phase === "running", progress: event } });
    } else if (event.phase === "running") {
      // 在别的窗口点了索引:先拿一次完整状态,进度再按事件增量走。
      void get().refresh();
    }
    // 终态事件后索引计数已变(含取消保留的部分),以 SQL 现算值覆盖。
    if (event.phase !== "running") void get().refresh();
  },
}));

/** 订阅 memory-index 事件(挂卡片的组件调用一次)。shared worker 的通道常驻,反复挂载不新建连接。 */
export function useMemoryVectorSubscription() {
  const applyIndexEvent = useMemoryVectorStore((s) => s.applyIndexEvent);
  useEffect(() => onAppEvent("memory-index", applyIndexEvent), [applyIndexEvent]);
}
