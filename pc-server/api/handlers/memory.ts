// api/handlers/memory.ts — 记忆路由（pending、global、batch、settings/memory-settings;推送走 /api/events）
// 纪律：纯搬迁自 server.ts routeApi()；记忆域契约（MemorySnapshot、pending 队列）冻结。

import { saveState, state } from "../../persistence/json-store";
import { memoryStore } from "../../memory/index";
import { error, json, readJson } from "../request";
import { broadcastMemoryUpdate, broadcastSettings } from "../sse";
import { invalidateContextSnapshots } from "../../inference-engine/context-snapshots";
import { updateSettings } from "../../app-config";

export async function handleMemoryRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
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
    const body = await readJson<{ globalEnabled?: boolean; writeStrategy?: string }>(request);
    const ms = { ...state.settings.memorySettings };
    if (typeof body.globalEnabled === "boolean") ms.globalEnabled = body.globalEnabled;
    const ws = String(body.writeStrategy ?? "");
    if (ws === "ask" || ws === "always_assistant" || ws === "always_global" || ws === "readonly") {
      ms.writeStrategy = ws;
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
  return null;
}
