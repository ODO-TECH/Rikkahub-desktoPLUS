// memory/experiment/compaction-candidates.test.ts — 压缩后置候选的纯函数层：
// 原文取段（只保留尾部预算）与模型输出解析（归一化、去重、上限、键写死）。
import { describe, expect, test } from "bun:test";

import { message } from "../../foundation/utils";
import { compactionTranscript, parseCompactionCandidates } from "./compaction-candidates";

describe("压缩段原文", () => {
  test("只取正文并保留角色与顺序", () => {
    const transcript = compactionTranscript([
      message("USER", [{ type: "text", text: "我喜欢喝乌龙茶" }]),
      message("ASSISTANT", [{ type: "tool", toolCallId: "t1", input: "{}", output: [] } as never]),
      message("ASSISTANT", [{ type: "text", text: "好的，记下了" }]),
    ]);
    expect(transcript).toContain("[USER]: 我喜欢喝乌龙茶");
    expect(transcript).toContain("[ASSISTANT]: 好的，记下了");
    expect(transcript.indexOf("[USER]")).toBeLessThan(transcript.indexOf("好的，记下了"));
    expect(transcript).not.toContain("toolCallId");
  });

  test("超预算时丢弃更早内容并留下截断标记", () => {
    const long = "旧".repeat(20_000);
    const transcript = compactionTranscript([
      message("USER", [{ type: "text", text: long }]),
      message("USER", [{ type: "text", text: "最新一句" }]),
    ]);
    expect(transcript).toContain("[更早内容已截断]");
    expect(transcript).toContain("最新一句");
    expect(transcript.length).toBeLessThan(17_000);
  });
});

describe("候选解析", () => {
  const options = { conversationId: "conv-1", cutMessageId: "msg-cut", maxCandidates: 6 };

  test("合法候选归一化，切点与幂等键由适配器写死", () => {
    const raw = JSON.stringify({
      candidates: [{
        content: "用户喜欢喝乌龙茶",
        kind: "habit",
        facets: { person: "用户", tags: ["饮食", "饮食", ""] },
        explicitRemember: true,
        sourceCutMessageId: "forged",
        idempotencyKey: "forged",
      }],
    });
    const [assertion] = parseCompactionCandidates(raw, options);
    expect(assertion.content).toBe("用户喜欢喝乌龙茶");
    expect(assertion.kind).toBe("habit");
    expect(assertion.facets).toEqual({ person: "用户", tags: ["饮食"] });
    expect(assertion.explicitRemember).toBe(true);
    expect(assertion.origin).toBe("compaction");
    expect(assertion.conversationId).toBe("conv-1");
    expect(assertion.sourceCutMessageId).toBe("msg-cut");
    // 幂等键 = 会话 + 切点 + 断言哈希（16 hex），模型伪造的键不被采信。
    expect(assertion.idempotencyKey).toMatch(/^compaction:conv-1:msg-cut:[0-9a-f]{16}$/);
  });

  test("幂等键随内容走：换顺序不产生新键，改措辞才换键", () => {
    const first = parseCompactionCandidates(
      JSON.stringify({ candidates: [{ content: "用户是设计师" }, { content: "用户每周三打球" }] }),
      options,
    );
    const reordered = parseCompactionCandidates(
      JSON.stringify({ candidates: [{ content: "用户每周三打球" }, { content: "用户是设计师" }] }),
      options,
    );
    expect(new Set(reordered.map((item) => item.idempotencyKey))).toEqual(
      new Set(first.map((item) => item.idempotencyKey)),
    );
    const reworded = parseCompactionCandidates(
      JSON.stringify({ candidates: [{ content: "用户是一名设计师" }] }),
      options,
    );
    expect(reworded[0]!.idempotencyKey).not.toBe(first[0]!.idempotencyKey);
  });

  test("同批去重、未知 kind 降级、非法条目跳过", () => {
    const raw = JSON.stringify({
      candidates: [
        { content: "用户是设计师", kind: "身份" },
        { content: "  用户是设计师  ", kind: "setting" },
        { content: "" },
        "not-an-object",
        { content: "用户每周三打球", kind: "habit" },
      ],
    });
    const assertions = parseCompactionCandidates(raw, options);
    expect(assertions).toHaveLength(2);
    expect(assertions[0]!.kind).toBe("unclassified");
    expect(assertions[1]!.content).toBe("用户每周三打球");
    expect(assertions[1]!.idempotencyKey).toMatch(/^compaction:conv-1:msg-cut:[0-9a-f]{16}$/);
  });

  test("遵守条数上限", () => {
    const raw = JSON.stringify({
      candidates: Array.from({ length: 10 }, (_, index) => ({ content: `事实 ${index}`, kind: "event" })),
    });
    expect(parseCompactionCandidates(raw, { ...options, maxCandidates: 3 })).toHaveLength(3);
  });

  test("非 JSON / 缺 candidates / 代码围栏都能安全处理", () => {
    expect(parseCompactionCandidates("抱歉我不能", options)).toEqual([]);
    expect(parseCompactionCandidates('{"foo":[]}', options)).toEqual([]);
    const fenced = "```json\n{\"candidates\":[{\"content\":\"用户住在杭州\",\"kind\":\"setting\"}]}\n```";
    expect(parseCompactionCandidates(fenced, options)).toHaveLength(1);
  });
});
