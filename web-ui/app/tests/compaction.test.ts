// 压缩边界展示面判定(lib/compaction.ts)——分割线锚点的数据契约。
import { describe, expect, it } from "bun:test";

import {
  buildCompactionAnchors,
  COMPRESS_RATIO_DEFAULT,
  COMPRESS_RATIO_MAX,
  COMPRESS_RATIO_MIN,
  COMPRESS_RATIO_WARN,
  compressRatioToTargetTokens,
  CONTEXT_WARNING_RESERVE_TOKENS,
  compactionAfterMessage,
  compactionDividerBelow,
  contextWarningPercent,
  estimateCompactionTokens,
  isCompactionBoundaryMessage,
  isCompactionCutMessage,
  latestCompactionPlacement,
  normalizeCompressKeepRecent,
  normalizeCompressRatio,
  parseCompactionRecords,
  type CompactionTimelineNode,
} from "~/lib/compaction";
import type { UIMessage } from "~/types";

describe("isCompactionBoundaryMessage(旧破坏式压缩发生点)", () => {
  it("按注解判别,缺 annotations 容忍", () => {
    expect(isCompactionBoundaryMessage({ annotations: [{ type: "compaction_boundary" }] })).toBe(
      true,
    );
    expect(
      isCompactionBoundaryMessage({ annotations: [{ type: "model_call_error", message: "x" }] }),
    ).toBe(false);
    expect(isCompactionBoundaryMessage({ annotations: [] })).toBe(false);
    expect(isCompactionBoundaryMessage({ annotations: undefined as unknown as [] })).toBe(false);
  });
});

describe("isCompactionCutMessage(非破坏式压缩的记忆边界)", () => {
  it("按注解判别,与 boundary 互不误判", () => {
    expect(isCompactionCutMessage({ annotations: [{ type: "compaction_cut" }] })).toBe(true);
    expect(isCompactionCutMessage({ annotations: [{ type: "compaction_boundary" }] })).toBe(false);
    expect(isCompactionCutMessage({ annotations: [] })).toBe(false);
    expect(isCompactionCutMessage({ annotations: undefined as unknown as [] })).toBe(false);
  });
});

describe("compactionDividerBelow", () => {
  it("两代注解各自出线,cut 优先", () => {
    expect(compactionDividerBelow({ annotations: [{ type: "compaction_cut" }] })).toBe("cut");
    expect(compactionDividerBelow({ annotations: [{ type: "compaction_boundary" }] })).toBe(
      "boundary",
    );
    expect(
      compactionDividerBelow({
        annotations: [{ type: "compaction_boundary" }, { type: "compaction_cut" }],
      }),
    ).toBe("cut");
    expect(compactionDividerBelow({ annotations: [] })).toBeNull();
    expect(compactionDividerBelow({ annotations: undefined as unknown as [] })).toBeNull();
  });
});

describe("contextWarningPercent(上下文即将用完提示)", () => {
  const limit = 100_000;
  const nearLimit = limit - CONTEXT_WARNING_RESERVE_TOKENS / 2;

  it("越过 threshold = limit - reserve 才提示", () => {
    expect(
      contextWarningPercent({ promptTokens: 1000, completionTokens: 500, contextLimit: limit }),
    ).toBeNull();
    expect(
      contextWarningPercent({
        promptTokens: limit - CONTEXT_WARNING_RESERVE_TOKENS - 100,
        completionTokens: 100,
        contextLimit: limit,
      }),
    ).toBeNull();
    expect(
      contextWarningPercent({ promptTokens: nearLimit, completionTokens: 0, contextLimit: limit }),
    ).toBe(Math.round((nearLimit / limit) * 100));
    // 上限 100%:估算越界也不显示 101%。
    expect(
      contextWarningPercent({ promptTokens: limit * 2, completionTokens: 0, contextLimit: limit }),
    ).toBe(100);
  });

  it("分母:live 优先,回退消息快照;都没有则不算", () => {
    const usage = { promptTokens: nearLimit, completionTokens: 0 };
    // 快照 200k 本不告警,live 100k 生效 → 告警(live 优先)。
    expect(contextWarningPercent({ ...usage, contextLimit: 200_000 }, limit)).toBe(
      Math.round((nearLimit / limit) * 100),
    );
    // 无 live 时回退快照:50k 窗口下已越界 → 100%。
    expect(contextWarningPercent({ ...usage, contextLimit: 50_000 })).toBe(100);
    // live 200k 本不告警(快照 100k 会告警)→ 证明 live 真的优先。
    expect(contextWarningPercent({ ...usage, contextLimit: limit }, 200_000)).toBeNull();
    // 两侧都没有 → 不算百分比。
    expect(contextWarningPercent({ ...usage, contextLimit: null })).toBeNull();
  });

  it("窗口本身小于保留量:阈值失效,不提示", () => {
    expect(
      contextWarningPercent({ promptTokens: 10_000, completionTokens: 0, contextLimit: 16_000 }),
    ).toBeNull();
  });
});

describe("压缩记录解析与锚点映射(详情卡数据面)", () => {
  const message = (id: string) => ({ id }) as UIMessage;
  const node = (selectedId: string, ...otherIds: string[]): CompactionTimelineNode => ({
    messages: [selectedId, ...otherIds].map(message),
    selectedId,
  });
  const record = (
    cutMessageId: string,
    summary = "旧摘要",
    tokensBefore = 100,
    createdAt?: string,
  ) => ({
    cutMessageId,
    summary,
    tokensBefore,
    ...(createdAt ? { createdAt } : {}),
  });

  it("宽容解析:坏条目丢弃,tokensBefore 非法回 0", () => {
    expect(
      parseCompactionRecords([
        record("m2"),
        null,
        "junk",
        { cutMessageId: 1, summary: "x" },
        { cutMessageId: "m3", summary: 2 },
        { cutMessageId: "m4", summary: "ok", tokensBefore: -5 },
      ]),
    ).toEqual([
      { cutMessageId: "m2", summary: "旧摘要", tokensBefore: 100 },
      { cutMessageId: "m4", summary: "ok", tokensBefore: 0 },
    ]);
    expect(parseCompactionRecords(null)).toEqual([]);
    expect(parseCompactionRecords({})).toEqual([]);
  });

  it("切点 → 前一节点选中消息;非选中候选也能定位切点", () => {
    const nodes = [node("m1"), node("m2", "m2-other"), node("m3")];
    const anchors = buildCompactionAnchors([record("m2-other")], nodes);
    expect(anchors.get("m1")?.record.cutMessageId).toBe("m2-other");
    expect(anchors.get("m1")?.cutMessage.id).toBe("m2-other");
    expect(anchors.has("m2")).toBe(false);
  });

  it("同一锚点多条记录:最新一条覆盖,摘要增量按上一版计算", () => {
    const nodes = [node("m1"), node("m2"), node("m3")];
    const anchors = buildCompactionAnchors(
      [record("m2", "AAAA"), record("m2", "AAAA\n\nBBBBBBBB")],
      nodes,
    );
    const info = anchors.get("m1")!;
    expect(info.record.summary).toBe("AAAA\n\nBBBBBBBB");
    expect(info.summaryTokens).toBe(estimateCompactionTokens("AAAA\n\nBBBBBBBB"));
    expect(info.previousSummaryTokens).toBe(estimateCompactionTokens("AAAA"));
  });

  it("切点在首条/切点已被删除/锚点未选中:不产生入口", () => {
    expect(buildCompactionAnchors([record("m1")], [node("m1"), node("m2")]).size).toBe(0);
    expect(buildCompactionAnchors([record("gone")], [node("m1"), node("m2")]).size).toBe(0);
    expect(buildCompactionAnchors([record("m2")], [node(""), node("m2")]).size).toBe(0);
  });

  it("latestCompactionPlacement:取最后一条有效记录及其折叠范围", () => {
    const nodes = [node("m1"), node("m2"), node("m3"), node("m4")];
    const placement = latestCompactionPlacement(
      [record("m2", "一"), record("m4", "二")],
      nodes,
    )!;
    expect(placement.record.cutMessageId).toBe("m4");
    expect(placement.anchorId).toBe("m3");
    expect(placement.anchorNodeIndex).toBe(2);
    expect(placement.cutNodeIndex).toBe(3);
  });

  it("latestCompactionPlacement:最新记录失效时回落到更早的有效记录", () => {
    const nodes = [node("m1"), node("m2"), node("m3")];
    // 最后一条的切点已被删除 → 回落到记录一。
    const placement = latestCompactionPlacement([record("m2", "一"), record("gone", "二")], nodes)!;
    expect(placement.record.cutMessageId).toBe("m2");
    expect(placement.anchorId).toBe("m1");
    expect(placement.anchorNodeIndex).toBe(0);
    // 全部无效 / 空数据 → 不折叠。
    expect(latestCompactionPlacement([record("gone")], nodes)).toBeNull();
    expect(latestCompactionPlacement([], nodes)).toBeNull();
    expect(latestCompactionPlacement(null, nodes)).toBeNull();
  });

  it("估算口径与后端 estimateTokens 一致(CJK 0.9 / 其他 1/4,至少 1)", () => {
    expect(estimateCompactionTokens("")).toBe(1);
    expect(estimateCompactionTokens("abcd")).toBe(1);
    expect(estimateCompactionTokens("你好")).toBe(2);
    expect(estimateCompactionTokens("你好abcd")).toBe(3);
  });
});

describe("compactionAfterMessage(压缩后旧 usage 不再提示)", () => {
  const record = (createdAt?: string) =>
    createdAt
      ? [{ cutMessageId: "m2", summary: "s", tokensBefore: 1, createdAt }]
      : [{ cutMessageId: "m2", summary: "s", tokensBefore: 1 }];

  it("消息早于最近一次压缩 → true(usage 已过期)", () => {
    expect(
      compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), "2026-10-25T09:59:00.000Z"),
    ).toBe(true);
    // 多条记录取最新时间。
    expect(
      compactionAfterMessage(
        [...record("2026-10-25T08:00:00.000Z"), ...record("2026-10-25T10:00:00.000Z")],
        "2026-10-25T09:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("消息晚于压缩 / 无压缩 / 脏数据 → false(按新 usage 判断)", () => {
    expect(
      compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), "2026-10-25T10:01:00.000Z"),
    ).toBe(false);
    expect(compactionAfterMessage(null, "2026-10-25T10:01:00.000Z")).toBe(false);
    expect(compactionAfterMessage([], "2026-10-25T10:01:00.000Z")).toBe(false);
    // 旧记录无 createdAt(pi 存量):无法比时间,不据此抑制提示。
    expect(compactionAfterMessage(record(), "2026-10-25T10:01:00.000Z")).toBe(false);
    expect(compactionAfterMessage(record("2026-10-25T10:00:00.000Z"), undefined)).toBe(false);
  });
});

describe("手动压缩参数归一化(对话框输入)", () => {
  it("保留条数:任意非负整数,0 合法,负数归零,空串回退", () => {
    expect(normalizeCompressKeepRecent("")).toBe(32);
    expect(normalizeCompressKeepRecent("x")).toBe(32);
    expect(normalizeCompressKeepRecent("0")).toBe(0);
    expect(normalizeCompressKeepRecent("8")).toBe(8);
    expect(normalizeCompressKeepRecent("100")).toBe(100);
    expect(normalizeCompressKeepRecent("-5")).toBe(0);
    expect(normalizeCompressKeepRecent("16.8")).toBe(16);
    expect(normalizeCompressKeepRecent(12)).toBe(12);
    expect(normalizeCompressKeepRecent("", 8)).toBe(8);
  });
});

describe("压缩比例(滑杆取值)", () => {
  it("常量:20 起步 / 40 默认 / 65 告警线 / 100 上限", () => {
    expect(COMPRESS_RATIO_MIN).toBe(20);
    expect(COMPRESS_RATIO_DEFAULT).toBe(40);
    expect(COMPRESS_RATIO_WARN).toBe(65);
    expect(COMPRESS_RATIO_MAX).toBe(100);
  });

  it("归一化:非法输入回退默认 40,越界值夹到 [20, 100],小数取整", () => {
    expect(normalizeCompressRatio("")).toBe(40);
    expect(normalizeCompressRatio("abc")).toBe(40);
    expect(normalizeCompressRatio("19")).toBe(20);
    expect(normalizeCompressRatio("-5")).toBe(20);
    expect(normalizeCompressRatio("20")).toBe(20);
    expect(normalizeCompressRatio("40")).toBe(40);
    expect(normalizeCompressRatio("65")).toBe(65);
    expect(normalizeCompressRatio("100")).toBe(100);
    expect(normalizeCompressRatio("120")).toBe(100);
    expect(normalizeCompressRatio("64.9")).toBe(64);
    expect(normalizeCompressRatio(72)).toBe(72);
    expect(normalizeCompressRatio("", 55)).toBe(55);
  });

  it("比例 → targetTokens:摘要 = 上下文 × (1 − 比例),四舍五入", () => {
    expect(compressRatioToTargetTokens(20, 100_000)).toBe(80_000);
    expect(compressRatioToTargetTokens(40, 100_000)).toBe(60_000);
    expect(compressRatioToTargetTokens(65, 100_000)).toBe(35_000);
    expect(compressRatioToTargetTokens(100, 100_000)).toBe(256);
    expect(compressRatioToTargetTokens(40, 1001)).toBe(601);
    // 越界比例先归一化再换算:10 → 20%,120 → 100%。
    expect(compressRatioToTargetTokens(10, 100_000)).toBe(80_000);
    expect(compressRatioToTargetTokens(120, 100_000)).toBe(256);
    // 小上下文换算低于后端下限 → 抬到 256。
    expect(compressRatioToTargetTokens(20, 300)).toBe(256);
  });

  it("上下文未知 → null(调用方省略 targetTokens 走服务端默认)", () => {
    expect(compressRatioToTargetTokens(40, null)).toBeNull();
    expect(compressRatioToTargetTokens(40, undefined)).toBeNull();
    expect(compressRatioToTargetTokens(40, 0)).toBeNull();
    expect(compressRatioToTargetTokens(40, -100)).toBeNull();
    expect(compressRatioToTargetTokens(40, Number.NaN)).toBeNull();
  });
});
