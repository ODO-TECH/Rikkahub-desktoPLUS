// D7(复查)回归:存量用户默认助手提示词的 cur_datetime → cur_date 迁移。
// a63d46b 把默认提示词的秒级 "Time: {{cur_datetime}}" 改为天级 "Date: {{cur_date}}"
// (秒级时间让 system 每条消息都变,前缀缓存从该行起全部失效),但没迁移存量数据。
// 与 R1-11 同一纪律:整段与旧默认逐字相等才替换,用户自定义分毫不动,幂等。
import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT } from "../app-config/defaults";

const legacyPrompt = DEFAULT_ASSISTANT_SYSTEM_PROMPT.replace("- Date: {{cur_date}}", "- Time: {{cur_datetime}}");

describe("D7 默认助手提示词迁移(无状态精确匹配)", () => {
  test("旧默认逐字命中 → 升级到新默认", () => {
    expect(legacyPrompt).not.toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT); // 反推确实构造出了旧串
    const state = normalizeState({
      settings: { assistants: [{ id: "a-1", name: "旧默认", systemPrompt: legacyPrompt }] } as never,
    });
    const migrated = state.settings.assistants.find((a) => a.id === "a-1");
    expect(migrated?.systemPrompt).toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT);
  });

  test("用户自定义(即使包含 cur_datetime)原样保留", () => {
    const custom = "My prompt with {{cur_datetime}} on purpose.";
    const state = normalizeState({
      settings: { assistants: [{ id: "a-2", name: "自定义", systemPrompt: custom }] } as never,
    });
    expect(state.settings.assistants.find((a) => a.id === "a-2")?.systemPrompt).toBe(custom);
  });

  test("现默认幂等通过", () => {
    const state = normalizeState({
      settings: { assistants: [{ id: "a-3", name: "新默认", systemPrompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT }] } as never,
    });
    expect(state.settings.assistants.find((a) => a.id === "a-3")?.systemPrompt).toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT);
  });
});
