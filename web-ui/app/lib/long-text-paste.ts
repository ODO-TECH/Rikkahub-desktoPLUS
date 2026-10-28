// lib/long-text-paste.ts — 长文本粘贴转 txt:阈值归一化与判定(纯函数)
//
// 超长文本若直接进 textarea,每次按键都要重排整段内容(实测 8 万字起单次更新
// 10–20ms、20 万字 20–32ms)。超过阈值时改走 txt 附件,输入框始终只持有短文本。
// 设置字段为 PC 独有的 pcPasteLongTextAsFile / pcPasteLongTextThreshold。

export const DEFAULT_LONG_TEXT_THRESHOLD = 5000;
export const LONG_TEXT_THRESHOLD_MIN = 500;
export const LONG_TEXT_THRESHOLD_MAX = 50000;

/** 归一化阈值:空/非法回默认值,数字夹在 500–50000 并对齐整数。 */
export function normalizeLongTextThreshold(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_LONG_TEXT_THRESHOLD;
  }
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_LONG_TEXT_THRESHOLD;
  return Math.min(LONG_TEXT_THRESHOLD_MAX, Math.max(LONG_TEXT_THRESHOLD_MIN, Math.round(raw)));
}

/** `length > threshold` 才转换(等于阈值仍留在输入框)。 */
export function shouldConvertLongText(
  text: string,
  enabled: boolean,
  threshold: unknown,
): boolean {
  if (!enabled || text.length === 0) return false;
  return text.length > normalizeLongTextThreshold(threshold);
}
