// im/markdown.ts — 把模型回复里的 Markdown 排版降级成纯文本(QQ/微信都不渲染 Markdown)。
//
// 不做完整解析,只做一组"宁可少剥,也别误伤"的保守替换:
//  - 颜文字常用 * 和 _ 当笔画((*/ω＼*)、¯\_(ツ)_/¯、(*^▽^*))。成对强调标记只在
//    内容以文字/数字开头时才剥;单个 * / _ 还要求标记外侧是边界,于是 2*3*4、a_b_c
//    这类算式与 URL 原样保留。
//  - emoji 不参与任何规则,天然原样保留。
//  - 代码块只去围栏、行内代码只去反引号:代码内容要留下(QQ 里照样要读)。
//  - 链接展开成「文字 (URL)」:QQ 不能点,但能复制。

/** 内容像正文才当作强调:首字符是文字/数字,末字符是文字/数字或句读。 */
const WORDY_START = /^[\p{L}\p{N}]/u;
const WORDY_END = /[\p{L}\p{N}][，。！？；：、,.!?;:…]*$/u;

function wordy(inner: string): boolean {
  return WORDY_START.test(inner) && WORDY_END.test(inner);
}

export function markdownToPlainText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");

  // 代码先摘出来:里面的 _ 和 * 是代码语义,不能被后面的强调规则碰。
  const fences: string[] = [];
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    fences.push(code.replace(/\n$/, ""));
    return `\u0000F${fences.length - 1}\u0000`;
  });
  const inline: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inline.push(code);
    return `\u0000I${inline.length - 1}\u0000`;
  });

  text = text
    // 图片/链接:保留可读文字,URL 附在括号里。
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string, url: string) =>
      alt.trim() ? `${alt.trim()} (${url})` : url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
      const name = label.trim();
      return !name || name === url ? url : `${name} (${url})`;
    })
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    // 强调:三连星先处理,否则会剩下一对没剥干净的 **。
    .replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/gu, (m, inner: string) => (wordy(inner) ? inner : m))
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/gu, (m, inner: string) => (wordy(inner) ? inner : m))
    .replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^\n*]*?\S)\*(?![\p{L}\p{N}*])/gu, (m, inner: string) => (wordy(inner) ? inner : m))
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^\n_]*?\S)_(?![\p{L}\p{N}_])/gu, (m, inner: string) => (wordy(inner) ? inner : m))
    .replace(/~~(?=\S)([^\n~]*?\S)~~/gu, (m, inner: string) => (wordy(inner) ? inner : m))
    // 行级标记:标题、引用、分割线、列表、任务清单、有序列表。
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^[ \t]*[-+*][ \t]+/gm, "")
    .replace(/^[ \t]{0,3}\[[ xX]\][ \t]+/gm, "")
    .replace(/^[ \t]{0,3}\d{1,2}[.)][ \t]+/gm, "");

  // 表格:丢掉分隔行(|---|),其余行去掉首尾竖线、单元格用 " | " 连接。
  text = text
    .split("\n")
    .filter((line) => !/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/.test(line))
    .map((line) => {
      if (!/^[ \t]*\|.*\|[ \t]*$/.test(line)) return line;
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      return cells.join(" | ");
    })
    .join("\n");

  text = text
    .replace(/\u0000I(\d+)\u0000/g, (_m, index: string) => inline[Number(index)] ?? "")
    .replace(/\u0000F(\d+)\u0000/g, (_m, index: string) => fences[Number(index)] ?? "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
