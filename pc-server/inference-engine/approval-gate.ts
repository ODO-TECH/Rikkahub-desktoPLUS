// inference-engine/approval-gate.ts — 在途工具审批的等待/决定汇合点(P3;T2 迁出 pi-engine)
//
// 语义:run-and-suspend 引擎(pi)把审批内化到 customTool.execute 里(方案 §4.4)——工具
// 执行到需要审批时挂 pending 卡并在这里登记等待;用户经 tool-approval API 决定后,由
// resolveToolApproval 唤醒在途 execute 继续(放行/拒绝)。生成保持在跑(与聊天引擎
// "整批暂停→重触发续跑"的两段式不同,语义变化已在方案 §4.4 向用户披露,P3 验收演示)。
//
// 定位(T2):这是引擎无关的"等待者登记表"——任何把审批内化为 run-and-suspend 的引擎
// 都用它汇合;聊天引擎的 pause-resume 路径不经此表。迁出 pi-engine 与 events.ts 同层,
// 表明它不归属单一引擎。
//
// 纪律:零 pi 导入——tool-approval API(api/handlers/conversations.ts)要 import 本模块,
// 不能把引擎依赖树拖进 api 层;本模块也不碰 parts/SQLite/SSE(那是应用器与 API 的事),
// 只做"等待者登记表"这一件事。
//
// 生命周期:等待者随决定/中止即刻注销;引擎 runner 在生成收尾时 clearToolApprovalWaiters
// 兜底清扫(防泄漏)。跨重启的孤儿审批(卡 pending 但生成已死)不在本表——API 端
// 查不到等待者时按"仅记录状态"处理,见 handlers 注释。

export interface ToolApprovalDecision {
  approved: boolean;
  /** 拒绝理由(前端拒绝框可留空;放行时无意义)。 */
  reason?: string;
  /** ask_user 答复载荷(契约:扁平 JSON 字符串 {"answers":{qid:string}},tools/ask-user.ts)。
   *  仅 ask_user 路径填;普通审批工具恒 undefined。聊天引擎忽略它(其 resume 读持久化
   *  part 的 approvalState.answer);run-and-suspend 引擎(pi)靠它把答案送回在途 execute。 */
  answer?: string;
}

interface Waiter {
  conversationId: string;
  /** 等待者归属的审批作用域。主生成 = conversationId 自身;子生成(子智能体)领各自的
   *  scope,收尾清扫互不波及。决议不按 scope 查找(见 resolveToolApproval),scope 只
   *  用于"谁能清扫谁"。 */
  scope: string;
  resolve: (decision: ToolApprovalDecision) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

const waiters = new Map<string, Waiter>();

function keyOf(scope: string, conversationId: string, toolCallId: string): string {
  // \u0000 作分隔符(ID 里不可能出现);用转义写法,字面 NUL 会让 rg 把文件当二进制跳过。
  return `${scope}\u0000${conversationId}\u0000${toolCallId}`;
}

/** 登记一次审批等待。用户决定 → resolve;signal 中止 → reject AbortError(调用方负责
 *  把卡收敛为 denied 后再上抛,见 pi-engine/workspace-tools.ts)。
 *  scope 缺省 = conversationId(主生成路径,行为与 scope 引入前逐字节一致)。 */
export function waitForToolApproval(
  conversationId: string,
  toolCallId: string,
  signal?: AbortSignal,
  scope?: string,
): Promise<ToolApprovalDecision> {
  const effectiveScope = scope ?? conversationId;
  return new Promise<ToolApprovalDecision>((resolve, reject) => {
    const key = keyOf(effectiveScope, conversationId, toolCallId);
    const onAbort = () => {
      waiters.delete(key);
      reject(new DOMException("Generation stopped", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    // 同键重复登记不应发生(toolCallId 唯一且一次执行只等待一次);真发生时旧等待者
    // 已成孤儿,按中止收敛,绝不让它悬挂。
    const stale = waiters.get(key);
    if (stale) {
      waiters.delete(key);
      stale.cleanup();
      stale.reject(new DOMException("Superseded by a newer approval wait", "AbortError"));
    }
    if (signal?.aborted) {
      reject(new DOMException("Generation stopped", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.set(key, {
      conversationId,
      scope: effectiveScope,
      resolve: (decision) => {
        cleanup();
        resolve(decision);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      cleanup,
    });
  });
}

/** 用户决定送达。返回 true = 有在途等待者被唤醒(生成在跑,API 不应再触发续跑);
 *  false = 无在途等待(孤儿审批:生成已死/已重启,API 仅记录状态)。
 *  按 conversationId+toolCallId 跨 scope 查找:toolCallId 由引擎侧生成且全局唯一,
 *  前端/API 回传时无需携带 scope(子智能体的审批卡与主生成同端点)。 */
export function resolveToolApproval(
  conversationId: string,
  toolCallId: string,
  decision: ToolApprovalDecision,
): boolean {
  for (const [key, waiter] of waiters) {
    if (waiter.conversationId !== conversationId) continue;
    if (!key.endsWith(`\u0000${toolCallId}`)) continue;
    waiters.delete(key);
    waiter.resolve(decision);
    return true;
  }
  return false;
}

/** 生成收尾兜底:清扫在途等待(正常路径下等待者已随决定/中止注销,此处只防实现
 *  疏漏导致的 Promise 泄漏)。传 scope 只清该作用域——子生成用各自的 scope,收尾
 *  不会误杀并发兄弟(或父生成)仍在等待的审批。不传 = 该会话全部作用域(旧语义)。 */
export function clearToolApprovalWaiters(conversationId: string, scope?: string): void {
  for (const [key, waiter] of waiters) {
    if (waiter.conversationId !== conversationId) continue;
    if (scope !== undefined && waiter.scope !== scope) continue;
    waiters.delete(key);
    waiter.reject(new DOMException("Generation finished", "AbortError"));
  }
}

/** 测试观测面。 */
export function pendingToolApprovalCount(): number {
  return waiters.size;
}
