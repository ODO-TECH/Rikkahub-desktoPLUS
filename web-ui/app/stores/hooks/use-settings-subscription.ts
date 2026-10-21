import { useEffect } from "react";

import { onAppEvent } from "~/services/app-events";
import { useSettingsStore } from "~/stores/app-store";

/**
 * 订阅 settings 事件(根组件调用一次)。走单一 /api/events 通道(连接预算纪律,
 * 见 services/app-events.ts):连接即推完整快照,重连自动补偿,初始 GET 已裁撤。
 */
export function useSettingsSubscription() {
  const setSettings = useSettingsStore((state) => state.setSettings);

  useEffect(() => onAppEvent("settings", setSettings), [setSettings]);
}
