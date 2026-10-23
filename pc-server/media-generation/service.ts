// media-generation/service.ts — 选型、素材准备、提交、轮询、下载、落盘
// 轮询参数对齐移动端 MediaCreationService：5s 起步、×2、封顶 60s；连续失败 20 次判失败；
// 总时限 24h。每次轮询前响应 AbortSignal（用户停止生成）。

import type { GeneratedMediaRecord, JsonValue, StoredFile } from "../foundation/types";
import type { MediaGenerationModel, MediaGenerationProviderConfig, MediaModelRef } from "../foundation/types/settings";
import { state } from "../persistence/json-store";
import { mediaCapability, type MediaCapability } from "./capabilities";
import { resolveMediaTarget, type ResolvedMediaTarget } from "./config";
import { getMediaAdapter } from "./registry";
import { downloadMedia } from "./providers/http";
import { publishInputToS3, uploadS3Config, uploadS3MissingMessage } from "./s3-upload";
import { mediaFileUrl, registerMediaRecord, saveMediaFile, saveMediaState, updateMediaRecord } from "./storage";
import type {
  MediaGenerationOutput,
  MediaGenerationRequest,
  MediaGenerationTask,
  MediaInput,
  MediaKind,
  MediaProviderAdapter,
  MediaProviderContext,
  MediaTaskStatus,
} from "./types";
import { MediaGenerationApiError, MediaGenerationCancelledError } from "./types";

export const MEDIA_POLL_INITIAL_MS = 5_000;
export const MEDIA_POLL_MAX_MS = 60_000;
export const MEDIA_POLL_MAX_FAILURES = 20;
export const MEDIA_TASK_MAX_MS = 24 * 60 * 60 * 1000;

const conversationLocks = new Map<string, Promise<void>>();
const activeControllers = new Map<string, AbortController>();
const cancelledRecords = new Set<string>();

export function isMediaRecordCancelled(recordId: string): boolean {
  return cancelledRecords.has(recordId);
}

/** 手动生成：立刻返回账本 id，生成在后台继续；失败只落在账本里，由客户端轮询看到。 */
export function startMediaGeneration(options: GenerateMediaOptions): Promise<string> {
  const controller = new AbortController();
  const outer = options.signal;
  const forwardAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", forwardAbort, { once: true });
  }
  return new Promise<string>((resolve, reject) => {
    let recordId: string | null = null;
    const task = generateMedia({
      ...options,
      signal: controller.signal,
      onRecordCreated: (record) => {
        recordId = record.id;
        activeControllers.set(record.id, controller);
        resolve(record.id);
      },
    });
    void task
      .finally(() => {
        outer?.removeEventListener("abort", forwardAbort);
        if (recordId) {
          activeControllers.delete(recordId);
          cancelledRecords.delete(recordId);
        }
      })
      .catch(() => {});
    task.catch((err) => {
      if (!recordId) reject(err);
      else if (!(err instanceof MediaGenerationCancelledError)) {
        console.warn("[media-generation] 后台生成失败", recordId, err);
      }
    });
  });
}

/** 停止生成：有在跑的任务就中止；进程重启后只剩账本记录时直接标取消。 */
export function cancelMediaGeneration(recordId: string): GeneratedMediaRecord | null {
  cancelledRecords.add(recordId);
  const controller = activeControllers.get(recordId);
  if (controller) {
    controller.abort();
  } else {
    const record = state.generatedMedia.find((item) => item.id === recordId);
    if (record && (record.status === "queued" || record.status === "running")) {
      updateMediaRecord(recordId, { status: "cancelled", error: "已停止生成" });
      saveMediaState();
    }
  }
  return state.generatedMedia.find((item) => item.id === recordId) ?? null;
}

/** 会话级任务锁：串行化同一会话的媒体调用，防止模型一轮并发提交多个付费任务。 */
export function withMediaConversationLock<T>(
  conversationId: string | null | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!conversationId) return task();
  const key = conversationId;
  const previous = conversationLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  conversationLocks.set(key, tail);
  void tail.finally(() => {
    if (conversationLocks.get(key) === tail) conversationLocks.delete(key);
  });
  return run;
}

export interface MediaProgress {
  phase: "submitting" | "queued" | "running" | "downloading";
  elapsedSeconds: number;
  label: string;
  providerTaskId?: string;
}

export interface GenerateMediaOptions {
  kind: MediaKind;
  ref: MediaModelRef | null | undefined;
  prompt?: string;
  inputs?: MediaInput[];
  count?: number;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  generateAudio?: boolean;
  watermark?: boolean;
  seed?: number;
  promptEnhancement?: boolean;
  extraParameters?: Record<string, JsonValue>;
  conversationId?: string | null;
  nodeId?: string | null;
  toolCallId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: MediaProgress) => void;
  /** 记录已入账（拿到 id）时回调；异步 API 用它立刻返回记录 id。 */
  onRecordCreated?: (record: GeneratedMediaRecord) => void;
}

export interface SavedMediaOutput {
  file: StoredFile;
  url: string;
  mime: string;
}

export interface MediaGenerationResult {
  record: GeneratedMediaRecord;
  outputs: SavedMediaOutput[];
  provider: MediaGenerationProviderConfig;
  model: MediaGenerationModel;
  task: MediaGenerationTask;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new MediaGenerationCancelledError();
}

function paramsSnapshot(request: MediaGenerationRequest, inputs: MediaInput[]): Record<string, JsonValue> {
  const params: Record<string, JsonValue> = {};
  const put = (key: string, value: JsonValue | undefined) => {
    if (value !== undefined && value !== null) params[key] = value;
  };
  put("count", request.count);
  put("resolution", request.resolution);
  put("aspectRatio", request.aspectRatio);
  put("durationSeconds", request.durationSeconds);
  put("generateAudio", request.generateAudio);
  put("watermark", request.watermark);
  put("seed", request.seed);
  put("promptEnhancement", request.promptEnhancement);
  if (inputs.length) {
    params.inputCount = inputs.length;
    params.inputRoles = inputs.map((input) => (input.type === "image" ? input.role : input.type));
  }
  return params;
}

/** 能力矩阵校验：必填缺失 / 角色不支持 / 首尾帧与参考图互斥 / 纯图片接口收到视频素材。 */
function validateAgainstCapability(
  capability: MediaCapability,
  providerName: string,
  request: MediaGenerationRequest,
  inputs: MediaInput[],
) {
  if (capability.requiresPrompt && !request.prompt?.trim()) {
    throw new MediaGenerationApiError(`${providerName} 的媒体模型需要非空提示词`);
  }
  const valueOf: Record<string, unknown> = {
    count: request.count,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    durationSeconds: request.durationSeconds,
    generateAudio: request.generateAudio,
    watermark: request.watermark,
    seed: request.seed,
    promptEnhancement: request.promptEnhancement,
  };
  for (const param of capability.required) {
    if (valueOf[param] === undefined || valueOf[param] === null || valueOf[param] === "") {
      throw new MediaGenerationApiError(`${providerName} 的视频模型缺少必填参数：${param}`);
    }
  }
  for (const [param, value] of Object.entries(valueOf)) {
    if (value !== undefined && value !== null && !capability.params.includes(param as never)) {
      throw new MediaGenerationApiError(`${providerName} 不支持参数：${param}`);
    }
  }
  const hasVideo = inputs.some((input) => input.type === "video");
  const hasAudio = inputs.some((input) => input.type === "audio");
  if (hasVideo && !capability.videoInput) throw new MediaGenerationApiError(`${providerName} 不支持视频素材输入`);
  if (hasAudio && !capability.audioInput) throw new MediaGenerationApiError(`${providerName} 不支持音频素材输入`);
  const hasFrames = inputs.some(
    (input) => input.type === "image" && (input.role === "first_frame" || input.role === "last_frame"),
  );
  const hasReferences = inputs.some((input) => input.type === "image" && input.role === "reference");
  if (capability.framesExcludeReferences && hasFrames && hasReferences) {
    throw new MediaGenerationApiError("首尾帧与参考图不能同时使用：请二选一后重试");
  }
  for (const input of inputs) {
    if (input.type !== "image") continue;
    if (!capability.imageRoles.includes(input.role)) {
      throw new MediaGenerationApiError(`${providerName} 的图片素材只支持 role=reference`);
    }
  }
}

async function prepareInputs(capability: MediaCapability, inputs: MediaInput[], signal?: AbortSignal): Promise<MediaInput[]> {
  if (!capability.requiresRemoteInputs) return inputs;
  const result: MediaInput[] = [];
  for (const input of inputs) {
    checkAbort(signal);
    result.push(await publishInputToS3(input, signal));
  }
  return result;
}

function taskStatusToRecord(status: MediaTaskStatus): GeneratedMediaRecord["status"] {
  return status;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaGenerationCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaGenerationCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildContext(target: ResolvedMediaTarget, signal?: AbortSignal): MediaProviderContext {
  return { config: target.provider, model: target.model, baseUrl: target.baseUrl, signal };
}

function failureMessage(task: MediaGenerationTask): string {
  const message = task.error?.message ?? "媒体任务失败";
  return task.error?.code ? `${message}（${task.error.code}）` : message;
}

async function pollTask(
  ctx: MediaProviderContext,
  adapter: MediaProviderAdapter,
  recordId: string,
  initial: MediaGenerationTask,
  onProgress?: (progress: MediaProgress) => void,
): Promise<MediaGenerationTask> {
  const providerTaskId = initial.providerTaskId;
  if (!providerTaskId || !adapter.query) return initial;
  const startedAt = initial.createdAt ?? Date.now();
  let interval = MEDIA_POLL_INITIAL_MS;
  let consecutiveFailures = 0;
  let task = initial;
  for (;;) {
    if (cancelledRecords.has(recordId)) throw new MediaGenerationCancelledError();
    await abortableSleep(interval, ctx.signal);
    if (cancelledRecords.has(recordId)) throw new MediaGenerationCancelledError();
    if (Date.now() - startedAt > MEDIA_TASK_MAX_MS) {
      throw new MediaGenerationApiError("媒体任务超过 24 小时仍未完成，已停止跟踪");
    }
    try {
      task = await adapter.query(ctx, providerTaskId);
      consecutiveFailures = 0;
    } catch (err) {
      if (err instanceof MediaGenerationCancelledError || ctx.signal?.aborted) throw err;
      consecutiveFailures += 1;
      console.warn(`[media-generation] 轮询失败 ${consecutiveFailures}/${MEDIA_POLL_MAX_FAILURES}`, err);
      if (consecutiveFailures >= MEDIA_POLL_MAX_FAILURES) {
        throw new MediaGenerationApiError(
          `连续 ${MEDIA_POLL_MAX_FAILURES} 次查询任务状态失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      interval = Math.min(interval * 2, MEDIA_POLL_MAX_MS);
      continue;
    }
    updateMediaRecord(recordId, { status: taskStatusToRecord(task.status) });
    saveMediaState();
    onProgress?.({
      phase: task.status === "queued" ? "queued" : "running",
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      label:
        task.status === "queued"
          ? "已提交，排队中…"
          : `生成中 ${Math.round((Date.now() - startedAt) / 1000)}s`,
      providerTaskId,
    });
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "expired" || task.status === "cancelled") return task;
    interval = Math.min(interval * 2, MEDIA_POLL_MAX_MS);
  }
}

async function downloadOutputs(
  ctx: MediaProviderContext,
  adapter: MediaProviderAdapter,
  kind: MediaKind,
  task: MediaGenerationTask,
  recordId: string,
  startedAt: number,
  onProgress?: (progress: MediaProgress) => void,
): Promise<SavedMediaOutput[]> {
  const saved: SavedMediaOutput[] = [];
  for (const output of task.outputs) {
    if (cancelledRecords.has(recordId)) throw new MediaGenerationCancelledError();
    checkAbort(ctx.signal);
    onProgress?.({
      phase: "downloading",
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      label: "下载中…",
      providerTaskId: task.providerTaskId,
    });
    const buffer = output.data ?? (await downloadOutputBuffer(ctx, adapter, output));
    if (!buffer) continue;
    const file = saveMediaFile(buffer, resolveOutputMime(output.mime, kind), kind);
    saved.push({ file, url: mediaFileUrl(file.id), mime: file.mime });
  }
  return saved;
}

async function downloadOutputBuffer(
  ctx: MediaProviderContext,
  adapter: MediaProviderAdapter,
  output: MediaGenerationOutput,
): Promise<Buffer | null> {
  if (!output.url) return null;
  const headers = adapter.downloadHeaders?.(ctx, output.url) ?? {};
  const downloaded = await downloadMedia(ctx, output.url, headers);
  if (downloaded.mime) output.mime = downloaded.mime;
  return downloaded.buffer;
}

/** 下载响应的 Content-Type 优先；缺失或 octet-stream 时回落到适配器给的 MIME。 */
function resolveOutputMime(mime: string | undefined, kind: MediaKind): string {
  const normalized = mime?.split(";")[0]?.trim();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return kind === "video" ? "video/mp4" : "image/png";
}

async function finalizeTask(
  ctx: MediaProviderContext,
  adapter: MediaProviderAdapter,
  kind: MediaKind,
  task: MediaGenerationTask,
  recordId: string,
  startedAt: number,
  onProgress?: (progress: MediaProgress) => void,
): Promise<SavedMediaOutput[]> {
  if (task.status !== "succeeded") return [];
  const saved = await downloadOutputs(ctx, adapter, kind, task, recordId, startedAt, onProgress);
  if (saved.length === 0) {
    throw new MediaGenerationApiError("生成任务已完成，但未拿到可下载的结果");
  }
  return saved;
}

function recordErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function generateMedia(options: GenerateMediaOptions): Promise<MediaGenerationResult> {
  const target = resolveMediaTarget(options.ref, options.kind);
  const capability = mediaCapability(target.provider.type, options.kind);
  if (!capability) {
    throw new MediaGenerationApiError(`供应商「${target.provider.name}」不支持${options.kind === "image" ? "图片" : "视频"}生成`);
  }
  const request: MediaGenerationRequest = {
    prompt: options.prompt,
    inputs: options.inputs ?? [],
    count: options.count,
    resolution: options.resolution,
    aspectRatio: options.aspectRatio,
    durationSeconds: options.durationSeconds,
    generateAudio: options.generateAudio,
    watermark: options.watermark,
    seed: options.seed,
    promptEnhancement: options.promptEnhancement,
    extraParameters: options.extraParameters,
  };
  validateAgainstCapability(capability, target.provider.name, request, request.inputs);
  if (capability.requiresRemoteInputs && !uploadS3Config()) {
    const hasLocal = request.inputs.some((input) => input.localPath);
    if (hasLocal) throw new MediaGenerationApiError(uploadS3MissingMessage());
  }
  checkAbort(options.signal);
  options.onProgress?.({ phase: "submitting", elapsedSeconds: 0, label: "正在提交…" });
  request.inputs = await prepareInputs(capability, request.inputs, options.signal);

  const adapter = getMediaAdapter(target.provider.type);
  const ctx = buildContext(target, options.signal);
  const startedAt = Date.now();
  const record = registerMediaRecord({
    id: crypto.randomUUID(),
    kind: options.kind,
    status: "queued",
    providerId: target.provider.id,
    providerType: target.provider.type,
    modelId: target.model.modelId,
    prompt: request.prompt ?? "",
    params: paramsSnapshot(request, request.inputs),
    fileId: null,
    url: null,
    providerTaskId: null,
    conversationId: options.conversationId ?? null,
    nodeId: options.nodeId ?? null,
    toolCallId: options.toolCallId ?? null,
    error: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  saveMediaState();
  options.onRecordCreated?.(record);

  try {
    let task = await adapter.create(ctx, request);
    updateMediaRecord(record.id, {
      providerTaskId: task.providerTaskId ?? null,
      status: taskStatusToRecord(task.status),
    });
    // 提交成功后立即落库 providerTaskId：进程中断后 resume 才能找回任务。
    saveMediaState();
    options.onProgress?.({
      phase: task.status === "succeeded" ? "downloading" : "queued",
      elapsedSeconds: 0,
      label: task.status === "succeeded" ? "下载中…" : "已提交，排队中…",
      providerTaskId: task.providerTaskId,
    });

    if (task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled" && task.status !== "expired") {
      task = await pollTask(ctx, adapter, record.id, task, options.onProgress);
    }

    if (task.status === "failed" || task.status === "expired" || task.status === "cancelled") {
      const message = task.status === "cancelled" ? "媒体任务已被供应商取消" : failureMessage(task);
      updateMediaRecord(record.id, { status: task.status, error: message });
      saveMediaState();
      throw new MediaGenerationApiError(message);
    }

    const saved = await finalizeTask(ctx, adapter, options.kind, task, record.id, startedAt, options.onProgress);
    const first = saved[0]!;
    const updated = updateMediaRecord(record.id, {
      status: "succeeded",
      fileId: first.file.id,
      url: first.url,
      outputs: saved.map((item) => ({ fileId: item.file.id, url: item.url, mime: item.mime })),
      error: null,
      providerTaskId: task.providerTaskId ?? null,
    });
    saveMediaState();
    return {
      record: updated ?? record,
      outputs: saved,
      provider: target.provider,
      model: target.model,
      task,
    };
  } catch (err) {
    if (err instanceof MediaGenerationCancelledError || options.signal?.aborted) {
      updateMediaRecord(record.id, { status: "cancelled", error: "已停止生成" });
      saveMediaState();
      throw new MediaGenerationCancelledError();
    }
    updateMediaRecord(record.id, { status: "failed", error: recordErrorMessage(err) });
    saveMediaState();
    throw err;
  }
}

/** 启动恢复：继续轮询已有 providerTaskId 的 queued/running 记录。 */
export async function resumeMediaGeneration(record: GeneratedMediaRecord): Promise<void> {
  if (record.status !== "queued" && record.status !== "running") return;
  if (cancelledRecords.has(record.id)) {
    updateMediaRecord(record.id, { status: "cancelled", error: "已停止生成" });
    saveMediaState();
    return;
  }
  const startedAt = record.createdAt;
  if (!record.providerTaskId) {
    updateMediaRecord(record.id, { status: "failed", error: "应用在提交完成前退出，任务未建立" });
    saveMediaState();
    return;
  }
  if (Date.now() - startedAt > MEDIA_TASK_MAX_MS) {
    updateMediaRecord(record.id, { status: "failed", error: "任务超过 24 小时，已停止跟踪" });
    saveMediaState();
    return;
  }
  const target = resolveMediaTarget({ providerId: record.providerId, modelId: record.modelId }, record.kind);
  const capability = mediaCapability(target.provider.type, record.kind);
  if (!capability) {
    updateMediaRecord(record.id, { status: "failed", error: "供应商已不支持该媒体类型" });
    saveMediaState();
    return;
  }
  const adapter = getMediaAdapter(target.provider.type);
  const ctx = buildContext(target);
  try {
    const initial: MediaGenerationTask = {
      id: record.id,
      providerTaskId: record.providerTaskId,
      provider: target.provider.type,
      modelId: record.modelId,
      status: record.status,
      outputs: [],
      createdAt: startedAt,
    };
    const task = await pollTask(ctx, adapter, record.id, initial);
    if (task.status === "failed" || task.status === "expired" || task.status === "cancelled") {
      updateMediaRecord(record.id, {
        status: task.status,
        error: task.status === "cancelled" ? "媒体任务已被供应商取消" : failureMessage(task),
      });
      saveMediaState();
      return;
    }
    const saved = await finalizeTask(ctx, adapter, record.kind, task, record.id, startedAt);
    const first = saved[0]!;
    updateMediaRecord(record.id, {
      status: "succeeded",
      fileId: first.file.id,
      url: first.url,
      outputs: saved.map((item) => ({ fileId: item.file.id, url: item.url, mime: item.mime })),
      error: null,
    });
    saveMediaState();
  } catch (err) {
    if (err instanceof MediaGenerationCancelledError || cancelledRecords.has(record.id)) {
      updateMediaRecord(record.id, { status: "cancelled", error: "已停止生成" });
    } else {
      updateMediaRecord(record.id, { status: "failed", error: recordErrorMessage(err) });
    }
    saveMediaState();
  }
}
