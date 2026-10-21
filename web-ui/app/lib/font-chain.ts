// 字体链组合与"中文字体覆盖"机制(root.tsx 与 font-picker 共用,保持单一事实源)。
//
// 背景:中英文分别设置(Word 式)最初的实现是把中文字体插到英文链"主字体之后、兜底之前"。
// 该做法有一个无解的前提假设——链首英文字体不含中文字形。一旦用户把界面/英文字体设成
// 任何覆盖中文的字体(HarmonyOS Sans SC、微软雅黑、Noto Sans SC 等),中文字形会被链首
// 直接消化,插在后面的"中文字体"永远轮不到(探针 probe-cjk-merge.mjs 实证)。
//
// 根治方案:unicode-range 覆盖字体。为选定的中文字体注入一个合成 @font-face 族
// (unicode-range 仅覆盖 CJK 码位),把它放在链首:
//   - 中文字形:命中合成族 → 渲染选定的中文字体;
//   - 拉丁字形:不在 unicode-range 内 → 穿透到英文字体。
// 这样无论英文字体是否覆盖中文,中文字体都精确生效,英文字形也绝不被中文字体污染。
// @font-face 注入见 font-face-injector.tsx;这里只负责纯函数部分。

import type { FontEntry } from "~/types/font";

/** CJK 覆盖的码位:标点/假名/注音、扩展A、基本区、兼容表意、竖排形式、全角形式。 */
export const CJK_UNICODE_RANGE =
  "U+2E80-303F, U+3040-33FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF";

/** 界面字体的中文覆盖合成族名(root.tsx 与设置页预览共用)。 */
export const UI_CJK_OVERRIDE_FAMILY = "rikkahub-cjk-ui";
/** 对话字体的中文覆盖合成族名。 */
export const CHAT_CJK_OVERRIDE_FAMILY = "rikkahub-cjk-chat";

/**
 * 宽松匹配 catalog 条目:容忍老版本存下来的 value(可能是 id、family 名、cssName
 * 或抽 i18n key 前的中文 label)。font-picker 与 font-face-injector 共用。
 */
export function entryMatches(
  entry: { id: string; label?: string; legacyLabel?: string; cssName?: string },
  value: string,
): boolean {
  if (!value) return false;
  return (
    entry.id === value ||
    (entry.label != null && entry.label === value) ||
    (entry.legacyLabel != null && entry.legacyLabel === value) ||
    (entry.cssName != null && entry.cssName === value)
  );
}

/**
 * 组合最终 font-family 链:设了中文字体 → 合成覆盖族置于链首;否则原链返回。
 * baseChain 为空时(英文未设且无默认链)返回空,由调用方决定兜底。
 */
export function composeFontChain(
  baseChain: string,
  cjkOverrideFamily: string,
  hasCjk: boolean,
): string {
  const base = baseChain.trim();
  if (!hasCjk) return base;
  if (!base) return `"${cjkOverrideFamily}"`;
  return `"${cjkOverrideFamily}", ${base}`;
}

/** family 链里的 generic 关键字与 var() 引用,不能作为 local() 源。 */
const NON_LOCAL_SOURCES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "math",
  "emoji",
  "fangsong",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
]);

/** 从 family 链提取可作 local() 源的具体字体名(剥引号、跳过 generic 与 var())。 */
function localSourcesFromChain(familyChain: string): string[] {
  return familyChain
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((name) => name && !name.startsWith("var(") && !NON_LOCAL_SOURCES.has(name.toLowerCase()));
}

/**
 * 为选定的中文字体生成覆盖 @font-face 规则(可能多条,多字重字体一重一条)。
 * - 文件字体(builtin/custom):src: url(字体文件),按字重出规则,浏览器按需懒加载;
 * - 系统字体:src: local(族名),font-weight 100 900 让单条规则匹配所有字重
 *   (粗体由系统在该族内选面或合成,与直接使用该族名的行为一致);
 * - 通用栈(无具体字体文件/族名可指):退化为 local() 具体名列表;全 generic 时返回空
 *   ——覆盖族不存在,链自然穿透到英文字体,行为等同"未设置中文字体"。
 */
export function buildCjkOverrideCss(
  overrideFamily: string,
  entry: FontEntry | null,
  familyChain: string,
): string {
  if (entry && entry.weights.length > 0) {
    return entry.weights
      .map((w) => {
        const url = `/api/fonts/${entry.source}/${encodeURIComponent(w.fileName)}`;
        const fmt = w.format ? ` format("${w.format}")` : "";
        const styleDecl = w.style === "italic" ? " font-style: italic;" : "";
        return `@font-face { font-family: "${overrideFamily}"; src: url("${url}")${fmt}; font-weight: ${w.weight};${styleDecl} unicode-range: ${CJK_UNICODE_RANGE}; font-display: swap; }`;
      })
      .join("\n");
  }
  const names = entry ? [entry.cssName] : localSourcesFromChain(familyChain);
  if (names.length === 0) return "";
  const src = names.map((name) => `local("${name}")`).join(", ");
  return `@font-face { font-family: "${overrideFamily}"; src: ${src}; font-weight: 100 900; unicode-range: ${CJK_UNICODE_RANGE}; }`;
}
