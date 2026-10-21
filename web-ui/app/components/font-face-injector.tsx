import * as React from "react";

import { useFontCatalog } from "~/hooks/use-font-catalog";
import {
  buildCjkOverrideCss,
  CHAT_CJK_OVERRIDE_FAMILY,
  entryMatches,
  UI_CJK_OVERRIDE_FAMILY,
} from "~/lib/font-chain";
import { useSettingsStore } from "~/stores/app-store";
import type { FontEntry } from "~/types/font";

// 把 builtin + custom 字体的 @font-face 规则注入 <head>。系统字体不需要(浏览器已能用)。
// 浏览器对 @font-face 懒加载——只有渲染用到字形时才真正下载文件,所以一次全注入不浪费带宽。
// 关键不变式:@font-face 的 font-family 名 === 后端 FontEntry.cssName === family 链首项,
// 这样 CSS 变量里写的 family 才能命中 @font-face 规则触发加载。
// 多字重字体(HarmonyOS Sans 6 个字重)共享同一 font-family,每条规则声明对应 font-weight,
// 浏览器遇到 font-weight:700 自动挑 Bold 文件,而非用 Regular 合成假粗体。
//
// 另注入"中文字体覆盖"合成族(原理见 lib/font-chain.ts):为界面/对话当前选定的中文字体
// 各生成一个 unicode-range 限定 CJK 的 @font-face,root.tsx 把它放在 font-family 链首,
// 保证中文字形走中文字体、拉丁字形穿透到英文字体。
export function FontFaceInjector() {
  const { data } = useFontCatalog();
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  const uiCjkValue = String(displaySetting?.uiFontFamilyCjk ?? "");
  const uiCjkCss = String(displaySetting?.uiFontFamilyCjkCss ?? "");
  const chatCjkValue = String(displaySetting?.chatFontFamilyCjk ?? "");
  const chatCjkCss = String(displaySetting?.chatFontFamilyCjkCss ?? "");

  React.useEffect(() => {
    if (!data) return;
    const entries = [...data.builtin, ...data.custom];
    const rules: string[] = [];
    for (const entry of entries) {
      for (const w of entry.weights) {
        const url = `/api/fonts/${entry.source}/${encodeURIComponent(w.fileName)}`;
        const fmt = w.format ? ` format("${w.format}")` : "";
        const styleDecl = w.style === "italic" ? " font-style: italic;" : "";
        rules.push(
          `@font-face { font-family: "${entry.cssName}"; src: url("${url}")${fmt}; font-weight: ${w.weight};${styleDecl} font-display: swap; }`,
        );
      }
    }

    const allEntries: FontEntry[] = [...data.builtin, ...data.custom, ...data.system];
    const overrides: Array<[string, string, string]> = [
      [UI_CJK_OVERRIDE_FAMILY, uiCjkValue, uiCjkCss],
      [CHAT_CJK_OVERRIDE_FAMILY, chatCjkValue, chatCjkCss],
    ];
    for (const [family, value, css] of overrides) {
      if (!value.trim() && !css.trim()) continue;
      const entry = allEntries.find((e) => entryMatches(e, value)) ?? null;
      const rule = buildCjkOverrideCss(family, entry, css);
      if (rule) rules.push(rule);
    }

    let style = document.getElementById("rikkahub-font-faces") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "rikkahub-font-faces";
      document.head.appendChild(style);
    }
    style.textContent = rules.join("\n");
  }, [data, uiCjkValue, uiCjkCss, chatCjkValue, chatCjkCss]);
  return null;
}
