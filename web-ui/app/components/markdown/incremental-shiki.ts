// incremental-shiki.ts — 流式代码块的行级增量分词(专题2 H-a)
//
// 问题:shiki 全量分词是主线程同步操作,12KB tsx 实测 ~35-40ms;流式中的代码块每个
// delta 帧都在增长,全文缓存永不命中,等于每帧全量重分词——单高亮一项就超掉 33ms
// 帧预算,是"流式输出不丝滑"的最大单点。
//
// 解法(编辑器级标准做法):利用 TextMate 语法的逐行状态机特性。shiki 的多主题
// codeToTokens 会把行末 GrammarState 存进以 result.tokens 为键的内部 WeakMap,
// getLastGrammarState(tokens) 取出后可作为 grammarState 传入下一次 codeToTokens
// 续算。本模块维护"已提交前缀"(committed):内容只追加时,已完成的行只分词一次,
// 每帧真正重算的只有最后一个未完成行——成本与代码总长度彻底解耦
// (实测尾行增量 0.019ms vs 全文 34.9ms)。
//
// 正确性契约(有单测逐 token 对照):对任意"只追加"的内容序列,本模块产出的 token
// 与对当前全文做一次全量 codeToTokens 的结果在渲染字段(content/color/bgColor/
// fontStyle/htmlStyle)上完全一致。保证手段:
// - 每一行的内容恰好被喂给分词器一次(提交路径),状态链与全量分词逐行推进等价;
// - 未完成的尾行不提交状态,下一帧带着旧状态重算;
// - 非追加变化(编辑/回退/替换)→ 整体重置,退化为一次全量分词(与现状同价,一次性);
// - CRLF 内容不走增量(shiki 对行中 \r 的处理与"\r 悬在段尾"不一致,粘贴的静态
//   Windows 文本本来就一次分词即缓存,增量没有收益)——每次全量,行为与现状一致。
import type {
  BundledLanguage,
  BundledTheme,
  GrammarState,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";

export interface TokenizedCode {
  bg: string;
  fg: string;
  tokens: ThemedToken[][];
}

export interface StreamingTokenizeResult {
  result: TokenizedCode;
  /** 本次调用是否从零开始全量分词(首次/重置/CRLF 路径)。调用方以此决定是否写全文缓存。 */
  wasFullTokenize: boolean;
}

export interface StreamingTokenizer {
  tokenize: (code: string) => StreamingTokenizeResult;
}

export function createStreamingTokenizer(
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>,
  language: BundledLanguage,
  themes: { light: BundledTheme; dark: BundledTheme },
): StreamingTokenizer {
  let committedText = "";
  let committedTokens: ThemedToken[][] = [];
  let state: GrammarState | undefined;
  let bg = "transparent";
  let fg = "inherit";

  const segmentTokens = (segment: string): ThemedToken[][] => {
    const r = highlighter.codeToTokens(segment, {
      lang: language,
      themes,
      ...(state ? { grammarState: state } : {}),
    });
    bg = r.bg ?? bg;
    fg = r.fg ?? fg;
    return r.tokens;
  };

  const reset = () => {
    committedText = "";
    committedTokens = [];
    state = undefined;
  };

  const tokenize = (code: string): StreamingTokenizeResult => {
    // CRLF:不做增量(见文件头),整体一次分词。结果与全量调用逐字节相同。
    if (code.includes("\r")) {
      reset();
      const tokens = segmentTokens(code);
      state = undefined; // segmentTokens 不推进 state;防御性归零
      return { result: { bg, fg, tokens }, wasFullTokenize: true };
    }
    if (!code.startsWith(committedText)) reset();
    const wasFullTokenize = committedText === "";

    let tail = code.slice(committedText.length);
    const lastNewline = tail.lastIndexOf("\n");
    if (lastNewline >= 0) {
      // 提交路径:tail 里所有已完成的行(不含结尾 \n)分词一次并推进状态链。
      const chunk = tail.slice(0, lastNewline);
      const chunkTokens = segmentTokens(chunk);
      state = highlighter.getLastGrammarState(chunkTokens);
      committedTokens = committedTokens.concat(chunkTokens);
      committedText += tail.slice(0, lastNewline + 1);
      tail = tail.slice(lastNewline + 1);
    }
    // 未完成的尾行:带着已提交状态重算,不推进状态(下一帧重算)。
    const tailTokens = segmentTokens(tail);
    return {
      result: { bg, fg, tokens: committedTokens.concat(tailTokens) },
      wasFullTokenize,
    };
  };

  return { tokenize };
}
