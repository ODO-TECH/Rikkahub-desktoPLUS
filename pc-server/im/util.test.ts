// im/util.test.ts — 分片与去重:这两件小事错了都只表现为"消息悄悄没了/重复了",
// 线上很难查,所以边界单独钉。

import { describe, expect, test } from "bun:test";

import { MessageDedup, splitMessage } from "./util";

describe("splitMessage", () => {
  test("不超限原样返回", () => {
    expect(splitMessage("你好", 10)).toEqual(["你好"]);
  });

  test("limit 非法时不切,交由平台报错", () => {
    expect(splitMessage("abc", 0)).toEqual(["abc"]);
  });

  test("优先在段落边界断开,且分隔符留在前一片", () => {
    const text = "第一段内容。\n\n第二段内容。";
    expect(splitMessage(text, 10)).toEqual(["第一段内容。", "第二段内容。"]);
  });

  test("没有段落就退到句号 / 空格", () => {
    expect(splitMessage("abcdefghij. klm", 12)).toEqual(["abcdefghij.", "klm"]);
    expect(splitMessage("hello world again", 12)).toEqual(["hello world", "again"]);
  });

  test("一整块无分隔符时硬切,且每片都不超限", () => {
    const text = "x".repeat(25);
    const chunks = splitMessage(text, 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(10);
  });

  test("任意长文本:片数够、每片超限为零、拼回去不丢字", () => {
    const text = Array.from({ length: 200 }, (_, i) => `第${i}行内容,有点长`).join("\n");
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  test("中文按字符计数(不受 UTF-16 代理对影响的前提是内容里没有 emoji)", () => {
    const chunks = splitMessage("一".repeat(15), 6);
    expect(chunks).toEqual(["一".repeat(6), "一".repeat(6), "一".repeat(3)]);
  });
});

describe("MessageDedup", () => {
  test("同一个键只放行一次", () => {
    const dedup = new MessageDedup();
    expect(dedup.tryRecord("qq:1")).toBe(true);
    expect(dedup.tryRecord("qq:1")).toBe(false);
    expect(dedup.tryRecord("qq:2")).toBe(true);
    dedup.destroy();
  });

  test("TTL 归零即视为过期(平台重放窗口之外可以再收)", () => {
    const dedup = new MessageDedup(0);
    expect(dedup.tryRecord("k")).toBe(true);
    expect(dedup.tryRecord("k")).toBe(true);
    dedup.destroy();
  });

  test("容量封顶时挤掉最旧的一条,不会无限涨", () => {
    const dedup = new MessageDedup(60_000, 2);
    dedup.tryRecord("a");
    dedup.tryRecord("b");
    dedup.tryRecord("c");
    // a 已被挤出:同名再来一次会被当成新消息。
    expect(dedup.tryRecord("b")).toBe(false);
    expect(dedup.tryRecord("a")).toBe(true);
    dedup.destroy();
  });
});
