// api/health.ts — 存活探针(liveness),与启动就绪(readiness)分开。
// 进程能响应就返回 200；迁移进度仍由 startup 字段和 /api/startup/status 表达。
// Docker HEALTHCHECK 使用本端点，长迁移不能被误判成进程死亡。

import { getStartupStatus } from "../foundation/startup-gate";
import { APP_VERSION } from "../updates/index";
import { json } from "./request";

export function healthResponse(): Response {
  const startup = getStartupStatus();
  return json({
    ok: true,
    version: APP_VERSION,
    ready: startup.ready,
    failed: startup.failed,
    phase: startup.phase,
  });
}
