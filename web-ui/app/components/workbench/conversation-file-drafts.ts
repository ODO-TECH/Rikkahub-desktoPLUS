// 文件侧栏的未保存草稿暂存(0.0.3 Feature A)。
// 面板按会话挂载(WorkbenchHost 用 conversationId 做 key),切换会话/关闭面板会卸载组件,
// 草稿若只放在组件 state 里就丢了。这里用模块级 Map 按“作用域 + 文件路径”暂存脏文本:
// 重新打开同一文件时自动回到编辑态并恢复,保存或明确放弃后清除。仅内存,退出应用即失效。

export interface StoredFileDraft {
  /** 用户的未保存文本。 */
  text: string;
  /** 草稿基于的磁盘文本(恢复时若磁盘已变,用来提示冲突)。 */
  savedText: string;
  /** 开始编辑时的 etag;与恢复时的最新 etag 不同 = 磁盘被改过。 */
  etag: string | null;
}

const drafts = new Map<string, StoredFileDraft>();

function storeKey(scope: string, path: string): string {
  return `${scope}\u0000${path}`;
}

export function saveFileDraft(scope: string, path: string, draft: StoredFileDraft): void {
  drafts.set(storeKey(scope, path), draft);
}

export function loadFileDraft(scope: string, path: string): StoredFileDraft | null {
  return drafts.get(storeKey(scope, path)) ?? null;
}

export function clearFileDraft(scope: string, path: string): void {
  drafts.delete(storeKey(scope, path));
}

/** 重命名/删除后清掉该路径及其子树的草稿(路径已不存在,恢复没有意义)。 */
export function clearFileDraftsUnder(scope: string, path: string): void {
  const exact = storeKey(scope, path);
  const prefix = `${storeKey(scope, path)}/`;
  for (const key of drafts.keys()) {
    if (key === exact || key.startsWith(prefix)) drafts.delete(key);
  }
}

export function countFileDrafts(scope: string): number {
  const prefix = `${scope}\u0000`;
  let count = 0;
  for (const key of drafts.keys()) if (key.startsWith(prefix)) count += 1;
  return count;
}
