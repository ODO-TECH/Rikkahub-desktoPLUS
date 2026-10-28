import { afterEach, describe, expect, test } from "bun:test";

import { markStartupFailed, markStartupReady, resetStartupGateForTests, setStartupPhase } from "../foundation/startup-gate";
import { healthResponse } from "./health";

describe("/api/health 存活探针", () => {
  afterEach(() => resetStartupGateForTests());

  test("启动迁移中仍返回 200,并如实标记 ready=false", async () => {
    setStartupPhase("migrate-conversations", 1, 2);
    const response = healthResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      ready: false,
      failed: false,
      phase: "migrate-conversations",
    });
  });

  test("引导失败仍是存活状态,失败原因继续由 startup 状态表达", async () => {
    markStartupFailed("迁移失败");
    const response = healthResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ready: false, failed: true, phase: "starting" });
  });

  test("就绪后返回 ready=true,并带 pid/spawnedByShell 供重启分流", async () => {
    markStartupReady();
    const response = healthResponse();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, ready: true, phase: "ready", pid: process.pid });
    expect(body.spawnedByShell).toBe(false);
  });
});
