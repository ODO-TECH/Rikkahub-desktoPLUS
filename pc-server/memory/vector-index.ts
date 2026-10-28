// memory/vector-index.ts — 记忆向量索引任务（单飞、可取消、可增量、autoIndex 防抖）
// 纪律：只索引记忆文本；不阻塞对话、不拖慢记忆落盘（与 memoryStore.writeQueue 分开）。
// 失败分级：401/403/400 等 4xx 立即停并记 last_error；429/5xx 由 embedding-client 退避重试；
// 维度不一致视为换模型/供应商异常，停任务并提示重建。

import { getConversationsDb } from "../conversations";
import { reportError } from "../observability/app-errors";
import { state } from "../persistence/json-store";
import { memoryStore } from "./index";
import { isRecallableStatus, normalizeMemoryStatus } from "./experiment/entry";
import { memoryExperimentFeature } from "./experiment/gate";
import { embedTextsInBatches } from "./embedding-client";
import { resolveEmbeddingModel, resolveRerankModel, type SceneModelRef } from "./scene-models";
import {
  loadMemoryVectors,
  openVectorDb,
  pruneMemoryVectors,
  readVectorMeta,
  upsertMemoryVectors,
  writeVectorMeta,
  clearMemoryVectors,
  contentHash,
  type VectorUpsertRow,
} from "./vector-store";
import { setMemoryVectorChangeListener } from "./vector-hooks";
export interface MemoryIndexEvent {
  phase: "running" | "done" | "error" | "idle";
  done: number;
  total: number;
  message?: string;
}

export interface MemoryVectorStatus {
  enabled: boolean;
  /** 场景档里能解析出 EMBEDDING 模型。 */
  configured: boolean;
  /** 已配置的模型与库里的向量不是同一套（换模型后需要重建）。 */
  needsRebuild: boolean;
  modelKey: string | null;
  modelName: string | null;
  dim: number | null;
  total: number;
  indexed: number;
  stale: number;
  running: boolean;
  progress: MemoryIndexEvent;
  lastError: string | null;
  indexedAt: number | null;
  rerank: { configured: boolean; modelName: string | null };
}

let broadcaster: (event: MemoryIndexEvent) => void = () => {};
export function initMemoryVectorBroadcast(fn: (event: MemoryIndexEvent) => void): void {
  broadcaster = fn;
}

let running = false;
let cancelRequested = false;
let abortController: AbortController | null = null;
let progress: MemoryIndexEvent = { phase: "idle", done: 0, total: 0 };
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function publish(event: MemoryIndexEvent): void {
  progress = event;
  // 进度条按批更新即可；同一 tick 内的多次更新合并成一帧，避免灌满 SSE。
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    try {
      broadcaster(progress);
    } catch (err) {
      console.warn("[memory] memory-index 广播失败:", err);
    }
  }, 50);
}

export function getMemoryIndexProgress(): MemoryIndexEvent {
  return { ...progress };
}

function allMemories() {
  const out = [];
  for (const memory of memoryStore.globalMemories) out.push(memory);
  for (const group of memoryStore.assistantGroups) for (const memory of group.memories) out.push(memory);
  // 实验：语义索引只服务 active 记忆。归档 / 取代 / 墓碑内容即使缺向量也不补，
  // 否则删掉的状态会在下一次「补缺索引」时被重新嵌入并短暂复活。
  // tombstone 无条件排除：正文已按策略清除，即便状态召回开关关闭也不得重嵌。
  const material = out.filter((memory) => normalizeMemoryStatus(memory.status) !== "tombstone");
  if (!memoryExperimentFeature("statusRecall")) return material;
  return material.filter((memory) => isRecallableStatus(memory.status));
}

function isValidVector(
  vector: { contentHash: string; dim: number; vector: Float32Array } | undefined,
  content: string,
  dim: number | null,
): boolean {
  if (!vector) return false;
  if (vector.contentHash !== contentHash(content)) return false;
  if (dim != null && vector.dim !== dim) return false;
  return true;
}

function missingMemories(ref: SceneModelRef) {
  const db = openVectorDb();
  const vectors = db ? loadMemoryVectors(db, ref.modelKey) : new Map();
  const meta = db ? readVectorMeta(db) : null;
  const dim = meta && meta.modelKey === ref.modelKey ? meta.dim : null;
  return allMemories().filter((memory) => !isValidVector(vectors.get(memory.id), memory.content, dim));
}

export function getMemoryVectorStatus(): MemoryVectorStatus {
  const settings = state.settings.memoryVectorSettings;
  const ref = resolveEmbeddingModel();
  const rerankRef = resolveRerankModel();
  const db = openVectorDb();
  const meta = db ? readVectorMeta(db) : null;
  const all = allMemories();
  let indexed = 0;
  if (db && ref) {
    const vectors = loadMemoryVectors(db, ref.modelKey);
    const dim = meta && meta.modelKey === ref.modelKey ? meta.dim : null;
    for (const memory of all) {
      if (isValidVector(vectors.get(memory.id), memory.content, dim)) indexed += 1;
    }
  }
  const modelKey = ref?.modelKey ?? meta?.modelKey ?? null;
  return {
    enabled: settings.enabled,
    configured: ref != null,
    needsRebuild: ref != null && meta?.modelKey != null && meta.modelKey !== ref.modelKey,
    modelKey,
    modelName: ref?.displayName ?? null,
    dim: meta?.dim ?? null,
    total: all.length,
    indexed,
    stale: Math.max(0, all.length - indexed),
    running,
    progress: getMemoryIndexProgress(),
    lastError: meta?.lastError ?? null,
    indexedAt: meta?.indexedAt ?? null,
    rerank: { configured: rerankRef != null, modelName: rerankRef?.displayName ?? null },
  };
}

export interface StartIndexResult {
  started: boolean;
  reason?: string;
}

/** 启动索引任务并立即返回；进度经 memory-index SSE 推送，状态由 SQL 现算。 */
export function startMemoryVectorIndex(mode: "rebuild" | "missing"): StartIndexResult {
  if (running) return { started: false, reason: "running" };
  const ref = resolveEmbeddingModel();
  if (!ref) throw new Error("未配置嵌入模型：请先在「设置 › 模型 › 场景模型」里选择嵌入模型");
  if (ref.provider.type !== "openai") {
    throw new Error(`嵌入只支持 OpenAI 兼容供应商（当前 ${ref.provider.name} 是 ${ref.provider.type} 型）`);
  }
  const db = getConversationsDb();
  if (!db) throw new Error("数据库尚未就绪，请稍后再试");

  const items = mode === "rebuild" ? allMemories() : missingMemories(ref);
  running = true;
  cancelRequested = false;
  abortController = new AbortController();
  writeVectorMeta(db, { lastError: null });
  pruneMemoryVectors(db, new Set(allMemories().map((memory) => memory.id)));
  publish({ phase: "running", done: 0, total: items.length });

  void runIndexTask(ref, items, abortController.signal).catch((err) => {
    // runIndexTask 自己处理业务错误；这里兜住意外异常，保证 running 状态一定复位。
    const message = err instanceof Error ? err.message : String(err);
    running = false;
    abortController = null;
    publish({ phase: "error", done: progress.done, total: progress.total, message });
    reportError("provider", "error", `记忆索引任务异常：${message}`, err, "memory_vector_index_failed");
  });
  return { started: true };
}

async function runIndexTask(
  ref: SceneModelRef,
  items: ReturnType<typeof allMemories>,
  signal: AbortSignal,
): Promise<void> {
  const db = openVectorDb();
  if (!db) {
    running = false;
    abortController = null;
    publish({ phase: "error", done: 0, total: items.length, message: "数据库尚未就绪" });
    return;
  }
  let done = 0;
  let dim: number | null = null;
  try {
    if (items.length === 0) {
      writeVectorMeta(db, { lastError: null, indexedAt: Date.now() });
      publish({ phase: "done", done: 0, total: 0 });
      return;
    }
    const meta = readVectorMeta(db);
    if (meta.modelKey === ref.modelKey) dim = meta.dim;
    const batchSize = 64;
    for (let offset = 0; offset < items.length; offset += batchSize) {
      if (cancelRequested) {
        publish({ phase: "idle", done, total: items.length, message: "已取消，已完成部分保留" });
        return;
      }
      const batch = items.slice(offset, offset + batchSize);
      const result = await embedTextsInBatches(
        ref,
        batch.map((memory) => memory.content),
        {
          signal,
          onBatch: (batchDone, batchTotal) => {
            publish({ phase: "running", done: done + Math.min(batchDone, batchTotal), total: items.length });
          },
        },
      );
      if (dim == null) dim = result.dim;
      else if (dim !== result.dim) {
        throw new Error(`嵌入维度与已有索引不一致（${dim} / ${result.dim}）：请点「重建全部」`);
      }
      const rows: VectorUpsertRow[] = batch.map((memory, i) => ({
        memoryId: memory.id,
        contentHash: contentHash(memory.content),
        vector: Float32Array.from(result.vectors[i]),
      }));
      upsertMemoryVectors(db, ref.modelKey, rows);
      writeVectorMeta(db, {
        modelKey: ref.modelKey,
        dim,
        indexedAt: Date.now(),
        lastError: null,
      });
      done += batch.length;
      publish({ phase: "running", done, total: items.length });
    }
    pruneMemoryVectors(db, new Set(allMemories().map((memory) => memory.id)));
    publish({ phase: "done", done: items.length, total: items.length });
  } catch (err) {
    if (cancelRequested || (err as { name?: string } | null)?.name === "AbortError") {
      publish({ phase: "idle", done, total: items.length, message: "已取消，已完成部分保留" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      writeVectorMeta(db, { lastError: message });
    } catch { /* 状态写失败不覆盖原始错误 */ }
    publish({ phase: "error", done, total: items.length, message });
    console.warn(`[memory] 记忆索引失败：${message}`);
  } finally {
    running = false;
    abortController = null;
    cancelRequested = false;
  }
}

export function cancelMemoryVectorIndex(): boolean {
  if (!running) return false;
  cancelRequested = true;
  abortController?.abort();
  return true;
}

export function clearMemoryVectorIndex(): boolean {
  if (running) return false;
  const db = openVectorDb();
  if (!db) return false;
  clearMemoryVectors(db);
  publish({ phase: "idle", done: 0, total: 0 });
  return true;
}

// ---- autoIndex：连续写多条只发一批（500ms 防抖） ----

let autoTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleMemoryAutoIndex(): void {
  const settings = state.settings.memoryVectorSettings;
  if (!settings?.enabled || !settings.autoIndex) return;
  if (!resolveEmbeddingModel()) return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    // 防抖窗口内用户可能已经关掉开关/换掉模型，也可能设置被整体替换（导入/重载），
    // 起跑前按最新设置再判一次；字段缺失视同关闭。
    const current = state.settings.memoryVectorSettings;
    if (!current?.enabled || !current.autoIndex) return;
    if (!resolveEmbeddingModel()) return;
    if (running) return; // 全量任务会覆盖这些记忆，避免并发抢写
    try {
      startMemoryVectorIndex("missing");
    } catch (err) {
      console.warn(`[memory] 自动索引未能启动：${err instanceof Error ? err.message : String(err)}`);
    }
  }, 500);
}

/** 由 memory/index 的写入点调用（模块加载后安装；未安装时记忆功能一切照旧）。 */
export function installMemoryVectorHooks(): void {
  setMemoryVectorChangeListener((reason) => {
    if (reason === "add" || reason === "update" || reason === "replace") scheduleMemoryAutoIndex();
  });
}

installMemoryVectorHooks();
