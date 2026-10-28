// memory/experiment/merge-plan.test.ts — 第一轮合并规则的计划层（不落库、不改记忆）。
import { describe, expect, test } from "bun:test";

import {
  contentSimilarity,
  mergeContents,
  planMergeProposals,
  type MergeCandidate,
} from "./merge-plan";

let nextId = 1;
function candidate(patch: Partial<MergeCandidate> & { content: string }): MergeCandidate {
  const id = patch.id ?? nextId++;
  return {
    id,
    scopeKey: "global",
    scopeLabel: "全局记忆",
    kind: "unclassified",
    status: "active",
    explicitRemember: false,
    facets: null,
    mentionCount: 0,
    updatedAt: 1000,
    ...patch,
  };
}

describe("相似度与合并文本", () => {
  test("同模板不同人名的相似度高于无关句子", () => {
    const same = contentSimilarity("用户喜欢蕾米莉亚", "用户喜欢帕秋莉");
    const unrelated = contentSimilarity("用户喜欢蕾米莉亚", "明天下午三点开会");
    expect(same).toBeGreaterThan(0.42);
    expect(same).toBeGreaterThan(unrelated);
  });

  test("同类偏好合并为并列短语", () => {
    expect(mergeContents("用户喜欢草莓", "用户喜欢西瓜")).toBe("用户喜欢草莓、西瓜");
    expect(mergeContents("喜欢草莓和牛奶", "喜欢西瓜")).toBe("喜欢草莓和牛奶、西瓜");
    expect(mergeContents("甲".repeat(30), "乙".repeat(30))).toContain("；");
  });
});

describe("第一轮合并提案", () => {
  test("人物覆盖：蕾米莉亚 → 帕秋莉，保留较新一条", () => {
    const older = candidate({
      content: "用户喜欢蕾米莉亚",
      kind: "setting",
      facets: { person: "蕾米莉亚" },
      updatedAt: 100,
    });
    const newer = candidate({
      content: "用户喜欢帕秋莉",
      kind: "setting",
      facets: { person: "帕秋莉" },
      updatedAt: 200,
    });
    const [proposal] = planMergeProposals([older, newer]);
    expect(proposal.op).toBe("overwrite");
    expect(proposal.targetId).toBe(newer.id);
    expect(proposal.deleteIds).toEqual([older.id]);
    expect(proposal.content).toBe("用户喜欢帕秋莉");
    expect(proposal.involved.map((item) => item.role)).toEqual(["target", "source"]);
  });

  test("同类合并：草莓 + 西瓜", () => {
    const a = candidate({ content: "用户喜欢草莓", kind: "habit", updatedAt: 100 });
    const b = candidate({ content: "用户喜欢西瓜", kind: "habit", updatedAt: 200 });
    const [proposal] = planMergeProposals([a, b]);
    expect(proposal.op).toBe("merge");
    expect(proposal.content).toBe("用户喜欢草莓、西瓜");
    expect(proposal.deleteIds).toHaveLength(1);
  });

  test("完成提醒：删除提醒条目，保留完成记录", () => {
    const reminder = candidate({ content: "提醒我周五交季度报告", kind: "event", updatedAt: 100 });
    const done = candidate({ content: "周五的季度报告已经交了", kind: "event", updatedAt: 200 });
    const proposals = planMergeProposals([reminder, done]);
    const proposal = proposals.find((item) => item.op === "complete");
    expect(proposal).toBeDefined();
    expect(proposal?.targetId).toBe(done.id);
    expect(proposal?.deleteIds).toEqual([reminder.id]);
  });

  test("单条已完成提醒可整条删除；受保护条目不生成删除提案", () => {
    const trivial = candidate({ content: "提醒：买牛奶（已完成）", kind: "event" });
    const protectedOne = candidate({ content: "提醒：给妈妈打电话（已完成）", kind: "event", explicitRemember: true });
    const single = planMergeProposals([trivial, protectedOne]);
    expect(single).toHaveLength(1);
    expect(single[0].deleteIds).toEqual([trivial.id]);

    const protectedOnly = planMergeProposals([protectedOne]);
    expect(protectedOnly).toHaveLength(0);
  });

  test("跨作用域不合并", () => {
    const global = candidate({ content: "用户喜欢草莓", kind: "habit", scopeKey: "global" });
    const assistant = candidate({ content: "用户喜欢西瓜", kind: "habit", scopeKey: "assistant:a1", scopeLabel: "助手" });
    expect(planMergeProposals([global, assistant])).toHaveLength(0);
  });

  test("事件类不参与同类合并（留给第二轮失真）", () => {
    const a = candidate({ content: "上周去吃了火锅", kind: "event" });
    const b = candidate({ content: "上周去吃了烧烤", kind: "event" });
    expect(planMergeProposals([a, b]).some((p) => p.op === "merge")).toBe(false);
  });

  test("一条记忆只进一个提案", () => {
    const a = candidate({ content: "用户喜欢草莓", kind: "habit" });
    const b = candidate({ content: "用户喜欢西瓜", kind: "habit" });
    const c = candidate({ content: "用户喜欢葡萄", kind: "habit" });
    const proposals = planMergeProposals([a, b, c]);
    const ids = proposals.flatMap((proposal) => [proposal.targetId, ...proposal.deleteIds]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("非 active 记忆不参与", () => {
    const a = candidate({ content: "用户喜欢草莓", kind: "habit", status: "superseded" });
    const b = candidate({ content: "用户喜欢西瓜", kind: "habit" });
    expect(planMergeProposals([a, b])).toHaveLength(0);
  });
});
