// im/util.ts — IM 接入的通用小工具:分片、去重、按会话串行
//
// 三件小事各自都短,但都是"错了就静默丢消息"的地方,集中一处便于单测。

/**
 * 按平台字数上限切分长文本。
 *
 * 优先在段落/句子边界断开:IM 里一条回答被劈成两串气泡已经够糟,劈在单词中间更难读。
 * 找不到任何边界(超长无空格的一整块,如 base64)才硬切。
 */
export function splitMessage(text: string, limit: number): string[] {
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("。", limit);
    if (cut <= 0) cut = remaining.lastIndexOf(". ", limit);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;

    // 段落/句末分隔符留在前一片,读起来才是完整的一句。
    const ch = remaining[cut];
    if (ch === "\n" || ch === "." || ch === "。") cut += 1;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * 消息去重:平台重连后把同一条消息再推一次是常态(QQ 网关重放、微信 getupdates 位点
 * 回退),不去重就会看到助手把同一句话答两遍。
 */
export class MessageDedup {
  private store = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 5_000,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    // 清扫定时器不该单独把事件循环留着(退出时靠它只会拖住进程)。
    this.sweeper.unref?.();
  }

  /** 新消息返回 true;重复返回 false。 */
  tryRecord(key: string): boolean {
    const now = Date.now();
    const seen = this.store.get(key);
    if (seen !== undefined && now - seen < this.ttlMs) return false;
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, now);
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, at] of this.store) {
      if (now - at >= this.ttlMs) this.store.delete(key);
      else break; // Map 保持插入序,撞到新的就可以停
    }
  }

  destroy(): void {
    clearInterval(this.sweeper);
    this.store.clear();
  }
}

/**
 * 同一会话串行处理。
 *
 * 两条快发的消息若并发进入,会各自读到"还没有会话绑定"并各建一个本机会话,或者把
 * 生成队列的顺序拧乱。按 chatId 串成一条 Promise 链即可,跨会话互不阻塞。
 */
const chains = new Map<string, Promise<void>>();

export function enqueueForChat<T>(chatKey: string, task: () => Promise<T>): Promise<T | undefined> {
  const prev = chains.get(chatKey) ?? Promise.resolve();
  let result: T | undefined;
  const next = prev
    .catch(() => undefined)
    .then(task)
    .then((value) => {
      result = value;
    })
    .catch((err) => {
      console.error(`[IM] 会话 ${chatKey} 处理任务失败:`, err);
    });
  chains.set(chatKey, next);
  void next.finally(() => {
    if (chains.get(chatKey) === next) chains.delete(chatKey);
  });
  return next.then(() => result);
}
