// 全面审查 R1-1 回归测试:启动韧性配套件。
// ① peekPreferredPortIn——Bun.serve 现在先于 loadState 绑端口,选端口靠对 state.json 的
//    轻量窥探,任何异常输入都必须安全回落 null(默认 8080),绝不能抛错拖死启动。
// ② startup-gate——就绪闸门的状态机:阶段回填、就绪冻结、失败保留原因。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { peekPreferredPortIn } from "./json-store";
import {
  getStartupStatus,
  isStartupReady,
  markStartupFailed,
  markStartupReady,
  resetStartupGateForTests,
  setStartupPhase,
} from "../foundation/startup-gate";

describe("peekPreferredPortIn(R1-1 绑端口前的轻量端口窥探)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rikka-peek-"));
  const statePath = join(dir, "state.json");
  afterEach(() => rmSync(statePath, { force: true }));

  test("正常 state.json 读出端口", () => {
    writeFileSync(statePath, JSON.stringify({ settings: { preferredPort: 9090 } }));
    expect(peekPreferredPortIn(statePath)).toBe(9090);
  });

  test("文件不存在 / JSON 损坏 → null(走默认端口,不抛错)", () => {
    expect(peekPreferredPortIn(join(dir, "missing.json"))).toBeNull();
    writeFileSync(statePath, "{ 坏掉的 json");
    expect(peekPreferredPortIn(statePath)).toBeNull();
  });

  test("字段缺失或非法(越界/非整数/类型错)→ null", () => {
    writeFileSync(statePath, JSON.stringify({ settings: {} }));
    expect(peekPreferredPortIn(statePath)).toBeNull();
    writeFileSync(statePath, JSON.stringify({ settings: { preferredPort: 70000 } }));
    expect(peekPreferredPortIn(statePath)).toBeNull();
    writeFileSync(statePath, JSON.stringify({ settings: { preferredPort: "8080" } }));
    expect(peekPreferredPortIn(statePath)).toBeNull();
  });
});

describe("startup-gate(R1-1 启动就绪闸门状态机)", () => {
  afterEach(() => resetStartupGateForTests());

  test("阶段与进度回填,就绪后冻结为 ready", () => {
    expect(isStartupReady()).toBe(false);
    setStartupPhase("migrate-conversations", 200, 1000);
    expect(getStartupStatus()).toMatchObject({ ready: false, phase: "migrate-conversations", current: 200, total: 1000 });
    markStartupReady();
    expect(isStartupReady()).toBe(true);
    // 就绪后阶段回填不再生效(迟到的迁移进度回调不能把状态拉回未就绪外观)
    setStartupPhase("file-dedup", 1, 2);
    expect(getStartupStatus()).toMatchObject({ ready: true, phase: "ready" });
  });

  test("失败保留原因供前端呈现,且不再被阶段回填覆盖", () => {
    setStartupPhase("load-state");
    markStartupFailed("迁移炸了");
    expect(getStartupStatus()).toMatchObject({ ready: false, failed: true, error: "迁移炸了", phase: "load-state" });
    setStartupPhase("finalize");
    expect(getStartupStatus().phase).toBe("load-state");
  });
});
