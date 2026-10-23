// 媒体工作台提示词框:内层圆角为 0、外层沿用全局圆角。
//
// 历史 bug:textarea 用全局 12px 圆角 + p-0,border-radius 的裁剪区把首字左上角
// 切掉,看起来像"边框压字";在外层加内边距、改小外框圆角都只是把切口挪位置。
// 结构锁:文字容器自身不能带圆角,外框圆角跟全局卡片一致(rounded-xl = 16px)。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "components", "media-studio", "media-studio.tsx"),
  "utf8",
);

function promptBox(): string {
  const at = SOURCE.indexOf("media_studio.prompt_placeholder");
  if (at < 0) throw new Error("prompt placeholder not found");
  return SOURCE.slice(Math.max(0, at - 500), at + 400);
}

describe("媒体工作台提示词框圆角", () => {
  test("文字容器(Textarea)自身无圆角,避免圆角裁剪切掉首字", () => {
    const box = promptBox();
    expect(box).toMatch(/<Textarea[\s\S]*rounded-none/);
  });

  test("外框沿用全局 16px 圆角,和面板其它卡片一致", () => {
    expect(promptBox()).toContain('className="rounded-xl border bg-card p-3"');
  });
});
