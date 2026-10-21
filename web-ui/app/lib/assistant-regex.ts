import type { AssistantProfile } from "~/types";

type AffectScope = "USER" | "ASSISTANT";

function regexScopes(value: unknown): Set<AffectScope> {
  const items = Array.isArray(value) ? value.map(String) : [];
  return new Set(
    items
      .map((item) => item.toUpperCase())
      .filter((item): item is AffectScope => item === "USER" || item === "ASSISTANT"),
  );
}

// 批次二 R8-3:助手正则此前每次渲染逐条 new RegExp——消息的每个 text part 每帧(流式
// 期间逐 token delta)都全量重编译;且正则可经备份导入/助手分享携带灾难性回溯 pattern
// (ReDoS,如 (a+)+$),一条即可冻结渲染线程。防线三层:
//   1. 模块级编译缓存:同一 pattern 只编译一次(null = 编译失败或已判定病态,会话内禁用);
//   2. 长度上限:超长 pattern 直接拒绝(正常查找替换用不到 500 字符);
//   3. 超时降级:单次 replace 超预算即拉黑该 pattern。JS 无法中断执行中的正则,但流式
//      渲染文本是逐段增长的——回溯成本随长度指数上升,会在预算量级(几十 ms)而非
//      "秒/分钟"量级被截获拉黑,后续渲染(含更长文本)不再执行它。
// 残余风险:一次性渲染超长历史文本(导入会话)时首跑可能超预算较多,属已知取舍;
// 彻底根除需 RE2 类线性引擎,对 P3 威胁面不值得引入 wasm 依赖。
const MAX_PATTERN_LENGTH = 500;
const SLOW_PATTERN_BUDGET_MS = 50;
const REGEX_CACHE_MAX_ENTRIES = 300;
const regexCache = new Map<string, RegExp | null>();

function compiledRegex(findRegex: string): RegExp | null {
  const cached = regexCache.get(findRegex);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  if (findRegex.length <= MAX_PATTERN_LENGTH) {
    try {
      compiled = new RegExp(findRegex, "g");
    } catch {
      compiled = null;
    }
  }
  // 容量护栏:键来自助手配置,正常远到不了上限;恶意导入塞爆时整体重置,避免无界增长。
  if (regexCache.size >= REGEX_CACHE_MAX_ENTRIES) regexCache.clear();
  regexCache.set(findRegex, compiled);
  return compiled;
}

export function applyAssistantRegexes(
  text: string,
  assistant: AssistantProfile | null | undefined,
  scope: AffectScope,
  visual: boolean,
) {
  if (!assistant || !Array.isArray(assistant.regexes) || assistant.regexes.length === 0) {
    return text;
  }

  return assistant.regexes.reduce((current, regex) => {
    if (!regex || typeof regex !== "object" || Array.isArray(regex)) return current;
    if (
      regex.enabled === false ||
      regex.visualOnly !== visual ||
      !regexScopes(regex.affectingScope).has(scope)
    ) {
      return current;
    }

    const findRegex = String(regex.findRegex ?? "").trim();
    if (!findRegex) return current;

    const pattern = compiledRegex(findRegex);
    if (!pattern) return current;

    const startedAt = performance.now();
    try {
      return current.replace(pattern, String(regex.replaceString ?? ""));
    } catch {
      return current;
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed > SLOW_PATTERN_BUDGET_MS) {
        regexCache.set(findRegex, null);
        console.warn(
          `[assistant-regex] pattern disabled for this session (took ${Math.round(elapsed)}ms): ${findRegex.slice(0, 80)}`,
        );
      }
    }
  }, text);
}
