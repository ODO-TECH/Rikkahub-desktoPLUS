// tools/subagent.test.ts — subagent_dispatch 编排内核单测(mock child runner,无 pi 依赖)
// 覆盖:模式/数量校验、并发上限、预算阀、中止传播、路径锁、单任务失败隔离、model_id 透传、深度剔除。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultSubagentConfig, type SubagentConfig } from "../foundation/types/settings/subagent-config";
import {
  isToolAllowedForSubagent,
  registerSubagentChildRunner,
  resetSubagentChildRunnerForTests,
  runSubagentDispatch,
  SubagentPathLock,
  type SubagentChildRequest,
} from "./subagent";

function settings(patch: Partial<SubagentConfig> = {}): SubagentConfig {
  return { ...defaultSubagentConfig(), enabled: true, ...patch };
}

beforeEach(() => {
  resetSubagentChildRunnerForTests();
});

afterEach(() => {
  resetSubagentChildRunnerForTests();
});

describe("subagent_dispatch 参数校验", () => {
  test("single 模式恰好 1 个任务;多于 1 个直接拒绝", async () => {
    registerSubagentChildRunner(async () => ({ text: "ok" }));
    await expect(
      runSubagentDispatch(
        { mode: "single", tasks: [{ title: "a", prompt: "p1" }, { title: "b", prompt: "p2" }] },
        settings(),
      ),
    ).rejects.toThrow(/exactly 1 task/);
  });

  test("空任务、未知模式、超 maxTasksPerCall 均拒绝", async () => {
    registerSubagentChildRunner(async () => ({ text: "ok" }));
    await expect(runSubagentDispatch({ mode: "parallel", tasks: [] }, settings())).rejects.toThrow(/at least one task/);
    await expect(
      runSubagentDispatch({ mode: "chain" as never, tasks: [{ title: "a", prompt: "p" }] }, settings()),
    ).rejects.toThrow(/Invalid subagent mode/);
    await expect(
      runSubagentDispatch(
        { mode: "parallel", tasks: Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, prompt: "p" })) },
        settings({ maxTasksPerCall: 3 }),
      ),
    ).rejects.toThrow(/Too many tasks/);
  });

  test("未注册 child runner → 明确报错(装配未完成)", async () => {
    await expect(
      runSubagentDispatch({ mode: "single", tasks: [{ title: "a", prompt: "p" }] }, settings()),
    ).rejects.toThrow(/runner not registered/);
  });
});

describe("subagent_dispatch 执行编排", () => {
  test("single:摘要含逐任务状态与 token 用量", async () => {
    registerSubagentChildRunner(async () => ({ text: "  finished the job  ", tokensUsed: 42 }));
    const summary = await runSubagentDispatch(
      { mode: "single", tasks: [{ title: "Alpha", prompt: "do alpha" }] },
      settings({ tokenBudget: 200_000 }),
    );
    expect(summary).toContain("1/1 completed");
    expect(summary).toContain("42 tokens used of 200000 budget");
    expect(summary).toContain("[OK] Alpha");
    expect(summary).toContain("finished the job");
  });

  test("model_id 透传为 modelId;路径锁实例随请求下发", async () => {
    const seen: SubagentChildRequest[] = [];
    registerSubagentChildRunner(async (request) => {
      seen.push(request);
      return { text: "ok" };
    });
    await runSubagentDispatch(
      { mode: "single", tasks: [{ title: "a", prompt: "p", model_id: "cheap-model" }] },
      settings(),
    );
    expect(seen[0]?.modelId).toBe("cheap-model");
    expect(seen[0]?.writeLock).toBeInstanceOf(SubagentPathLock);
  });

  test("并发上限生效:4 个任务、上限 2,同时在跑的不超过 2", async () => {
    let active = 0;
    let peak = 0;
    registerSubagentChildRunner(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { text: "ok" };
    });
    const tasks = Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, prompt: "p" }));
    await runSubagentDispatch({ mode: "parallel", tasks }, settings({ maxConcurrency: 2 }));
    expect(peak).toBe(2);
  });

  test("预算在启动前判:首任务耗尽预算后,后续任务标记 skipped", async () => {
    registerSubagentChildRunner(async () => ({ text: "ok", tokensUsed: 100 }));
    const tasks = [
      { title: "first", prompt: "p1" },
      { title: "second", prompt: "p2" },
    ];
    const summary = await runSubagentDispatch({ mode: "parallel", tasks }, settings({ maxConcurrency: 1, tokenBudget: 100 }));
    expect(summary).toContain("1/2 completed");
    expect(summary).toContain("1 skipped (token budget exhausted)");
    expect(summary).toContain("[FAILED] second\nskipped: token budget exhausted");
  });

  test("单任务失败只标段,其余任务照常完成", async () => {
    registerSubagentChildRunner(async (request) => {
      if (request.title === "bad") throw new Error("model exploded");
      return { text: "good output" };
    });
    const summary = await runSubagentDispatch(
      {
        mode: "parallel",
        tasks: [
          { title: "good", prompt: "p1" },
          { title: "bad", prompt: "p2" },
        ],
      },
      settings(),
    );
    expect(summary).toContain("1/2 completed, 1 failed");
    expect(summary).toContain("[OK] good\ngood output");
    expect(summary).toContain("[FAILED] bad\nfailed: model exploded");
  });

  test("任务缺 prompt 只标该段失败,不影响合法任务", async () => {
    registerSubagentChildRunner(async () => ({ text: "ok" }));
    const summary = await runSubagentDispatch(
      {
        mode: "parallel",
        tasks: [
          { title: "fine", prompt: "p" },
          { title: "broken", prompt: "   " },
        ],
      },
      settings(),
    );
    expect(summary).toContain("1/2 completed");
    expect(summary).toContain("task #2: prompt is required");
  });

  test("中止:预中止立即拒绝,进行中被中止级联取消", async () => {
    registerSubagentChildRunner(async () => ({ text: "ok" }));
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runSubagentDispatch(
        { mode: "single", tasks: [{ title: "a", prompt: "p" }] },
        settings(),
        { signal: aborted.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    registerSubagentChildRunner(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")));
        }),
    );
    const controller = new AbortController();
    const running = runSubagentDispatch(
      { mode: "single", tasks: [{ title: "a", prompt: "p" }] },
      settings(),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  test("摘要段超长截断,防挤爆父上下文", async () => {
    registerSubagentChildRunner(async () => ({ text: "x".repeat(5_000) }));
    const summary = await runSubagentDispatch(
      { mode: "single", tasks: [{ title: "long", prompt: "p" }] },
      settings(),
    );
    expect(summary).toContain("...(truncated 1000 chars)");
  });
});

describe("SubagentPathLock 同路径串行", () => {
  test("同键按到达顺序串行,后一个等前一个释放", async () => {
    const lock = new SubagentPathLock();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.run("a.ts", async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = lock.run("a.ts", async () => {
      events.push("second-start");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("不同键互不阻塞", async () => {
    const lock = new SubagentPathLock();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.run("a.ts", async () => {
      events.push("a-start");
      await gate;
    });
    const second = lock.run("b.ts", async () => {
      events.push("b-start");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContain("b-start");
    release();
    await Promise.all([first, second]);
  });

  test("前一个任务抛错不阻塞同键后来者", async () => {
    const lock = new SubagentPathLock();
    const order: string[] = [];
    await expect(
      lock.run("a.ts", async () => {
        order.push("failed");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await lock.run("a.ts", async () => {
      order.push("after");
    });
    expect(order).toEqual(["failed", "after"]);
  });
});

describe("子面工具裁剪", () => {
  test("恒拒 subagent_dispatch(深度锁 1 层)", () => {
    expect(isToolAllowedForSubagent("subagent_dispatch", ["subagent_dispatch" as never])).toBe(false);
  });

  test("只放行 allowedTools 内的工具", () => {
    const allowed = settings().allowedTools;
    expect(isToolAllowedForSubagent("read", allowed)).toBe(true);
    expect(isToolAllowedForSubagent("edit", allowed)).toBe(true);
    expect(isToolAllowedForSubagent("write", allowed)).toBe(true);
    expect(isToolAllowedForSubagent("bash", allowed)).toBe(false);
    expect(isToolAllowedForSubagent("mcp__x__y", allowed)).toBe(false);
  });
});
