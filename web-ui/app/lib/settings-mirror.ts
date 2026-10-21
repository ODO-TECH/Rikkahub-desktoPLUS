// 专题1(异常闪动)A 族修复:settings 本地只读镜像(stale-while-revalidate)。
//
// 病根:settings 唯一来源是 /api/events SSE 快照,挂载后异步到达;首帧一律渲染
// 内置默认值(默认头像/昵称、无助手、无模型名),快照到达后跳变 —— 启动闪动的主源。
// 修法:store 初值同步读上次会话的镜像,首帧即"上次的真实值";快照到达后覆盖。
//
// 【纪律 — 改动前必读】
// 1. 镜像是只读缓存:权威永远是服务端快照,镜像值绝不主动回写服务端。
// 2. 必须字节保真存整份 Settings,禁止裁剪字段(哪怕出于体积/敏感性考虑):
//    设置页(routes/settings.tsx)把 store 值作为编辑底稿,若镜像残缺,用户在快照
//    到达前保存会把残缺对象写回服务端 —— 数据丢失级事故(如清空 provider 密钥)。
// 3. 敏感性评估:桌面端 WebView 的 localStorage 与服务端 state.json 同机同权限,
//    无新增暴露;Web 反代模式下 localStorage 本就持有 auth token(见 services/api),
//    镜像不扩大攻击面。
// 4. 陈旧窗口:多浏览器窗口并开时,首帧可能画到别的窗口改过前的旧值,快照到达
//    (约百毫秒)后静默校正 —— 已与用户确认接受此代价。
import type { Settings } from "~/types";

const SETTINGS_MIRROR_KEY = "rikkahub.settings.mirror.v1";

export function readSettingsMirror(): Settings | null {
  // SPA 模式下构建期也会求值模块(生成壳 HTML),Node 环境无 localStorage。
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SETTINGS_MIRROR_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // 轻量形状校验:挡住旧版本/损坏数据,不做深校验(权威快照随后覆盖)。
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Settings).assistants) ||
      !Array.isArray((parsed as Settings).providers)
    ) {
      return null;
    }
    return parsed as Settings;
  } catch {
    return null;
  }
}

export function writeSettingsMirror(settings: Settings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify(settings));
  } catch {
    // 配额超限/隐私模式:镜像是尽力而为的缓存,失败静默(仅退化为旧行为)。
  }
}
