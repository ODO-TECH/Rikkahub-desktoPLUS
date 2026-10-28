// app-config/index.ts — 应用级 UI/主题/快捷键/端口/JWT 配置切片
// 纪律：只依赖 foundation/types/settings，不依赖 server.ts 或全局 state。

import { saveState, state } from "../persistence/json-store";
import { broadcastList, broadcastSettings } from "../api/sse";
import { applyEffectiveProxy, resolveEffectiveProxy } from "../foundation/net";
import { reconcileMcpHealth } from "../tools/mcp-health";
// 与 im/registry 之间是刻意保留的环:registry 只在函数体内用 updateSettings(配对、换绑
// 会话时),模块求值期不读它的任何导出,所以 ESM 提升足以让两边都拿到绑定。放在这里是
// 唯一正确的位置——updateSettings 是 settings 的唯一写入口,IM 适配器必须"配置一变就追平",
// 而不该由十几个 handler 各自记得调一次。
import { reconcileImAdapters } from "../im/registry";
import type { AppConfig, Settings } from "../foundation/types/settings";

export type { AppConfig } from "../foundation/types/settings";

export function selectAppConfig(settings: Settings): AppConfig {
  return {
    dynamicColor: settings.dynamicColor,
    themeId: settings.themeId,
    developerMode: settings.developerMode,
    displaySetting: settings.displaySetting,
    preferredPort: settings.preferredPort,
    sandboxRestricted: settings.sandboxRestricted,
    workspaceLastPermissionPreset: settings.workspaceLastPermissionPreset,
    keybindings: settings.keybindings,
    webServerJwtEnabled: settings.webServerJwtEnabled,
  };
}

export function patchAppConfig(settings: Settings, patch: Partial<AppConfig>): Settings {
  return { ...settings, ...patch };
}

export function updateSettings(next: Settings) {
  // 代理配置变化时记一条日志。实际生效由 fetch 拦截器 per-request 现读 resolveEffectiveProxy 保证,
  // 无需手动刷新 env / 探测 —— 配置变化下一次请求自动跟上。
  const prevProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  state.settings = next;
  saveState();
  broadcastSettings();
  broadcastList();
  // MCP 健康 Supervisor(7.2):配置/助手选中变化后重评探活集合(新启用的服务器立即探活,
  // 禁用/取消选中的清出状态面)。reconcile 幂等且只在集合变化时探活,普通设置保存零开销。
  reconcileMcpHealth();
  // 外部接入(IM):开关、凭据、助手选中状态都可能在本次保存里变化,reconcile 幂等且同步
  // 返回(真正的启停挂在后台),所以未涉及 imAccess 的普通保存零开销。
  reconcileImAdapters();
  const newProxyUrl = resolveEffectiveProxy(state.settings.proxyConfig).url;
  if (newProxyUrl !== prevProxyUrl) {
    applyEffectiveProxy(state.settings.proxyConfig);
  }
}
