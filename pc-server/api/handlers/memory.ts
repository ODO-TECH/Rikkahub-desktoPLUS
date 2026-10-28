// api/handlers/memory.ts — 记忆路由（pending、global、batch、settings/memory-settings;推送走 /api/events）
// 纪律：纯搬迁自 server.ts routeApi()；记忆域契约（MemorySnapshot、pending 队列）冻结。

import { saveState, state } from "../../persistence/json-store";
import { memoryStore } from "../../memory/index";
import { error, json, readJson } from "../request";
import { broadcastMemoryUpdate, broadcastSettings } from "../sse";
import { invalidateContextSnapshots, invalidateConversationContext } from "../../inference-engine/context-snapshots";
import { updateSettings } from "../../app-config";
import {
  cancelMemoryVectorIndex,
  clearMemoryVectorIndex,
  getMemoryVectorStatus,
  startMemoryVectorIndex,
} from "../../memory/vector-index";
import { applyMemoryVectorPatch } from "../../memory/vector-settings";
import { applyMemoryExperimentPatch, needsForgettingUnlock } from "../../memory/experiment/config";
import { normalizeMemoryAssertion } from "../../memory/experiment/assertions";
import { getMemoryExperimentSettings, memoryExperimentFeature, memoryExperimentOn } from "../../memory/experiment/gate";
import { runMemoryIntake } from "../../memory/experiment/intake";
import { listMergeProposals, runMergePlanning } from "../../memory/experiment/merge-plan";
import { applyMergeProposal, rejectMergeProposal } from "../../memory/experiment/merge-apply";
import {
  applyEventPromotion,
  listEventPromotions,
  planEventPromotions,
  rejectEventPromotion,
  runMentionScoringNow,
} from "../../memory/experiment/mentions";
import {
  listMaintenanceProposals,
  maintenanceSummary,
  planMaintenance,
  rejectMaintenanceProposal,
} from "../../memory/experiment/maintenance";
import {
  applyMaintenanceProposal,
  forgettingSummary,
  runForgettingPurge,
  undoDistillApply,
} from "../../memory/experiment/forget";
import { listAudit, openExperimentDb, type MemoryAuditAction, type MemoryAuditStatus } from "../../memory/experiment/store";
import { resolveEmbeddingModel } from "../../memory/scene-models";
import { previewMemoryRecall, readRecallInfo } from "../../memory/recall";
import { runMemoryOrganizeNow } from "../../memory/organize";
import { getConversation } from "../../conversations";
import { findAssistant } from "../../assistants";

function clampLimit(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function handleMemoryRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  // ===== memory 路由(1.3.2)=====
  // 记忆快照推送已并入 /api/events 通道(memory 事件)。
  if (path === "memory/pending" && request.method === "GET") {
    return json({ pending: memoryStore.getPending() });
  }
  // batch 必须在 :pendingId regex 之前(否则 "batch" 会被当 pendingId 匹配)
  if (path === "memory/pending/batch" && request.method === "POST") {
    const body = await readJson<{ items?: Array<{ pendingId: string; action: "global" | "assistant" | "discard"; content?: string }> }>(request);
    if (!Array.isArray(body?.items)) return error("items array is required", 400);
    const results = await memoryStore.resolvePendingBatch(body.items);
    invalidateContextSnapshots();
    broadcastMemoryUpdate();
    return json({ status: "ok", results });
  }
  {
    const pendingResolve = path.match(/^memory\/pending\/([^/]+)$/);
    if (pendingResolve && request.method === "POST") {
      const body = await readJson<{ action?: string; content?: string }>(request);
      const pendingId = decodeURIComponent(pendingResolve[1]);
      const action = String(body.action ?? "");
      if (action !== "global" && action !== "assistant" && action !== "discard") {
        return error("action must be one of global/assistant/discard", 400);
      }
      const result = await memoryStore.resolvePending(pendingId, action, body.content);
      if (!result.resolved) return error(`Pending ${pendingId} not found`, 404);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", memory: result.memory });
    }
  }
  if (path === "settings/memory-settings" && request.method === "POST") {
    const body = await readJson<{
      globalEnabled?: boolean;
      writeStrategy?: string;
      dedupEnabled?: boolean;
      memoryModelThinkingEnabled?: boolean;
    }>(request);
    const ms = { ...state.settings.memorySettings };
    if (typeof body.globalEnabled === "boolean") ms.globalEnabled = body.globalEnabled;
    const ws = String(body.writeStrategy ?? "");
    if (ws === "ask" || ws === "always_assistant" || ws === "always_global" || ws === "readonly") {
      ms.writeStrategy = ws;
    }
    if (typeof body.dedupEnabled === "boolean") ms.dedupEnabled = body.dedupEnabled;
    if (typeof body.memoryModelThinkingEnabled === "boolean") {
      ms.memoryModelThinkingEnabled = body.memoryModelThinkingEnabled;
    }
    // M3 矛盾组合防御:globalEnabled=false 时 always_global 无意义 → 降级 ask(前端 UI 也 disable,
    // 此处服务端兜底防绕过)
    if (!ms.globalEnabled && ms.writeStrategy === "always_global") {
      ms.writeStrategy = "ask";
    }
    updateSettings({ ...state.settings, memorySettings: ms });
    saveState();
    broadcastSettings();
    broadcastMemoryUpdate();
    return json({ status: "ok", memorySettings: ms });
  }
  // 记忆整理:手动「立即整理」绕过 N 轮门槛。conversationId 可选(仅用于记水位)。
  if (path === "memory/organize" && request.method === "POST") {
    const body = await readJson<{ assistantId?: string; conversationId?: string }>(request);
    const assistantId = String(body?.assistantId ?? "").trim();
    if (!assistantId) return error("assistantId is required", 400);
    const assistant = findAssistant(state.settings.assistants, assistantId);
    if (!assistant) return error(`Assistant ${assistantId} not found`, 404);
    if (!assistant.enableMemory) return error("该助手未启用记忆", 400);
    try {
      return json(await runMemoryOrganizeNow(assistantId));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 500);
    }
  }
  // ===== 记忆 CRUD(阶段 4 UI 用)=====
  // 全局记忆:GET 列表 / POST 新增或编辑{id,content} / DELETE :id
  if (path === "memory/global" && request.method === "GET") {
    return json({ memories: memoryStore.getGlobalMemories() });
  }
  if (path === "memory/global" && request.method === "POST") {
    const body = await readJson<{ id?: number; content?: string }>(request);
    const content = String(body.content ?? "").trim();
    if (!content) return error("content is required", 400);
    const memory = Number.isInteger(Number(body.id)) && Number(body.id) > 0
      ? memoryStore.updateMemory(Number(body.id), content)
      : memoryStore.addMemory({ scope: "global", content, source: "manual" });
    invalidateContextSnapshots();
    broadcastMemoryUpdate();
    return json({ status: "ok", memory });
  }
  {
    const m = path.match(/^memory\/global\/(\d+)$/);
    if (m && request.method === "DELETE") {
      const memoryId = Number(m[1]);
      if (!memoryStore.deleteMemory(memoryId)) return error(`Memory record #${memoryId} not found`, 404);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "deleted" });
    }
  }
  // 助手记忆:GET :assistantId 列表 / POST :assistantId 新增或编辑 / DELETE :assistantId/:id
  {
    const m = path.match(/^memory\/assistant\/([^/]+)$/);
    if (m && request.method === "GET") {
      return json({ memories: memoryStore.getAssistantMemories(decodeURIComponent(m[1])) });
    }
    if (m && request.method === "POST") {
      const assistantId = decodeURIComponent(m[1]);
      const body = await readJson<{ id?: number; content?: string }>(request);
      const content = String(body.content ?? "").trim();
      if (!content) return error("content is required", 400);
      const memory = Number.isInteger(Number(body.id)) && Number(body.id) > 0
        ? memoryStore.updateMemory(Number(body.id), content)
        : memoryStore.addMemory({ scope: "assistant", assistantId, content, source: "manual" });
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", memory });
    }
  }
  {
    const m = path.match(/^memory\/assistant\/([^/]+)\/(\d+)$/);
    if (m && request.method === "DELETE") {
      const memoryId = Number(m[2]);
      if (!memoryStore.deleteMemory(memoryId)) return error(`Memory record #${memoryId} not found`, 404);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "deleted" });
    }
  }
  // 批量编辑(整体替换,带 schema 校验 + .bak 备份,§9.3)。校验失败返回 400,不落盘。
  if (path === "memory/batch/global" && request.method === "POST") {
    const body = await readJson<{ memories?: unknown }>(request);
    try {
      memoryStore.replaceGlobalMemories(body.memories);
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    invalidateContextSnapshots();
    broadcastMemoryUpdate();
    return json({ status: "ok" });
  }
  if (path === "memory/batch/assistant" && request.method === "POST") {
    const body = await readJson<{ assistants?: unknown }>(request);
    try {
      memoryStore.replaceAssistantGroups(body.assistants);
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    invalidateContextSnapshots();
    broadcastMemoryUpdate();
    return json({ status: "ok" });
  }
  // ===== 特性 C:记忆向量索引与召回(0.0.3)=====
  // 索引任务只做后台单飞,HTTP 立即返回;进度走 /api/events 的 memory-index 事件,状态现算。
  if (path === "memory/vector/status" && request.method === "GET") {
    return json(getMemoryVectorStatus());
  }
  if (path === "memory/vector/index" && request.method === "POST") {
    const body = await readJson<{ mode?: string }>(request);
    const mode = body?.mode === "rebuild" ? "rebuild" : "missing";
    try {
      const result = startMemoryVectorIndex(mode);
      if (!result.started) return error("索引任务正在进行中", 409);
      return json({ started: true, mode });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 400);
    }
  }
  if (path === "memory/vector/cancel" && request.method === "POST") {
    return json({ cancelled: cancelMemoryVectorIndex() });
  }
  if (path === "memory/vector/clear" && request.method === "POST") {
    if (!clearMemoryVectorIndex()) {
      return error(getMemoryVectorStatus().running ? "索引任务进行中，请先取消" : "数据库尚未就绪", 409);
    }
    // 向量清空后旧召回声明的 id 可能仍被冻结快照引用 → 整体失效,下次编码回全量注入。
    invalidateContextSnapshots();
    return json({ status: "cleared" });
  }
  // 「测试召回」:显式用户动作,允许触发一次查询嵌入(与可选的供应商重排)。
  if (path === "memory/vector/search" && request.method === "POST") {
    const body = await readJson<{ query?: string; limit?: number }>(request);
    const query = String(body?.query ?? "").trim();
    if (!query) return error("query is required", 400);
    const limit = clampLimit(body?.limit, 20, 1, 50);
    try {
      return json(await previewMemoryRecall(query, limit));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err), 500);
    }
  }
  // 会话侧召回状态(输入框徽章用);rematch 只清缓存,下一次编码自动重算。
  if (path === "memory/vector/recall" && request.method === "GET") {
    const conversationId = String(url.searchParams.get("conversationId") ?? "").trim();
    if (!conversationId) return error("conversationId is required", 400);
    const conversation = getConversation(conversationId);
    if (!conversation) return error(`Conversation ${conversationId} not found`, 404);
    const assistant = findAssistant(state.settings.assistants, conversation.assistantId);
    if (!assistant) return error("assistant not found", 404);
    return json(readRecallInfo(conversationId, assistant));
  }
  if (path === "memory/vector/rematch" && request.method === "POST") {
    const body = await readJson<{ conversationId?: string }>(request);
    const conversationId = String(body?.conversationId ?? "").trim();
    if (!conversationId) return error("conversationId is required", 400);
    if (!getConversation(conversationId)) return error(`Conversation ${conversationId} not found`, 404);
    invalidateConversationContext(conversationId);
    return json({ status: "ok" });
  }
  // 设置切片:启用前必须能解析出 EMBEDDING 类型且 OpenAI 兼容的模型,避免"开了但永远没索引"。
  if (path === "settings/memory-vector" && request.method === "POST") {
    let next;
    try {
      next = applyMemoryVectorPatch(state.settings.memoryVectorSettings, await readJson<Record<string, unknown>>(request));
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    if (next.enabled) {
      const ref = resolveEmbeddingModel();
      if (!ref) {
        return error("未配置嵌入模型：请先在「设置 › 模型 › 场景模型」里选择嵌入模型", 400);
      }
      if (ref.provider.type !== "openai") {
        return error(`嵌入只支持 OpenAI 兼容供应商（当前 ${ref.provider.name} 是 ${ref.provider.type} 型）`, 400);
      }
    }
    updateSettings({ ...state.settings, memoryVectorSettings: next });
    saveState();
    // 开关/参数改变会改变注入内容的顺序与范围 → 冻结快照与召回声明的缓存全部作废。
    invalidateContextSnapshots();
    broadcastSettings();
    return json({ status: "ok", memoryVectorSettings: next });
  }
  // 实验：压缩摘要卡只显示候选数量，不在这里执行任何写入。
  if (path === "memory/experiment/compaction-candidates" && request.method === "GET") {
    if (!memoryExperimentFeature("compactionCandidates")) return json({ count: 0 });
    const conversationId = String(url.searchParams.get("conversationId") ?? "").trim();
    const cutMessageId = String(url.searchParams.get("cutMessageId") ?? "").trim();
    if (!cutMessageId) return json({ count: 0 });
    const count = memoryStore.getPending().filter((entry) =>
      entry.origin === "compaction"
      && entry.sourceCutMessageId === cutMessageId
      && (!conversationId || entry.conversationId === conversationId)
    ).length;
    return json({ count });
  }
  // 实验：记忆与上下文。开关改变会改变注入/召回/压缩后置行为 → 冻结快照整体失效。
  if (path === "settings/memory-experiment" && request.method === "POST") {
    const body = await readJson<Record<string, unknown>>(request);
    const current = getMemoryExperimentSettings();
    let next;
    try {
      next = applyMemoryExperimentPatch(current, body);
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    // 失真执行解锁门：从「只试运行」进入「可执行」必须 (1) 用户明确确认不可逆，
    // (2) 至少跑过一轮扫描（有 distill_plan 审计可审）。备份提醒在确认框里给出。
    if (needsForgettingUnlock(current, next)) {
      if (body.acknowledgeIrreversible !== true) {
        return error("关闭试运行会让失真与到期清除成为不可逆操作，需要明确确认", 400);
      }
      const db = openExperimentDb();
      const hasScan = db ? listAudit(db, { action: "distill_plan", limit: 1 }).length > 0 : false;
      if (!hasScan) {
        return error("请先运行一次「检查到期记忆」并确认计划，再关闭试运行", 409);
      }
    }
    updateSettings({ ...state.settings, memoryExperimentSettings: next });
    invalidateContextSnapshots();
    return json({ status: "ok", memoryExperimentSettings: next });
  }
  // 实验：结构化断言入口。供压缩后置适配器、验收脚本与将来的手动画像使用；
  // structuredIntake 关闭时直接拒绝（不在关闭状态下产生任何记忆副作用）。
  if (path === "memory/experiment/intake" && request.method === "POST") {
    if (!memoryExperimentFeature("structuredIntake")) {
      return error("结构化提取未开启", 409);
    }
    const body = await readJson<Record<string, unknown>>(request);
    const assistantId = String(body?.assistantId ?? "").trim();
    if (!assistantId) return error("assistantId is required", 400);
    const assistant = findAssistant(state.settings.assistants, assistantId);
    if (!assistant) return error(`Assistant ${assistantId} not found`, 404);
    let assertion;
    try {
      assertion = normalizeMemoryAssertion(body);
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 400);
    }
    const conversationId = assertion.conversationId ?? "";
    const conversation = conversationId ? getConversation(conversationId) : undefined;
    const conversationTitle = String(body?.conversationTitle ?? "").trim() || conversation?.title;
    try {
      const result = await runMemoryIntake({
        assistant,
        assertion,
        context: {
          ...(conversationId ? { conversationId } : {}),
          ...(conversationTitle ? { conversationTitle } : {}),
          ...(assertion.messageNodeId ? { messageNodeId: assertion.messageNodeId } : {}),
        },
      });
      if (result.status !== "deduped" && result.status !== "readonly" && result.status !== "disabled") {
        invalidateContextSnapshots();
        broadcastMemoryUpdate();
      }
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  // 实验：第一轮合并。规划只写 merge_plan 审计（proposed），不改任何记忆。
  if (path === "memory/experiment/merge/plan" && request.method === "POST") {
    if (!memoryExperimentFeature("mergeProposals")) {
      return error("第一轮合并提案未开启", 409);
    }
    try {
      return json({ status: "ok", ...runMergePlanning() });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  if (path === "memory/experiment/merge/proposals" && request.method === "GET") {
    if (!memoryExperimentOn()) return json({ proposals: [] });
    const status = String(url.searchParams.get("status") ?? "proposed").trim();
    return json({
      proposals: listMergeProposals(status === "all" ? undefined : status as MemoryAuditStatus),
    });
  }
  // 批准 / 拒绝一条合并提案。批准要求关闭试运行（memoryExperimentMutates）；拒绝随时可用。
  if (path === "memory/experiment/merge/apply" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      const result = applyMergeProposal(auditId);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  if (path === "memory/experiment/merge/reject" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      return json({ status: "ok", result: rejectMergeProposal(auditId) });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  // 实验：第二轮提及计分的手动入口（正常由每轮生成后的后台调度触发）。
  if (path === "memory/experiment/mentions/scan" && request.method === "POST") {
    if (!memoryExperimentFeature("mentionScoring")) return error("提及计分未开启", 409);
    const body = await readJson<{ conversationId?: string }>(request);
    const conversationId = String(body?.conversationId ?? "").trim();
    if (!conversationId) return error("conversationId is required", 400);
    const conversation = getConversation(conversationId);
    if (!conversation) return error(`Conversation ${conversationId} not found`, 404);
    const assistant = findAssistant(state.settings.assistants, conversation.assistantId);
    if (!assistant) return error("Assistant not found", 404);
    try {
      const result = await runMentionScoringNow(conversation, assistant);
      if (result.scored > 0) broadcastMemoryUpdate();
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  // 实验：跨会话同类事件 → 习惯的待确认晋升。规划只写审计，不改分类。
  if (path === "memory/experiment/promotions/plan" && request.method === "POST") {
    if (!memoryExperimentFeature("mentionScoring")) return error("提及计分未开启", 409);
    try {
      return json({ status: "ok", ...planEventPromotions() });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  if (path === "memory/experiment/promotions" && request.method === "GET") {
    if (!memoryExperimentOn()) return json({ promotions: [] });
    const status = String(url.searchParams.get("status") ?? "proposed").trim();
    return json({
      promotions: listEventPromotions(status === "all" ? undefined : status as MemoryAuditStatus),
    });
  }
  if (path === "memory/experiment/promotions/apply" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      const result = applyEventPromotion(auditId);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  if (path === "memory/experiment/promotions/reject" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      return json({ status: "ok", result: rejectEventPromotion(auditId) });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  // 实验：周期维护（7 / 14 天失真与保真计划）。扫描只写审计，零模型调用、零记忆改动。
  if (path === "memory/experiment/maintenance/plan" && request.method === "POST") {
    if (!memoryExperimentFeature("maintenance")) return error("周期维护未开启", 409);
    try {
      return json({ status: "ok", ...planMaintenance({ trigger: "manual" }) });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  if (path === "memory/experiment/maintenance" && request.method === "GET") {
    if (!memoryExperimentOn()) {
      return json({ lastRunAt: null, proposals: [], pending: 0, estimatedModelCalls: 0 });
    }
    const status = String(url.searchParams.get("status") ?? "proposed").trim();
    const records = listMaintenanceProposals(status === "all" ? undefined : status as MemoryAuditStatus);
    const summary = maintenanceSummary();
    return json({
      lastRunAt: summary.lastRunAt,
      proposals: records,
      pending: summary.pending.length,
      estimatedModelCalls: records.reduce((sum, proposal) => sum + proposal.estimatedModelCalls, 0),
    });
  }
  if (path === "memory/experiment/maintenance/reject" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      return json({ status: "ok", result: rejectMaintenanceProposal(auditId) });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  // 实验：执行失真（S14）。只执行审计里 proposed 的计划；模型调用只发生在 fidelity，
  // 且计划阶段已报价；失败回滚并留 failed 审计，计划保持 proposed 可重试。
  if (path === "memory/experiment/maintenance/apply" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      const result = await applyMaintenanceProposal(auditId);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  // 实验：撤销一次失真执行。延迟清除期内可用；原文已清除时拒绝（这是设计上的终态）。
  if (path === "memory/experiment/maintenance/undo" && request.method === "POST") {
    const body = await readJson<{ auditId?: string }>(request);
    const auditId = String(body?.auditId ?? "").trim();
    if (!auditId) return error("auditId is required", 400);
    try {
      const result = undoDistillApply(auditId);
      invalidateContextSnapshots();
      broadcastMemoryUpdate();
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 409);
    }
  }
  // 实验：到期清除（rawContent 到期真删；L3 主题到期留 tombstone）。试运行时只统计不删除。
  if (path === "memory/experiment/forget/purge" && request.method === "POST") {
    if (!memoryExperimentFeature("maintenance")) return error("周期维护未开启", 409);
    try {
      const result = runForgettingPurge({ trigger: "manual" });
      if (!result.dryRun) {
        invalidateContextSnapshots();
        broadcastMemoryUpdate();
      }
      return json({ status: "ok", result });
    } catch (err) {
      return error(String(err instanceof Error ? err.message : String(err)), 500);
    }
  }
  // 实验：遗忘状态汇总（待清除 / 待墓碑 / 已执行记录）。
  if (path === "memory/experiment/forget" && request.method === "GET") {
    if (!memoryExperimentOn()) {
      return json({
        now: Date.now(),
        lastPurgeAt: null,
        pendingRawPurges: 0,
        pendingTombstones: 0,
        scheduledPurges: 0,
        earliestPurgeAt: null,
        applied: [],
      });
    }
    return json(forgettingSummary());
  }
  // 实验审计列表：第一轮合并 / 失真 / 清洗提案的统一展示源（按时间倒序）。
  if (path === "memory/experiment/audit" && request.method === "GET") {
    if (!memoryExperimentOn()) return json({ audit: [] });
    const db = openExperimentDb();
    if (!db) return json({ audit: [] });
    const limit = clampLimit(url.searchParams.get("limit"), 100, 1, 500);
    const status = String(url.searchParams.get("status") ?? "").trim();
    const action = String(url.searchParams.get("action") ?? "").trim();
    return json({
      audit: listAudit(db, {
        limit,
        ...(status ? { status: status as MemoryAuditStatus } : {}),
        ...(action ? { action: action as MemoryAuditAction } : {}),
      }),
    });
  }
  return null;
}
