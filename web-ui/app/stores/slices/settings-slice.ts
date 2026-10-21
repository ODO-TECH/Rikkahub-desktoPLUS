import type { StateCreator } from "zustand";

import { readSettingsMirror, writeSettingsMirror } from "~/lib/settings-mirror";
import type { AppStoreState, SettingsSlice } from "~/stores/slices/types";

export const createSettingsSlice: StateCreator<AppStoreState, [], [], SettingsSlice> = (set) => ({
  // A 族修复:初值同步读本地镜像(上次会话的真实值),首帧即正确的头像/昵称/助手/
  // 模型名;服务端 SSE 快照到达后经 setSettings 覆盖 —— 权威永远在服务端。
  // 纪律与风险评估见 lib/settings-mirror.ts 顶部注释。
  settings: readSettingsMirror(),
  setSettings: (settings) => {
    // 写穿透:setSettings 是全应用唯一写入点(SSE 快照/设置页保存/手动刷新都经此),
    // 在此落镜像即可保证镜像始终等于最后已知的权威值。镜像永不回流服务端。
    writeSettingsMirror(settings);
    set({ settings });
  },
});
