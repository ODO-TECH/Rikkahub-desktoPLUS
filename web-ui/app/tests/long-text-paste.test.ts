// tests/long-text-paste.test.ts — 长文本粘贴转 txt 的阈值归一化与判定
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LONG_TEXT_THRESHOLD,
  LONG_TEXT_THRESHOLD_MAX,
  LONG_TEXT_THRESHOLD_MIN,
  normalizeLongTextThreshold,
  shouldConvertLongText,
} from "~/lib/long-text-paste";

describe("normalizeLongTextThreshold", () => {
  test("缺省/空串/非法值回默认 5000", () => {
    expect(normalizeLongTextThreshold(undefined)).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
    expect(normalizeLongTextThreshold(null)).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
    expect(normalizeLongTextThreshold("")).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
    expect(normalizeLongTextThreshold("abc")).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
    expect(normalizeLongTextThreshold(Number.NaN)).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
    expect(normalizeLongTextThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LONG_TEXT_THRESHOLD);
  });

  test("数字与数字字符串生效,小数四舍五入", () => {
    expect(normalizeLongTextThreshold(8000)).toBe(8000);
    expect(normalizeLongTextThreshold("8000")).toBe(8000);
    expect(normalizeLongTextThreshold(1200.6)).toBe(1201);
  });

  test("夹在 500–50000 之间", () => {
    expect(normalizeLongTextThreshold(0)).toBe(LONG_TEXT_THRESHOLD_MIN);
    expect(normalizeLongTextThreshold(100)).toBe(LONG_TEXT_THRESHOLD_MIN);
    expect(normalizeLongTextThreshold(999_999)).toBe(LONG_TEXT_THRESHOLD_MAX);
  });
});

describe("shouldConvertLongText", () => {
  const text = (length: number) => "字".repeat(length);

  test("开关关闭时永不转换", () => {
    expect(shouldConvertLongText(text(60_000), false, 5000)).toBe(false);
  });

  test("等于阈值留在输入框,超过才转换", () => {
    expect(shouldConvertLongText(text(5000), true, 5000)).toBe(false);
    expect(shouldConvertLongText(text(5001), true, 5000)).toBe(true);
  });

  test("空文本不转换", () => {
    expect(shouldConvertLongText("", true, 500)).toBe(false);
  });

  test("阈值非法时按默认值判定", () => {
    expect(shouldConvertLongText(text(6000), true, "oops")).toBe(true);
    expect(shouldConvertLongText(text(4000), true, "oops")).toBe(false);
  });
});
