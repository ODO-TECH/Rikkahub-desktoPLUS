// tools/subagent.ts — 子智能体派遣内核(subagent_dispatch,PC-only)
//
// 定位:主 AI 把子任务派给若干"子智能体"——每个子任务跑在一次干净上下文的独立生成里,
// 干完只把摘要带回主对话。安全模型不新建:子智能体的工具调用照样过审批矩阵与工作区
// 边界,本内核只负责"编排"(任务数/并发/预算/写串行/摘要聚合),不碰审批、不碰存储。
//
// 纪律:
// - 零 pi / 零引擎导入。子任务怎么跑由调用方装配时注册的 SubagentChildRunner 决定
//   (pi 引擎实现在 pi-engine/subagent-tools.ts;测试注册 mock)。本模块不进任何循环依赖。
// - 不落库、不发事件。摘要文本是唯一产出,回灌模型;UI 侧走工具结果卡。
// - 深度锁 1 层是结构性的:子面工具装配恒剔除 subagent_dispatch(见 pi-engine/subagent-tools.ts),
//   本内核不提供递归入口。

import type { JsonValue } from "../foundation/types";
import type { SubagentConfig, SubagentToolName } from "../foundation/types/settings/subagent-config";

/** 单任务摘要的长度上限。子智能体输出的全文可能很长,回灌父模型只保摘要段——
 *  超限截断并留注记,防一次 dispatch 挤爆父上下文。 */
const SUMMARY_MAX_CHARS = 4_000;

/** 写类工具在 dispatch 内的路径互斥锁:同一绝对路径的 edit/write 串行执行,
 *  不同路径照常并行。锁的粒度=路径键(调用方传 resolve 后的绝对路径)。 */
export class SubagentPathLock {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.tails.set(key, chained);
    try {
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      release();
      // 尾节点回收:没有后来者排队时删表,防止长跑 dispatch 的 Map 无界增长。
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }
}

export interface SubagentChildRequest {
  /** 任务在本次 dispatch 中的序号(0 起;UI 标识与审批 scope 用)。 */
  index: number;
  title: string;
  prompt: string;
  /** 模型 id 或 modelId(调用方严格解析,未知即该任务失败,不静默回落 auto)。 */
  modelId?: string;
  /** dispatch 内的写路径互斥锁(子面 edit/write 的 execute 用它包裹执行)。 */
  writeLock: SubagentPathLock;
  signal?: AbortSignal;
}

export interface SubagentChildOutcome {
  /** 终局 assistant 文本(即摘要;调用方已 trim)。 */
  text: string;
  tokensUsed?: number;
}

export type SubagentChildRunner = (request: SubagentChildRequest) => Promise<SubagentChildOutcome>;

let registeredRunner: SubagentChildRunner | null = null;

/** 装配期注册子任务执行器(pi-engine/subagent-tools.ts 在模块加载时调用)。
 *  注册是幂等的:后注册覆盖先注册(测试可用 mock 覆盖真实引擎)。 */
export function registerSubagentChildRunner(runner: SubagentChildRunner): void {
  registeredRunner = runner;
}

/** 测试观测面。 */
export function resetSubagentChildRunnerForTests(): void {
  registeredRunner = null;
}

export interface SubagentTaskInput {
  title: string;
  prompt: string;
  model_id?: string;
}

export interface SubagentDispatchInput {
  mode: "single" | "parallel";
  tasks: SubagentTaskInput[];
}

interface NormalizedTask {
  index: number;
  title: string;
  prompt: string;
  modelId?: string;
}

interface TaskOutcome {
  title: string;
  ok: boolean;
  text: string;
  tokensUsed: number;
  error?: string;
  skipped?: boolean;
}

function normalizeTask(input: unknown, index: number): Omit<NormalizedTask, "index"> | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return `task #${index + 1}: task must be an object`;
  const record = input as Record<string, JsonValue>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  const modelId = typeof record.model_id === "string" && record.model_id.trim() ? record.model_id.trim() : undefined;
  if (!prompt) return `task #${index + 1}: prompt is required`;
  return { title: title || `task ${index + 1}`, prompt, ...(modelId ? { modelId } : {}) };
}

function truncateSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX_CHARS)}\n...(truncated ${trimmed.length - SUMMARY_MAX_CHARS} chars)`;
}

/** 并发受限的 map:结果按输入顺序返回,超并发排队。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatSummary(outcomes: TaskOutcome[], budget: number): string {
  const completed = outcomes.filter((item) => item.ok).length;
  const failed = outcomes.filter((item) => !item.ok && !item.skipped).length;
  const skipped = outcomes.filter((item) => item.skipped).length;
  const spent = outcomes.reduce((sum, item) => sum + item.tokensUsed, 0);
  const head = [
    `Subagent dispatch: ${completed}/${outcomes.length} completed`,
    failed ? `${failed} failed` : null,
    skipped ? `${skipped} skipped (token budget exhausted)` : null,
    `${spent} tokens used of ${budget} budget`,
  ]
    .filter(Boolean)
    .join(", ");
  const sections = outcomes.map((item, index) => {
    if (item.ok) {
      const usage = item.tokensUsed ? ` (${item.tokensUsed} tokens)` : "";
      return `${index + 1}. [OK] ${item.title}${usage}\n${truncateSummary(item.text) || "(empty response)"}`;
    }
    const reason = item.skipped ? "skipped: token budget exhausted" : `failed: ${item.error ?? "unknown error"}`;
    return `${index + 1}. [FAILED] ${item.title}\n${reason}`;
  });
  return [head, "", ...sections].join("\n");
}

/** 派遣入口。返回给模型看的摘要文本(含逐任务状态与用量);不抛业务错误——
 *  单任务失败只标段,让主 AI 决定是否重派(与聊天引擎"失败回灌模型可见"一致)。
 *  仅两种情形上抛:整单参数不合法(调用方会转成工具错误回灌)、父生成被中止(AbortError)。
 *  options.runner 优先于全局注册:pi 会话的装配点按次注入闭包(父上下文/cwd/资源),
 *  并发会话互不串用;聊天引擎走全局注册的默认执行器。 */
export async function runSubagentDispatch(
  input: SubagentDispatchInput,
  settings: SubagentConfig,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; runner?: SubagentChildRunner } = {},
): Promise<string> {
  const runner = options.runner ?? registeredRunner;
  if (!runner) throw new Error("Subagent engine is not ready (child runner not registered).");
  if (options.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");

  const mode = input.mode === "parallel" ? "parallel" : input.mode === "single" ? "single" : null;
  if (!mode) throw new Error(`Invalid subagent mode: ${String(input.mode)} (expected "single" or "parallel").`);
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length === 0) throw new Error("subagent_dispatch requires at least one task.");
  if (rawTasks.length > settings.maxTasksPerCall) {
    throw new Error(`Too many tasks: ${rawTasks.length} > maxTasksPerCall (${settings.maxTasksPerCall}). Split the work or raise the limit in settings.`);
  }
  if (mode === "single" && rawTasks.length !== 1) {
    throw new Error(`Mode "single" expects exactly 1 task, got ${rawTasks.length}. Use mode "parallel" for multiple tasks.`);
  }

  const normalized: NormalizedTask[] = [];
  const invalid: TaskOutcome[] = [];
  rawTasks.forEach((task, index) => {
    const parsed = normalizeTask(task, index);
    if (typeof parsed === "string") {
      invalid.push({ title: `task ${index + 1}`, ok: false, text: "", tokensUsed: 0, error: parsed });
    } else {
      normalized.push({ ...parsed, index });
    }
  });

  const writeLock = new SubagentPathLock();
  let tokensSpent = 0;
  let done = 0;
  const execute = async (task: NormalizedTask): Promise<TaskOutcome> => {
    if (options.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
    // 预算判在启动前:已耗尽则不再起新任务(在跑的单任务可能小幅超出自己的份额,
    // 这是"预算阀"而非"硬截断"的已知边界,见 docs/plan-subagent.md §4-1)。
    if (tokensSpent >= settings.tokenBudget) {
      return { title: task.title, ok: false, text: "", tokensUsed: 0, skipped: true };
    }
    try {
      const outcome = await runner({
        index: task.index,
        title: task.title,
        prompt: task.prompt,
        ...(task.modelId ? { modelId: task.modelId } : {}),
        writeLock,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const tokensUsed = Math.max(0, Math.round(outcome.tokensUsed ?? 0));
      tokensSpent += tokensUsed;
      done += 1;
      options.onProgress?.(done, rawTasks.length);
      return { title: task.title, ok: true, text: outcome.text, tokensUsed };
    } catch (err) {
      if (options.signal?.aborted) throw err;
      done += 1;
      options.onProgress?.(done, rawTasks.length);
      const message = err instanceof Error ? err.message : String(err);
      return { title: task.title, ok: false, text: "", tokensUsed: 0, error: message };
    }
  };

  const outcomes = await mapWithConcurrency(normalized, settings.maxConcurrency, execute);
  if (options.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  return formatSummary([...outcomes, ...invalid], settings.tokenBudget);
}

/** 供子面装配使用:该工具名是否允许进子智能体工具面。始终拒绝 subagent_dispatch
 *  (深度锁 1 层)与未在设置白名单内的工具。 */
export function isToolAllowedForSubagent(toolName: string, allowedTools: SubagentToolName[]): boolean {
  if (toolName === "subagent_dispatch") return false;
  return (allowedTools as string[]).includes(toolName);
}
