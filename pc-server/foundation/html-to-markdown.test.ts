// foundation/html-to-markdown.test.ts — 手写 HTML→Markdown 的解析契约
import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, htmlToReadable, parseHtml } from "./html-to-markdown";

describe("结构保留", () => {
  test("标题层级、段落、粗斜体、行内代码", () => {
    const md = htmlToMarkdown(`<h2>  Hello <em>World</em></h2><p>Body with <strong>bold</strong> and <code>a <!-- rawcode --> b</code>.</p>`);
    expect(md).toBe("## Hello World\n\nBody with bold and `a b`.");
  });

  test("隐式闭合的 <p> 不塌成一坨", () => {
    const md = htmlToMarkdown("<p>1<p>2<p>3");
    expect(md.split("\n\n")).toEqual(["1", "2", "3"]);
  });

  test("列表：有序/无序/嵌套，缩进两级", () => {
    const md = htmlToMarkdown("<ul><li>one<li>two</ul><ol start='3'><li>third</li><li>fourth<ol><li>nested</li></ol></li></ol>");
    expect(md).toBe(["- one", "- two", "", "3. third", "4. fourth", "  1. nested"].join("\n"));
  });

  test("li 未闭合 + 嵌套 ul 混排", () => {
    const md = htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li></ul>");
    expect(md).toBe("- a\n  - b");
  });

  test("代码块保留换行，不吞 pre 内的 <标签> 文本", () => {
    const md = htmlToMarkdown("<pre><code>if (a &lt; b) {\n  return 1;\n}</code></pre>");
    expect(md).toBe("```\nif (a < b) {\n  return 1;\n}\n```");
  });

  test("引用逐行加前缀", () => {
    const md = htmlToMarkdown("<blockquote><p>line one</p><p>line two</p></blockquote>");
    expect(md).toBe("> line one\n>\n> line two");
  });

  test("表格补齐 GFM 分隔行", () => {
    const md = htmlToMarkdown("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>");
    expect(md).toBe("| a | b |\n| --- | --- |\n| c | d |");
  });

  test("表格单元格里的竖线被转义", () => {
    const md = htmlToMarkdown("<table><tr><th>x|y</th><th>z</th></tr></table>");
    expect(md).toBe("| x\\|y | z |\n| --- | --- |");
  });

  test("hr 与 br", () => {
    expect(htmlToMarkdown("<p>a<br>b</p><hr><p>c</p>")).toBe("a\nb\n\n---\n\nc");
  });
});

describe("链接与实体", () => {
  test("相对链接按 baseUrl 绝对化", () => {
    const md = htmlToMarkdown('<a href="/docs/a">Docs</a> <img src="i.png" alt="图">', "https://example.com/page?q=1");
    expect(md).toBe("[Docs](https://example.com/docs/a) ![图](https://example.com/i.png)");
  });

  test("锚点与 javascript: 链接退化为纯文本", () => {
    expect(htmlToMarkdown('<a href="#top">跳顶</a>')).toBe("跳顶");
    expect(htmlToMarkdown('<a href="javascript:void(0)">按钮</a>')).toBe("按钮");
  });

  test("链接文本里的方括号转义而非删除", () => {
    expect(htmlToMarkdown('<a href="https://a.com">引用 [1]</a>')).toBe("[引用 \\[1\\]](https://a.com)");
  });

  test("命名字典与数字实体（含十进制）", () => {
    expect(htmlToMarkdown("<p>A &amp; B &lt; C &mdash; D &#x2714; &#8212; &nbsp;</p>")).toBe("A & B < C — D ✔ —");
  });

  test("未知实体原样保留，不静默丢字", () => {
    expect(htmlToMarkdown("<p>&qqe;</p>")).toBe("&qqe;");
  });

  test("属性值里的 > 不截断标签", () => {
    const md = htmlToMarkdown('<p title="a>b">正文</p>');
    expect(md).toBe("正文");
  });

  test("裸 < 当文本处理", () => {
    expect(htmlToMarkdown("<p>2 < 3 is true</p>")).toBe("2 < 3 is true");
  });
});

describe("清洗与正文提取", () => {
  test("脚本/样式/导航/页脚整棵子树丢弃", () => {
    const html = "<html><head><style>a{content:'<div>'}</style><script>if(1<2){}</script></head>"
      + "<body><nav>菜单一 菜单二</nav><main>真正的正文，够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长够长。</main><footer>版权</footer></body></html>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("真正的正文");
    expect(md).not.toContain("菜单");
    expect(md).not.toContain("版权");
    expect(md).not.toContain("content");
  });

  test("title 提取 + main 候选过短时回落整页", () => {
    const readable = htmlToReadable("<html><head><title>页面  标题</title></head><body><main>短</main><p>兜底正文内容</p></body></html>");
    expect(readable.title).toBe("页面 标题");
    expect(readable.markdown).toContain("兜底正文内容");
  });

  test("无 main/article 时取整页，title 缺失回落首个 h1/h2", () => {
    const readable = htmlToReadable("<article><h1>标题来自 H1</h1><p>内容</p></article>");
    expect(readable.title).toBe("标题来自 H1");
    expect(readable.markdown).toContain("内容");
  });

  test("截断页（缺 </body></html>）仍能出正文", () => {
    const md = htmlToMarkdown("<html><body><h2>半截页面</h2><p>内容还在");
    expect(md).toBe("## 半截页面\n\n内容还在");
  });

  test("textarea 内容不当作标记解析", () => {
    expect(htmlToMarkdown("<textarea><script>alert(1)</script></textarea><p>后</p>")).toBe("<script>alert(1)</script>\n\n后");
  });
});

describe("parseHtml 结构", () => {
  test("未闭合标签在文档末尾自动收拢", () => {
    const { root } = parseHtml("<div><span>abc");
    const text = JSON.stringify(root);
    expect(text).toContain("abc");
  });
});
