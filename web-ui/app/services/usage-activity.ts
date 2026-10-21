// 使用时长活动信标(专题6;C3 复查:升级为前端权威计量)。
//
// 使用时长的口径是"用户实际在用",判据为窗口可见且聚焦——托盘常驻、后台标签页、
// 无头部署都不该计时。本模块权威计量真实聚焦时长:维护当前聚焦段起点,聚焦期间
// 每 1 分钟收割一次(把已聚焦毫秒数随信标上报并推进起点),失焦/隐藏瞬间收割尾段。
// 后端只做钳制累加,不再用"信标间隔≈活跃时长"的启发式——旧法突发首拍固定记 60s、
// ≤90s 失焦间隔全额计入,碎片化使用(频繁切窗)高估可达 2 倍。
//
// 信标纯 fire-and-forget:失败静默,不重试、不提示——统计信号永远不该打扰用户。
// 性能:全部开销是三个窗口事件里的 Date.now() 记账 + 聚焦期间每分钟一个回环微型
// POST,无失焦期轮询,较旧实现零新增常驻负担。
//
// 多窗口时同一时刻至多一个窗口聚焦,各自上报的聚焦段天然不重叠,总和≈墙钟时间。
// 应用直接退出时最后一个未满分钟的尾段会丢(轻微低估,方向安全);最小化到托盘走
// visibilitychange 隐藏路径,尾段被正常收割。
import api from "./api";

const BEACON_INTERVAL_MS = 60 * 1000;

let started = false;
let timer: number | null = null;
let activeSince: number | null = null;

function isWindowActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** 收割当前聚焦段:返回段起点以来的毫秒数,并把起点推进到现在。未聚焦时返回 0。 */
function harvestFocusedMs(): number {
  if (activeSince === null) return 0;
  const now = Date.now();
  const ms = Math.max(0, now - activeSince);
  activeSince = now;
  return ms;
}

function flushBeacon(): void {
  const ms = Math.round(harvestFocusedMs());
  if (ms <= 0) return;
  void api.post("activity", { ms }).catch(() => {});
}

/** 定时拍。D8(复查)硬化:焦点事件万一丢失(OS 级异常),此处自愈——丢弃本段
 *  (方向安全的低估,至多一拍)并停表,否则未聚焦时间会被计入后续每一拍。 */
function onBeaconTick(): void {
  if (!isWindowActive()) {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    activeSince = null;
    return;
  }
  flushBeacon();
}

function syncBeaconLoop(): void {
  if (isWindowActive()) {
    if (timer !== null) return;
    activeSince = Date.now();
    timer = window.setInterval(onBeaconTick, BEACON_INTERVAL_MS);
  } else if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
    flushBeacon(); // 失焦瞬间收割尾段(activeSince 此刻仍指向段内)
    activeSince = null;
  }
}

/** 建立活动信标(幂等)。跑满页面生命周期,不提供停止句柄。 */
export function startUsageActivityBeacon(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  window.addEventListener("focus", syncBeaconLoop);
  window.addEventListener("blur", syncBeaconLoop);
  document.addEventListener("visibilitychange", syncBeaconLoop);
  syncBeaconLoop();
}
