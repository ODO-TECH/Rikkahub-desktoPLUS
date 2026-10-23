// 「折叠全部思考与工具步骤」接线锁(setting → 折叠深度那一段)。
//
// 折叠深度的 DOM 行为由 chain-of-thought-collapse.test.tsx 用真实渲染锁住(0/1/2 档)。
// 这里锁的是前半段:displaySetting.collapseAllSteps 怎么变成 collapsedVisibleCount。
//
// 为什么用源码结构锁而不是挂载组件:zustand v5 的 useSyncExternalStore 在服务端渲染
// (renderToStaticMarkup)只读 api.getInitialState(),setState 对静态渲染不可见——
// 用 store 驱动的真渲染断言必然拿到默认值,测不出接线(仓库里 titlebar-overlay、
// drag-reorder-projection 同理)。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const MESSAGE_PART = readFileSync(
  join(import.meta.dir, "..", "components", "message", "message-part.tsx"),
  "utf8",
);
const GENERAL_SETTINGS = readFileSync(
  join(import.meta.dir, "..", "components", "settings", "general.tsx"),
  "utf8",
);

describe("折叠全部思考与工具步骤:设置 → 折叠深度接线", () => {
  test("思维链卡订阅 displaySetting.collapseAllSteps", () => {
    // 字段名写错(或改了默认值语义)会让开关静默失效,这里精确到完整选择器路径。
    expect(MESSAGE_PART).toContain(
      "(state) => state.settings?.displaySetting?.collapseAllSteps === true",
    );
  });

  test("开=收起全部(流式中留一条),关=历史行为(留两条)", () => {
    expect(MESSAGE_PART).toMatch(
      /collapsedVisibleCount=\{collapseAll \? \(streaming \? 1 : 0\) : 2\}/,
    );
  });

  test("流式信号取自本条消息的 loading,不是全局状态", () => {
    expect(MESSAGE_PART).toMatch(/<ThinkingChainBlock[\s\S]{0,400}?streaming=\{loading\}/);
  });

  test("开关是「不写即关」,不进「不写即开」的表驱动开关组", () => {
    // 上排 DISPLAY_TOGGLES 用 !== false(缺省即开);本项必须 === true(缺省即关),
    // 混进表会把存量用户的默认行为改掉。
    expect(GENERAL_SETTINGS).toContain("display.collapseAllSteps === true");
    expect(GENERAL_SETTINGS).toContain("patchDisplay({ collapseAllSteps: checked })");
  });

  test("折叠只作用于 thinking 块:pending 工具(询问用户等)在链外单独渲染", () => {
    // 询问用户的卡片必须在折叠之前就分支出去,折叠参数不得有任何机会碰到它。
    const pendingAt = MESSAGE_PART.indexOf('if (block.type === "pendingTool")');
    const thinkingAt = MESSAGE_PART.indexOf('if (block.type === "thinking")');
    expect(pendingAt).toBeGreaterThan(-1);
    expect(thinkingAt).toBeGreaterThan(pendingAt);
    expect(MESSAGE_PART).toContain("<PendingToolAttentionCard");
    // collapseAll 只出现在 ThinkingChainBlock 里(取值 + 传深度),不参与 pending 分支。
    const pendingBranch = MESSAGE_PART.slice(pendingAt, thinkingAt);
    expect(pendingBranch).not.toContain("collapseAll");
  });
});
