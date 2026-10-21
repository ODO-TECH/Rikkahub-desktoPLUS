// 应用错误通道 store(P2-1 批2):订阅错误事件,按 severity 路由 toast,
// 并持有错误中心快照(批3 在日志页展示)。
// 契约:连接快照只入 store 不弹 toast(重连不重复打扰);增量 app_error 才路由 toast。
// 风暴抑制在后端做(30s 同 domain+message 合并,窗口内不重复广播),前端无需再去抖。
import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";

import api from "~/services/api";
import { onAppEvent } from "~/services/app-events";
import i18n from "~/i18n";
import type { AppErrorDto } from "~/types";

interface AppErrorsStoreState {
  errors: AppErrorDto[];
  setErrors: (errors: AppErrorDto[]) => void;
  pushError: (entry: AppErrorDto) => void;
  clearErrors: () => Promise<void>;
  /**
   * 前端自身 catch 到的错误走同一中心(不回传后端,仅本地聚合)。
   * R6-4:复用后端"同 domain+message 30s 合并计数"语义——窗口内只累加计数不新增条目。
   * 返回是否为新条目(false = 已合并,调用方据此跳过重复 toast,避免循环失败风暴)。
   */
  reportLocalError: (entry: AppErrorDto) => boolean;
}

/** 与后端错误中心的风暴抑制窗口(observability/app-errors)对齐。 */
const LOCAL_MERGE_WINDOW_MS = 30_000;

export const useAppErrorsStore = create<AppErrorsStoreState>((set) => ({
  errors: [],
  setErrors: (errors) => set({ errors }),
  pushError: (entry) => set((s) => ({ errors: [entry, ...s.errors].slice(0, 200) })),
  clearErrors: async () => {
    set({ errors: [] });
    try {
      await api.post("errors/clear", {});
    } catch {
      // 清空是尽力而为;后端不可达时本地已清,重连快照会再同步
    }
  },
  reportLocalError: (entry) => {
    let merged = false;
    set((s) => {
      // 只看最新一条同 domain+message(列表新在前);窗口锚定在该条目的 at,
      // 不随合并滑动——持续风暴每 30s 至多产生一条新条目 + 一次 toast。
      const index = s.errors.findIndex(
        (item) => item.domain === entry.domain && item.message === entry.message,
      );
      const existing = index >= 0 ? s.errors[index] : undefined;
      if (existing && entry.at - existing.at < LOCAL_MERGE_WINDOW_MS) {
        merged = true;
        const errors = [...s.errors];
        errors[index] = { ...existing, count: existing.count + entry.count };
        return { errors };
      }
      return { errors: [entry, ...s.errors].slice(0, 200) };
    });
    return !merged;
  },
}));

/** 错误条目的用户可见文案:有 code 按当前界面语言渲染(切语言即时生效),
 *  无 code(前端本地兜底/后端动态文本)或文案键缺失时回退服务端 message 原文。 */
export function appErrorText(entry: AppErrorDto): string {
  if (!entry.code) return entry.message;
  return i18n.t(`settings:app_errors.codes.${entry.code}`, {
    ...entry.params,
    defaultValue: entry.message,
  });
}

function routeToast(entry: AppErrorDto) {
  const text = appErrorText(entry);
  const suffix = entry.count > 1 ? ` (×${entry.count})` : "";
  if (entry.severity === "error") toast.error(text + suffix);
  else if (entry.severity === "warn") toast.warning(text + suffix);
  // info 级只进错误中心,不打扰
}

/** 订阅应用错误事件(根组件调用一次)。走单一 /api/events 通道(连接预算纪律,见
 *  services/app-events.ts)。快照事件通道内会重放,app_error 增量不重放(防重复 toast)。 */
export function useAppErrorsSubscription() {
  const setErrors = useAppErrorsStore((s) => s.setErrors);
  const pushError = useAppErrorsStore((s) => s.pushError);

  useEffect(() => {
    const offSnapshot = onAppEvent("app_errors_snapshot", (data) => setErrors(data.errors));
    const offPush = onAppEvent("app_error", (data) => {
      pushError(data.error);
      routeToast(data.error);
    });
    return () => {
      offSnapshot();
      offPush();
    };
  }, [setErrors, pushError]);
}
