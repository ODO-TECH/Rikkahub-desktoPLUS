// 「全局技能」批量启用:保持每个助手原有技能顺序,重复启用不产生重复项。
import { describe, expect, test } from "bun:test";

import { applySkillToAllAssistants } from "./handlers/settings";

const assistants = [
  { id: "a1", enabledSkills: ["alpha", "beta"] },
  { id: "a2", enabledSkills: [] },
] as any;

describe("applySkillToAllAssistants", () => {
  test("启用:追加到每个助手,保留原顺序", () => {
    const next = applySkillToAllAssistants(assistants, "gamma", true);
    expect(next[0].enabledSkills).toEqual(["alpha", "beta", "gamma"]);
    expect(next[1].enabledSkills).toEqual(["gamma"]);
  });

  test("重复启用不产生重复项", () => {
    const next = applySkillToAllAssistants(assistants, "alpha", true);
    expect(next[0].enabledSkills).toEqual(["alpha", "beta"]);
  });

  test("停用:从所有助手移除,其他技能保持顺序", () => {
    const next = applySkillToAllAssistants(assistants, "alpha", false);
    expect(next[0].enabledSkills).toEqual(["beta"]);
    expect(next[1].enabledSkills).toEqual([]);
  });

  test("不修改入参", () => {
    applySkillToAllAssistants(assistants, "gamma", true);
    expect(assistants[0].enabledSkills).toEqual(["alpha", "beta"]);
  });
});
