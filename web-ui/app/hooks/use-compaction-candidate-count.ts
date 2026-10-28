// 压缩摘要卡上的「待确认记忆候选」计数。
// 只在实验开关开启且拿到切点时请求一次；失败静默归零，不打扰阅读。
import * as React from "react";

import api from "~/services/api";

export function useCompactionCandidateCount(
  conversationId: string | null | undefined,
  cutMessageId: string | null | undefined,
  enabled: boolean,
): number {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    if (!enabled || !conversationId || !cutMessageId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.get<{ count?: number }>(
          `memory/experiment/compaction-candidates?conversationId=${encodeURIComponent(conversationId)}&cutMessageId=${encodeURIComponent(cutMessageId)}`,
        );
        if (!cancelled) setCount(Math.max(0, Number(response?.count ?? 0)));
      } catch {
        if (!cancelled) setCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, cutMessageId, enabled]);
  return count;
}
