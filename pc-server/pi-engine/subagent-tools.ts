// pi-engine/subagent-tools.ts — subagent_dispatch 的 pi customTool 桥(P1)
//
// 与 general-tools 同纪律:声明单源(tools/definitions.openAiSubagentTool)、执行单源
// (tools/subagent.runSubagentDispatch)、审批不在 dispatch 本身上(子智能体内部的每次
// 工具调用才走 initialApprovalState → gateToolApproval,与父会话同一套矩阵/卡片)。
//
// 一次子任务 = 一次 runPiGeneration:
// - history: [] —— 干净 side-context,子智能体看不到父对话;
// - cwd/root 继承父会话引擎目录 —— 工作区边界壳照常生效;
// - approvalScopeId 每任务独立 —— 并发子审批互不误杀(P0),收尾清扫只清自己;
// - 子面工具从 createPiWorkspaceTools/createPiGeneralTools 现取后按 allowedTools 过滤,
//   subagent_dispatch 恒剔(深度锁 1 层);edit/write 外面包一层本次 dispatch 的路径锁;
// - sink 只把"工具卡 + 审批态 + 结果"转进父应用器(子过程文本/usage/保真不进去),
//   tool_call_created 打 metadata.subagent 标记,前端据此把卡归属到对应子任务;
// - capturedCompactions 丢弃:子上下文一次性,压缩语义不回灌父会话。

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ToolDefinition } from "../../pi/packages/coding-agent/src/core/extensions/types.ts";
import type { Assistant, Conversation, JsonValue, Model, Provider } from "../foundation/types";
import { isRecord } from "../foundation/utils";
import type { SubagentConfig } from "../foundation/types/settings/subagent-config";
import type { GenerationEventSink, GenerationTarget } from "../inference-engine/events";
import type { SubagentChildOutcome, SubagentChildRequest, SubagentChildRunner, SubagentPathLock } from "../tools/subagent";
import { isToolAllowedForSubagent, runSubagentDispatch, type SubagentDispatchInput } from "../tools/subagent";
import { openAiSubagentTool } from "../tools/definitions";
import { findModelStrict } from "../model-providers";
import type { PiModelLimits } from "./model-bridge";
import { createPiSessionResources } from "./resources";
import { runPiGeneration } from "./runner";
import { createPiWorkspaceTools } from "./workspace-tools";
import { createPiGeneralTools } from "./general-tools";

/** 子智能体的系统位追加:行为边界(一次性、自主完成、结果即交付)+ 审批披露
 *  (与父会话 stableGuidanceLines 同语义,子会话重复一遍不吃亏)。 */
const SUBAGENT_SYSTEM_PROMPT = [
  "You are a subagent working on a single delegated task. You cannot see the parent conversation; the task prompt is your complete brief.",
  "Work autonomously: inspect files, make the changes, verify them, and finish. Do not ask the user questions; if something is ambiguous, make a reasonable decision and state it in your final answer.",
  "Your final message is returned to the main agent as the task result — make it a concise, self-contained summary (what you did, where, and anything the main agent must know).",
  "Some tool calls require explicit user approval. If a call is denied, respect the decision and adjust your approach instead of retrying it unchanged.",
].join("\n");

export interface PiSubagentToolsContext {
  conversation: Conversation;
  assistant: Assistant;
  target?: GenerationTarget;
  sink: GenerationEventSink;
  /** 父生成生效供应商/模型(任务未指定 model_id 时的默认)。 */
  provider: Provider;
  model: Model;
  /** 父模型的极限(默认模型直接复用,免重算)。 */
  modelLimits?: PiModelLimits;
  /** model_id 命中其他模型时的极限解析(装配点注入,避免与 orchestrator 的目录缓存逻辑分叉)。 */
  resolveModelLimits: (provider: Provider, model: Model) => PiModelLimits;
  /** 引擎本地工作目录 / 工作区边界根(与父生成装配同值)。 */
  cwd: string;
  root: string;
  includeProjectAgentsFiles?: boolean;
  /** 父层已解析的环境说明(远程工作区 <workspace> 块),原样进每个子会话的系统面。
   *  子面不自行探测:同一份文本父已算过一次,并发子代理共用,SSH 探测不按子任务翻倍。 */
  extraSystemPrompt?: string;
  /** 是否给子面挂工作区工具(默认 true)。聊天引擎会话没有工作区,子面只留通用工具
   *  (search_web/scrape_web),否则每次调用都会撞工作区守卫。 */
  includeWorkspaceTools?: boolean;
}

interface ChildSink {
  sink: GenerationEventSink;
  tokensUsed: () => number;
}

/** 子生成事件 → 父应用器的过滤桥。
 *  进入父流:工具卡/参数增量/审批态/工具结果(审批卡与子工具进度要可见可点)。
 *  不进父流:文本/思维链/图片增量(子对话不铺进父气泡)、保真注解、终局事件、usage
 *  (用量在摘要里单独报,父消息统计不被子任务污染)。
 *  engine_status 只做"并发审批等待"的聚合:第一个子任务开始等待时发 busy:true,
 *  最后一个离开等待时发 busy:false——并发多张子审批卡不会互相提前清掉琥珀态。 */
function createChildSink(parent: GenerationEventSink, info: { index: number; title: string }): ChildSink {
  const waiting = new Set<string>();
  let announceWait = false;
  let announceIdle = false;
  let tokens = 0;
  const sink: GenerationEventSink = (event) => {
    switch (event.kind) {
      case "tool_call_created": {
        parent({
          ...event,
          metadata: {
            ...(event.metadata ?? {}),
            subagent: { index: info.index, title: info.title },
          },
        });
        return;
      }
      case "tool_input_delta":
      case "tool_result":
        parent(event);
        return;
      case "tool_approval_updated": {
        if (event.approvalState.type === "pending") {
          if (waiting.size === 0) announceWait = true;
          waiting.add(event.toolCallId);
        } else {
          waiting.delete(event.toolCallId);
          if (waiting.size === 0) announceIdle = true;
        }
        parent(event);
        return;
      }
      case "engine_status": {
        if (event.status.busy && event.status.phase === "awaiting_approval") {
          if (announceWait) {
            announceWait = false;
            parent(event);
          }
        } else if (!event.status.busy) {
          if (announceIdle) {
            announceIdle = false;
            parent(event);
          }
        }
        return;
      }
      case "usage": {
        const total = Number(isRecord(event.usage) ? (event.usage.totalTokens ?? 0) : 0);
        if (Number.isFinite(total) && total > 0) tokens += total;
        return;
      }
      default:
        // text_delta / reasoning_delta / image_delta / engine_fidelity / finished / error / abort
        return;
    }
  };
  return { sink, tokensUsed: () => tokens };
}

/** 子面的 edit/write 包本次 dispatch 的路径锁(同路径串行、不同路径并行)。
 *  锁键 = 相对 cwd 解析后的绝对路径;参数缺 path(非法调用)时直通,由工具自身报错。 */
function withWriteLock(tool: ToolDefinition, lock: SubagentPathLock, cwd: string): ToolDefinition {
  if (tool.name !== "edit" && tool.name !== "write") return tool;
  const execute = tool.execute.bind(tool);
  const wrapped = async (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ToolDefinition["execute"]>[3],
    extensionCtx: Parameters<ToolDefinition["execute"]>[4],
  ) => {
    const rawPath = (params as Record<string, JsonValue> | undefined)?.path;
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return execute(toolCallId, params as never, signal, onUpdate, extensionCtx);
    }
    const key = resolve(cwd, rawPath);
    return lock.run(key, () => execute(toolCallId, params as never, signal, onUpdate, extensionCtx));
  };
  return { ...tool, execute: wrapped as ToolDefinition["execute"] };
}

/** 子面装配:工作区工具 + 通用工具经 allowedTools 过滤;subagent_dispatch 恒不在内。
 *  聊天引擎面(includeWorkspaceTools=false)只挂通用工具。 */
function buildChildTools(
  ctx: PiSubagentToolsContext,
  settings: SubagentConfig,
  model: Model,
  sink: GenerationEventSink,
  approvalScopeId: string,
  writeLock: SubagentPathLock,
): ToolDefinition[] {
  const allowed = settings.allowedTools;
  const workspace = ctx.includeWorkspaceTools === false
    ? []
    : createPiWorkspaceTools({
        conversation: ctx.conversation,
        assistant: ctx.assistant,
        sink,
        approvalScopeId,
      }).filter((tool) => isToolAllowedForSubagent(tool.name, allowed));
  const general = createPiGeneralTools({
    conversation: ctx.conversation,
    assistant: ctx.assistant,
    sink,
    ...(ctx.target ? { target: ctx.target } : {}),
    model,
    approvalScopeId,
  }).filter((tool) => isToolAllowedForSubagent(tool.name, allowed));
  return [...workspace, ...general].map((tool) => withWriteLock(tool, writeLock, ctx.cwd));
}

/** 单任务执行:模型解析(严格)→ 资源装配 → 子面装配 → runPiGeneration。 */
async function runChildTask(
  ctx: PiSubagentToolsContext,
  settings: SubagentConfig,
  request: SubagentChildRequest,
  dispatchId: string,
): Promise<SubagentChildOutcome> {
  if (request.signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
  let provider = ctx.provider;
  let model = ctx.model;
  let modelLimits = ctx.modelLimits;
  if (request.modelId) {
    const resolved = findModelStrict(request.modelId);
    if (!resolved) {
      throw new Error(
        `Unknown model_id "${request.modelId}". Add that model to a provider first, or omit model_id to use the current model.`,
      );
    }
    provider = resolved.provider;
    model = resolved.model;
    modelLimits = ctx.resolveModelLimits(provider, model);
  }
  const approvalScopeId = `${dispatchId}:${request.index}`;
  const childSink = createChildSink(ctx.sink, { index: request.index, title: request.title });
  const resources = await createPiSessionResources({
    conversation: ctx.conversation,
    assistant: ctx.assistant,
    model,
    cwd: ctx.cwd,
    root: ctx.root,
    ...(ctx.includeProjectAgentsFiles === undefined ? {} : { includeProjectAgentsFiles: ctx.includeProjectAgentsFiles }),
    extraAppendSystemPrompt: [...(ctx.extraSystemPrompt ? [ctx.extraSystemPrompt] : []), SUBAGENT_SYSTEM_PROMPT],
  });
  const result = await runPiGeneration({
    provider,
    model,
    ...(modelLimits ? { modelLimits } : {}),
    reasoningLevel: ctx.assistant.reasoningLevel,
    conversationId: ctx.conversation.id,
    approvalScopeId,
    cwd: ctx.cwd,
    history: [],
    promptText: request.prompt,
    resources,
    tools: buildChildTools(ctx, settings, model, childSink.sink, approvalScopeId, request.writeLock),
    sink: childSink.sink,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return { text: result.text, tokensUsed: childSink.tokensUsed() };
}

/** 子任务执行器工厂:每次调用 = 一次新 dispatch(独立 dispatchId → 每个子任务独立
 *  审批 scope,并发子审批互不误杀)。pi customTool 与聊天引擎的 ToolContext 共用这一
 *  装配点——子会话的 cwd/资源/过滤规则不允许出现第二份实现。 */
export function createPiSubagentRunnerFactory(
  ctx: PiSubagentToolsContext,
  settings: SubagentConfig,
): () => SubagentChildRunner {
  return () => {
    const dispatchId = `subagent-${randomUUID()}`;
    return (request: SubagentChildRequest) => runChildTask(ctx, settings, request, dispatchId);
  };
}

/** pi 会话装配入口:总开关关闭时返回空数组(不声明、不留执行面)。 */
export function createPiSubagentTools(ctx: PiSubagentToolsContext, settings: SubagentConfig): ToolDefinition[] {
  if (!settings.enabled) return [];
  const declaration = openAiSubagentTool(settings)[0]?.function;
  if (!declaration) return [];
  const makeRunner = createPiSubagentRunnerFactory(ctx, settings);
  const tool: ToolDefinition = {
    name: declaration.name,
    label: declaration.name,
    description: String(declaration.description ?? ""),
    parameters: declaration.parameters as unknown as ToolDefinition["parameters"],
    // dispatch 是长耗时聚合体;与父层其它工具一样 sequential,父循环一次只跑一个工具批。
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!settings.enabled) {
        throw new Error("Subagent dispatch is currently disabled. Do the work yourself or ask the user to enable subagents in settings.");
      }
      const text = await runSubagentDispatch(params as unknown as SubagentDispatchInput, settings, {
        runner: makeRunner(),
        ...(signal ? { signal } : {}),
      });
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  };
  return [tool];
}
