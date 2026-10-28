// im/markdown.test.ts — 纯文本降级的边界:剥 Markdown,但绝不碰颜文字、emoji 和 URL。
//
// 每个用例对应一类真实出现过的模型输出。最要紧的是「不误伤」那组:
// (*/ω＼*)、¯\_(ツ)_/¯ 一旦被当成斜体剥掉,用户看到的是一张坏掉的脸。

import { describe, expect, test } from "bun:test";

import { markdownToPlainText } from "./markdown";

describe("行级标记", () => {
  test("标题、引用、无序/有序列表、任务清单去掉行首标记", () => {
    const input = [
      "# 标题",
      "> 引用一句",
      "- 第一项",
      "* 第二项",
      "+ 第三项",
      "1. 第一步",
      "2) 第二步",
      "- [x] 已完成",
      "- [ ] 未完成",
    ].join("\n");
    expect(markdownToPlainText(input)).toBe(
      ["标题", "引用一句", "第一项", "第二项", "第三项", "第一步", "第二步", "已完成", "未完成"].join("\n"),
    );
  });

  test("分割线整行移除;#话题#、>= 这类正文原样", () => {
    const input = "---\n#话题# 今天\n>= 3 才通过\n***";
    expect(markdownToPlainText(input)).toBe("#话题# 今天\n>= 3 才通过");
  });

  test("没有空格的 #标题 不当标题(可能是话题标签)", () => {
    expect(markdownToPlainText("#每日一句")).toBe("#每日一句");
  });
});

describe("强调与删除线", () => {
  test("加粗/斜体/删除线去掉标记,中文紧贴标记也能剥", () => {
    expect(markdownToPlainText("这是**重点**内容")).toBe("这是重点内容");
    expect(markdownToPlainText("**结论：** 可以")).toBe("结论： 可以");
    expect(markdownToPlainText("*斜体* 开头")).toBe("斜体 开头");
    expect(markdownToPlainText("_斜体_ 开头")).toBe("斜体 开头");
    expect(markdownToPlainText("~~删掉~~这行")).toBe("删掉这行");
    expect(markdownToPlainText("***很重要***")).toBe("很重要");
  });

  test("占位符不是 Markdown:下划线包着的内容原样", () => {
    expect(markdownToPlainText("__init__.py 与 a_b_c")).toBe("__init__.py 与 a_b_c");
  });
});

describe("代码", () => {
  test("代码块只去围栏,代码内容里的星号/下划线原样", () => {
    const input = "看这段:\n```js\nconst a = b ** c;\nconst snake_case = 1;\n```\n结束";
    expect(markdownToPlainText(input)).toBe(
      "看这段:\nconst a = b ** c;\nconst snake_case = 1;\n结束",
    );
  });

  test("行内代码只去反引号", () => {
    expect(markdownToPlainText("运行 `bun test` 即可")).toBe("运行 bun test 即可");
  });
});

describe("链接", () => {
  test("链接展开成「文字 (URL)」,文字与 URL 相同时只留一份", () => {
    expect(markdownToPlainText("见[文档](https://a.com/x)")).toBe("见文档 (https://a.com/x)");
    expect(markdownToPlainText("[https://a.com](https://a.com)")).toBe("https://a.com");
  });

  test("图片保留 alt 和 URL,空 alt 只留 URL", () => {
    expect(markdownToPlainText("![示意图](https://a.com/p.png)")).toBe("示意图 (https://a.com/p.png)");
    expect(markdownToPlainText("![](https://a.com/p.png)")).toBe("https://a.com/p.png");
  });

  test("自动链接去掉尖括号", () => {
    expect(markdownToPlainText("地址 <https://a.com/x>")).toBe("地址 https://a.com/x");
  });
});

describe("不误伤", () => {
  test("颜文字原样保留", () => {
    const kaomoji = [
      "(*/ω＼*)",
      "¯\\_(ツ)_/¯",
      "(*^▽^*)",
      "*\\(^_^)/*",
      "(๑•̀ㅂ•́)و✧",
      "(￣▽￣)~*",
      "(*´▽`*)",
      "ヽ(✿ﾟ▽ﾟ)ノ",
    ];
    for (const face of kaomoji) {
      expect(markdownToPlainText(face)).toBe(face);
    }
  });

  test("emoji 原样保留(包括与加粗混排)", () => {
    expect(markdownToPlainText("**完成啦** 🎉😀❤️")).toBe("完成啦 🎉😀❤️");
    expect(markdownToPlainText("👍🏽 好")).toBe("👍🏽 好");
  });

  test("URL 里的下划线与算式里的星号不动", () => {
    expect(markdownToPlainText("https://a.com/a_b_c")).toBe("https://a.com/a_b_c");
    expect(markdownToPlainText("2*3*4")).toBe("2*3*4");
    expect(markdownToPlainText("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});

describe("表格与收尾", () => {
  test("去掉分隔行,单元格整理成一行", () => {
    const input = ["| 名称 | 数量 |", "| --- | ---: |", "| 苹果 | 3 |"].join("\n");
    expect(markdownToPlainText(input)).toBe(["名称 | 数量", "苹果 | 3"].join("\n"));
  });

  test("全是标记时返回空串(调用方另有兜底文案)", () => {
    expect(markdownToPlainText("---")).toBe("");
    expect(markdownToPlainText("\n\n")).toBe("");
  });

  test("普通文本原样(只统一换行与多余空行)", () => {
    expect(markdownToPlainText("你好\r\n\r\n\r\n再见")).toBe("你好\n\n再见");
  });
});
