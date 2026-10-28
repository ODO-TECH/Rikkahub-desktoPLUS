// api/health.ts — 存活探针(liveness),与启动就绪(readiness)分开。
// 进程能响应就返回 200；迁移进度仍由 startup 字段和 /api/startup/status 表达。
// Docker HEALTHCHECK 使用本端点，长迁移不能被误判成进程死亡。

import process from "node:process";
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
    // 前端「重启」要分辨后端归谁管:壳拉起的走壳协议(壳先停后端再拉起,并等受限
    // 沙盒的慢半拍重启);壳 attach 到的外挂后端(dev 实例/端口上的旧实例)下壳的
    // restart 是空操作,只能走后端自重启端点。pid 用于确认替代进程真的起来了。
    pid: process.pid,
    spawnedByShell: process.env.RIKKAHUB_SHELL === "webview2",
  });
}
