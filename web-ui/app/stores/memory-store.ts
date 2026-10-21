import { useEffect } from "react";
import { create } from "zustand";

import { onAppEvent } from "~/services/app-events";
import type { MemorySnapshot } from "~/types";

interface MemoryStoreState {
  snapshot: MemorySnapshot | null;
  setSnapshot: (snapshot: MemorySnapshot | null) => void;
}

/** 记忆运行时 store:持有 memory SSE 推送的完整快照。设置「记忆」板块 + 会话页徽章都从此读。 */
export const useMemoryStore = create<MemoryStoreState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

/** 订阅 memory 事件(根组件调用一次)。走单一 /api/events 通道(连接预算纪律,见
 *  services/app-events.ts):连接即推完整 snapshot,之后任何记忆/pending 变化都触发推送。 */
export function useMemorySubscription() {
  const setSnapshot = useMemoryStore((s) => s.setSnapshot);

  useEffect(() => onAppEvent("memory", setSnapshot), [setSnapshot]);
}
