// shutdown.test.ts — 停机编排的顺序与幂等锁：HTTP 端点与信号路径共用同一实现，
// 顺序错(socket 未停就刷盘/退出)或重复执行都会在这里现形。
import { describe, expect, test } from "bun:test";
import { createGracefulShutdown, type ShutdownHooks } from "./shutdown";

function recorder(overrides: Partial<ShutdownHooks> = {}) {
  const calls: string[] = [];
  const hooks: ShutdownHooks = {
    stopIngress: (closeActive) => { calls.push(`ingress:${closeActive}`); },
    stopProducers: () => { calls.push("producers"); },
    killDetachedChildren: () => { calls.push("detached"); },
    closeStdioAndSsh: () => { calls.push("stdio-ssh"); },
    flushAll: async () => { calls.push("flush"); },
    exit: (code) => { calls.push(`exit:${code}`); },
    ...overrides,
  };
  return { calls, hooks };
}

describe("createGracefulShutdown", () => {
  test("信号路径按固定顺序执行:停接收→停生产者→清 detached→关 stdio/SSH→刷盘→退出", async () => {
    const { calls, hooks } = recorder();
    const shutdown = createGracefulShutdown(hooks);
    await shutdown.run();
    expect(calls).toEqual(["ingress:true", "producers", "detached", "stdio-ssh", "flush", "exit:0"]);
    expect(shutdown.started()).toBe(true);
  });

  test("HTTP 触发保留在途连接,flush 完成后延迟退出让 200 落地", async () => {
    const { calls, hooks } = recorder();
    const shutdown = createGracefulShutdown(hooks);
    await shutdown.run({ fromHttp: true });
    expect(calls).toEqual(["ingress:false", "producers", "detached", "stdio-ssh", "flush"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls.at(-1)).toBe("exit:0");
  });

  test("并发与重复触发共享同一次关停:每一步只跑一次、只退出一次", async () => {
    let producers = 0;
    let flushed = 0;
    const { calls, hooks } = recorder({
      stopProducers: async () => {
        producers += 1;
        calls.push("producers");
      },
      flushAll: async () => {
        flushed += 1;
        calls.push("flush");
      },
    });
    const shutdown = createGracefulShutdown(hooks);
    const first = shutdown.run();
    const second = shutdown.run();
    expect(second).toBe(first);
    await first;
    await shutdown.run();
    expect(producers).toBe(1);
    expect(flushed).toBe(1);
    expect(calls.filter((call) => call === "exit:0")).toHaveLength(1);
  });

  test("单步失败只记警告,后续步骤照常执行", async () => {
    const { calls, hooks } = recorder({
      stopProducers: () => {
        calls.push("producers");
        throw new Error("boom");
      },
    });
    const shutdown = createGracefulShutdown(hooks);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await shutdown.run();
    } finally {
      console.warn = warn;
    }
    expect(calls).toEqual(["ingress:true", "producers", "detached", "stdio-ssh", "flush", "exit:0"]);
    expect(warnings.some((line) => line.includes("停止状态生产者失败"))).toBe(true);
  });
});
