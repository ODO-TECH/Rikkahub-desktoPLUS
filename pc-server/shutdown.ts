// shutdown.ts — HTTP /api/app/shutdown 与 SIGINT/SIGTERM/SIGHUP 共用的停机编排。
// 固定顺序：停接收入口 → 停状态生产者 → 清理 detached 子进程 → 关 stdio MCP/SSH
// → 刷 settings/conversations/memory → checkpoint + 释放数据目录锁 → 退出。
// 幂等：重复/并发触发共享同一次关停；单步失败只记警告，不阻断后续步骤。

export interface ShutdownHooks {
  /** closeActiveConnections=false 时保留在途连接，让端点触发的 200 先写回壳。 */
  stopIngress(closeActiveConnections: boolean): void;
  /** 停止 IM 长连接与进行中的生成等状态生产者。 */
  stopProducers(): Promise<void> | void;
  killDetachedChildren(): void;
  closeStdioAndSsh(): void;
  /** 刷 settings/conversations/memory + WAL checkpoint + 释放数据目录锁。 */
  flushAll(): Promise<void>;
  exit(code: number): void;
}

export interface ShutdownOptions {
  /** HTTP 端点触发：保留当前响应连接，flush 完成后延迟退出让 200 落地。 */
  fromHttp?: boolean;
}

export interface GracefulShutdown {
  /** 幂等；返回的 Promise 在 flush 完成时 resolve（HTTP 触发的退出定时器可能仍在等）。 */
  run(options?: ShutdownOptions): Promise<void>;
  started(): boolean;
}

/** 200 响应写出后给壳侧留的收尾窗口（原端点行为，勿缩）。 */
const HTTP_EXIT_DELAY_MS = 100;

function warnStep(step: string, err: unknown): void {
  console.warn(`[shutdown] ${step}失败`, err);
}

export function createGracefulShutdown(hooks: ShutdownHooks): GracefulShutdown {
  let pending: Promise<void> | null = null;

  const run = (options: ShutdownOptions = {}): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      try {
        hooks.stopIngress(!options.fromHttp);
      } catch (err) {
        warnStep("停止接收入口", err);
      }
      try {
        await hooks.stopProducers();
      } catch (err) {
        warnStep("停止状态生产者", err);
      }
      try {
        hooks.killDetachedChildren();
      } catch (err) {
        warnStep("清理 detached 子进程", err);
      }
      try {
        hooks.closeStdioAndSsh();
      } catch (err) {
        warnStep("关闭 stdio MCP/SSH", err);
      }
      try {
        await hooks.flushAll();
      } catch (err) {
        warnStep("刷新持久化状态", err);
      }
      if (options.fromHttp) {
        setTimeout(() => hooks.exit(0), HTTP_EXIT_DELAY_MS);
      } else {
        hooks.exit(0);
      }
    })();
    return pending;
  };

  return { run, started: () => pending != null };
}
