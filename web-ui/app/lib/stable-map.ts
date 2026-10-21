import * as React from "react";

/** 两个 Map 是否逐项相等(键集合一致且值 === 相等)。 */
export function mapsShallowEqual<V>(a: Map<string, V>, b: Map<string, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) return false;
  }
  return true;
}

/**
 * 内容相等时复用上一次的 Map 引用(useMemo 的"按值比较"逃生舱)。
 *
 * 典型场景(代码块流式重挂载根修):citation map 由 message.parts 派生,流式期间
 * parts 每个 delta 都是新数组,若 Map 每帧换新引用,会沿 Markdown 的 components
 * useMemo 一路把 components.code 变成新函数身份 → React 每帧整棵重挂载代码块
 * (高亮闪烁、滚动清零、观察不到 isAnimating 转换)。Map 内容只随 annotations/
 * 工具输出变,按内容比较复用旧引用,引用链在纯文本流式期间保持稳定。
 */
export function useStableMap<V>(next: Map<string, V>): Map<string, V> {
  const ref = React.useRef(next);
  const stable = mapsShallowEqual(ref.current, next) ? ref.current : next;
  ref.current = stable;
  return stable;
}
