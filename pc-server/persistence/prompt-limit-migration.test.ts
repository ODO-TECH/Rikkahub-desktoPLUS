// 批7 R1-11 回归:标题/建议提示词的字数上限迁移必须只作用于"未自定义的旧默认值"。
// 旧实现每次启动对 prompt 做无条件正则替换("not exceed 10 characters"→15/18),用户
// 有意写 10 的自定义提示词被反复静默改掉。新实现无状态精确匹配:整段等于旧默认全文
// 才升级到新默认;不用迁移标记(pc-backup.json 不导出标记,恢复即丢——R1-12 教训),
// 幂等且随备份天然往返。
import { describe, expect, test } from "bun:test";
import { normalizeState } from "./state-load";
import {
  DEFAULT_SUGGESTION_PROMPT,
  DEFAULT_TITLE_PROMPT,
  SUGGESTION_CHARACTER_LIMIT,
  TITLE_CHARACTER_LIMIT,
} from "../app-config/prompts";

const legacyTitle = DEFAULT_TITLE_PROMPT.replace(`not exceed ${TITLE_CHARACTER_LIMIT} characters`, "not exceed 10 characters");
const legacySuggestion = DEFAULT_SUGGESTION_PROMPT.replace(`not exceed ${SUGGESTION_CHARACTER_LIMIT} characters`, "not exceed 10 characters");

describe("R1-11 提示词字数上限迁移(无状态精确匹配)", () => {
  test("旧默认全文精确命中 → 升级到新默认", () => {
    const state = normalizeState({
      settings: { titlePrompt: legacyTitle, suggestionPrompt: legacySuggestion } as never,
    });
    expect(state.settings.titlePrompt).toBe(DEFAULT_TITLE_PROMPT);
    expect(state.settings.suggestionPrompt).toBe(DEFAULT_SUGGESTION_PROMPT);
  });

  test("用户自定义(含刻意写 10 characters)原样保留", () => {
    const custom = "Summarize into a title, not exceed 10 characters, no punctuation.";
    const state = normalizeState({
      settings: { titlePrompt: custom, suggestionPrompt: custom } as never,
    });
    expect(state.settings.titlePrompt).toBe(custom);
    expect(state.settings.suggestionPrompt).toBe(custom);
  });

  test("空值回填现默认,现默认幂等通过", () => {
    const state = normalizeState({
      settings: { titlePrompt: "", suggestionPrompt: DEFAULT_SUGGESTION_PROMPT } as never,
    });
    expect(state.settings.titlePrompt).toBe(DEFAULT_TITLE_PROMPT);
    expect(state.settings.suggestionPrompt).toBe(DEFAULT_SUGGESTION_PROMPT);
  });
});
