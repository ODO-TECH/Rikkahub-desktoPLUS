// chain-of-thought 折叠深度锁(设置 › 通用 › 应用「折叠全部思考与工具步骤」)。
//
// 开关只改收起深度、不改展开态主权,所以锁的是 collapsedVisibleCount 三档语义:
//   0 = 整卡一行(「展开 N 条工作步骤」在、步骤一条都不渲染)——这里最容易写错:
//       steps.slice(-0) 等于 slice(0) 会把全部步骤吐回来,必须有显式分支。
//   1 = 流式中留最新一条,进度仍可见。
//   2 = 关掉开关的历史行为(默认值)。

import * as React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ChainOfThought } from "~/components/message/chain-of-thought";

function renderChain(collapsedVisibleCount: number): string {
  return renderToStaticMarkup(
    React.createElement(ChainOfThought<string>, {
      steps: ["old", "mid", "new"],
      collapsedVisibleCount,
      renderStep: (step: string) => React.createElement("div", { key: step }, `step-${step}`),
      showMoreLabel: (hiddenCount: number) => `展开 ${hiddenCount} 条工作步骤`,
    }),
  );
}

describe("工作步骤折叠深度", () => {
  test("0 档：整卡收成一行，三条步骤都不渲染", () => {
    const html = renderChain(0);
    expect(html).toContain("展开 3 条工作步骤");
    expect(html).not.toContain("step-old");
    expect(html).not.toContain("step-mid");
    expect(html).not.toContain("step-new");
  });

  test("1 档：只留最新一条", () => {
    const html = renderChain(1);
    expect(html).toContain("展开 2 条工作步骤");
    expect(html).toContain("step-new");
    expect(html).not.toContain("step-mid");
  });

  test("2 档(未开开关)：留最近两条", () => {
    const html = renderChain(2);
    expect(html).toContain("展开 1 条工作步骤");
    expect(html).toContain("step-mid");
    expect(html).toContain("step-new");
    expect(html).not.toContain("step-old");
  });

  test("步骤数不超过收起深度时不出折叠行(0 档例外:任何步骤都收起)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChainOfThought<string>, {
        steps: ["only"],
        collapsedVisibleCount: 1,
        renderStep: (step: string) => React.createElement("div", { key: step }, `step-${step}`),
      }),
    );
    expect(html).toContain("step-only");
  });
});
