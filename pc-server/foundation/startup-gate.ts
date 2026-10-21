// foundation/startup-gate.ts — 启动就绪闸门(全面审查 R1-1)
// 服务端现在"先绑端口、再跑迁移":Bun.serve 先启动,bootstrap(状态装载+一次性迁移链)
// 在后台异步执行,期间 fetch 入口按本模块的就绪位把 /api 挡成 503,前端据
// /api/startup/status 渲染迁移进度页。引导失败不退进程(release 壳下 stderr 不可见,
// exit 只会留下一扇死窗口),markStartupFailed 让前端把原因呈现给用户。

export interface StartupStatus {
  ready: boolean;
  /** 引导抛出未捕获异常。迁移链内部的可预期失败均已自捕获降级,走到这说明是未知故障。 */
  failed: boolean;
  /** 阶段键(前端翻译):starting | load-state | migrate-conversations | file-dedup | finalize | ready */
  phase: string;
  /** current/total 均为 0 表示该阶段无计数语义。 */
  current: number;
  total: number;
  /** failed 时的用户可读信息。 */
  error: string;
}

const status: StartupStatus = { ready: false, failed: false, phase: "starting", current: 0, total: 0, error: "" };

export function setStartupPhase(phase: string, current = 0, total = 0): void {
  if (status.ready || status.failed) return;
  status.phase = phase;
  status.current = current;
  status.total = total;
}

export function markStartupReady(): void {
  status.ready = true;
  status.failed = false;
  status.phase = "ready";
  status.current = 0;
  status.total = 0;
  status.error = "";
}

export function markStartupFailed(message: string): void {
  if (status.ready) return;
  status.failed = true;
  status.error = message;
}

export function isStartupReady(): boolean {
  return status.ready;
}

export function getStartupStatus(): StartupStatus {
  return { ...status };
}

/** 仅测试用:模块级单例状态在用例间需要复位。 */
export function resetStartupGateForTests(): void {
  status.ready = false;
  status.failed = false;
  status.phase = "starting";
  status.current = 0;
  status.total = 0;
  status.error = "";
}
