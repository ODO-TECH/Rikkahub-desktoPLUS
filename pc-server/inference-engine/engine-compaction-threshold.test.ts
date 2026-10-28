// inference-engine/engine-compaction-threshold.test.ts — 自动压缩阈值与钉住判定的纯函数契约
//
// 阶段三/四的判定全部收在 engine-compaction(引擎中性单源):
//   - 阈值 = contextWindow − 16384,严格大于才触发(与前端告警条同口径,也与 pi 的
//     shouldCompact 语义一致);窗口未知/过小一律不猜、不触发。
//   - 钉住识别与"切点前钉住集"的选取:只认 pinned 注解,只取切点之前的消息。

import { describe, expect, test } from "bun:test";

import { message } from "../foundation/utils";
import {
  COMPACTION_RESERVE_TOKENS,
  compactionThresholdFor,
  isPinnedMessage,
  mergeCompactionSummary,
  pinnedMessagesBefore,
  shouldAutoCompact,
} from "./engine-compaction";

describe("自动压缩阈值(阶段三)", () => {
  test("阈值 = 窗口 − 16384,严格大于才触发(等于阈值仍是安全区)", () => {
    expect(COMPACTION_RESERVE_TOKENS).toBe(16384);
    expect(compactionThresholdFor(32768)).toBe(16384);
    expect(shouldAutoCompact(16384, 32768)).toBe(false);
    expect(shouldAutoCompact(16385, 32768)).toBe(true);
    expect(shouldAutoCompact(0, 32768)).toBe(false);
  });

  test("窗口未知或小于等于保留区 → 不触发(不猜窗口)", () => {
    expect(compactionThresholdFor(null)).toBeNull();
    expect(compactionThresholdFor(undefined)).toBeNull();
    expect(compactionThresholdFor(16384)).toBeNull();
    expect(compactionThresholdFor(16383)).toBeNull();
    expect(compactionThresholdFor(0)).toBeNull();
    expect(shouldAutoCompact(1_000_000, null)).toBe(false);
    expect(shouldAutoCompact(1_000_000, 8000)).toBe(false);
  });

  test("非有限窗口不触发", () => {
    expect(compactionThresholdFor(Number.NaN)).toBeNull();
    expect(compactionThresholdFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("钉住消息判定(阶段四)", () => {
  test("只认 pinned 注解;其它注解/空注解都不算", () => {
    expect(isPinnedMessage({ annotations: [{ type: "pinned" }] })).toBe(true);
    expect(isPinnedMessage({ annotations: [{ type: "url_citation", url: "https://x" }] })).toBe(false);
    expect(isPinnedMessage({ annotations: [] })).toBe(false);
    expect(isPinnedMessage({ annotations: null })).toBe(false);
    expect(isPinnedMessage({})).toBe(false);
  });

  test("pinnedMessagesBefore:只取切点之前、只取钉住的;切点缺失/为首条返回空", () => {
    const pinned = message("USER", [{ type: "text", text: "A" }]);
    pinned.annotations = [{ type: "pinned" }];
    const plain = message("USER", [{ type: "text", text: "B" }]);
    const pinnedAfterCut = message("ASSISTANT", [{ type: "text", text: "C" }]);
    pinnedAfterCut.annotations = [{ type: "pinned" }];

    const history = [pinned, plain, pinnedAfterCut];
    // 切点在第三条:之前的钉住消息只有第一条;切点自身(即使钉住)不算"之前"。
    expect(pinnedMessagesBefore(history, pinnedAfterCut.id)).toEqual([pinned]);
    // 切点不在历史(陈旧记录/消息被删)→ 没有可注入的旧历史。
    expect(pinnedMessagesBefore(history, "missing")).toEqual([]);
    // 切点为首条:之前没有历史。
    expect(pinnedMessagesBefore(history, pinned.id)).toEqual([]);
  });
});

describe("链式摘要合并(复述去重)", () => {
  test("正常情况:上一版在前,本次在后,空行分隔", () => {
    expect(mergeCompactionSummary("旧摘要", "新摘要")).toBe("旧摘要\n\n新摘要");
    expect(mergeCompactionSummary("", "新摘要")).toBe("新摘要");
    expect(mergeCompactionSummary("旧摘要", "")).toBe("旧摘要");
  });

  test("模型复述同一段摘要:只留一份,不随压缩次数堆副本", () => {
    const same = "[前 8 轮对话摘要]\n上下文压缩采用非破坏式记录。";
    expect(mergeCompactionSummary(same, same)).toBe(same);
    expect(mergeCompactionSummary(`${same}\n\n${same}`, same)).toBe(`${same}\n\n${same}`);
  });

  test("本次摘要已包含上一版(整段长文本):用本次,不重复拼接旧内容", () => {
    const oldFact = "旧事实：安卓导出必须剥离 pinned 注解与 engineCompactions 压缩记录。";
    expect(mergeCompactionSummary(oldFact, `${oldFact}\n\n新事实：本地摘要链保留`)).toBe(
      `${oldFact}\n\n新事实：本地摘要链保留`,
    );
    expect(mergeCompactionSummary(`${oldFact}\n\n新事实：本地摘要链保留`, oldFact)).toBe(
      `${oldFact}\n\n新事实：本地摘要链保留`,
    );
  });

  test("短摘要不做包含去重,避免把不同内容误判为复述", () => {
    expect(mergeCompactionSummary("A 方案通过", "A 方案通过但细节调整")).toBe(
      "A 方案通过\n\nA 方案通过但细节调整",
    );
  });
});
