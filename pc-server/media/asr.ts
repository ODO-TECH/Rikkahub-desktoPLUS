// media/asr.ts — 语音识别（OpenAI Realtime / DashScope / 火山引擎实时会话、MiMo 分段识别与文件转写）
// 纪律：负责 ASR Provider 默认值/归一化、WebSocket 实时会话与转写实现，不处理路由。
// 请求日志暂经 ../server 的 addLog 记录（3.5 拆 api/ 时收敛）。

import { gunzipSync, gzipSync } from "node:zlib";
import type { AsrProvider, AsrRealtimeSession } from "../foundation/types";
import { PC_KNOWN_ASR_TYPES } from "../foundation/types";
import { id, isRecord } from "../foundation/utils";
import { fetchWithTimeout, resolveEffectiveProxy, shouldBypassProxy } from "../foundation/net";
import { state } from "../persistence/json-store";
import { textBody } from "../model-providers";
import { addLog } from "../api/logs";
import { reportError } from "../observability/app-errors";

/** 桌面端「认识且能跑」的 ASR 类型守卫(单一判定入口)。step 等 APP 独家类型
 *  返回 false——存储层必须原样保留它们的判别符(见 normalizeAsrProviders),消费点靠
 *  本守卫显式拒绝/兜底,绝不静默当别家跑。 */
export function isPcKnownAsrType(type: unknown): boolean {
  return (PC_KNOWN_ASR_TYPES as readonly string[]).includes(String(type));
}

export function defaultAsrProvider(type: AsrProvider["type"] = "openai_realtime"): AsrProvider {
  if (type === "dashscope") {
    return {
      type,
      id: id(),
      name: "DashScope ASR",
      apiKey: "",
      websocketUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      model: "qwen3-asr-flash-realtime",
      language: "",
      sampleRate: 16000,
      vadThreshold: 0.2,
      silenceDurationMs: 800,
    };
  }
  if (type === "volcengine") {
    return {
      type,
      id: id(),
      name: "Volcengine ASR",
      apiKey: "",
      websocketUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
      resourceId: "volc.seedasr.sauc.duration",
      language: "",
    };
  }
  if (type === "mimo") {
    // 与安卓 ASRProviderSetting.MiMo 同形：HTTP 分段识别，baseUrl 走 OpenAI 兼容根地址。
    return {
      type,
      id: id(),
      name: "MiMo ASR",
      apiKey: "",
      websocketUrl: "",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-asr",
      language: "auto",
      sampleRate: 16000,
      segmentDurationSec: 30,
    };
  }
  return {
    type: "openai_realtime",
    id: id(),
    name: "OpenAI Realtime ASR",
    apiKey: "",
    websocketUrl: "wss://api.openai.com/v1/realtime?intent=transcription",
    model: "gpt-4o-transcribe",
    language: "",
    prompt: "",
    sampleRate: 24000,
    vadThreshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 500,
  };
}

export function normalizeAsrProviders(value: unknown): AsrProvider[] {
  if (!Array.isArray(value)) return [];
  const records = value.filter(isRecord);
  // backup C4/B2 联动:存在「本端未实现、跨端保留」的类型时上报一次(warn),让用户在错误中心
  // 看到「这个语音识别服务来自移动端,桌面端暂不支持」——保留 ≠ 静默(30s 风暴合并防刷屏)。
  const preservedTypes = [...new Set(records.map((i) => String(i.type ?? "")).filter((t) => t && !isPcKnownAsrType(t)))];
  if (preservedTypes.length > 0) {
    reportError("media", "warn", `检测到 ${preservedTypes.length} 类来自 APP端的语音识别服务，桌面端暂不支持，已原样保留以便回传：${preservedTypes.join("、")}`, undefined, "voice_provider_preserved", { kind: "asr", types: preservedTypes.join(",") });
  }
  return records
    .map((item) => {
      const rawType = String(item.type ?? "");
      // 跨端往返保真(backup C4):APP 有 5 家 ASR(openai_realtime/dashscope/volcengine/
      // mimo/step),桌面端实现前 4 家。step 在存储层必须原样保留 type——若在此收敛成
      // openai_realtime,用户精心配的阶跃 ASR 会在 APP→PC→APP 往返里被无声没收(这正是
      // "导入了一点反应都没有"的实锤之一)。保留后消费点显式降级(见 isPcKnownAsrType 守卫)。
      const type = isPcKnownAsrType(rawType) ? rawType : rawType || "openai_realtime";
      // 本端认识的类型套默认模板补全缺省字段;不认识的类型不套模板(避免 openai 默认
      // websocketUrl/model 污染),仅补 ASR 必填骨架,其余字段原样透传待 APP 取回。
      const base = isPcKnownAsrType(type) ? defaultAsrProvider(type) : null;
      return {
        ...base,
        ...item,
        type,
        id: String(item.id ?? base?.id ?? id()),
        name: String(item.name ?? base?.name ?? type),
        apiKey: String(item.apiKey ?? ""),
        websocketUrl: String(item.websocketUrl ?? base?.websocketUrl ?? ""),
      };
    });
}

function selectedAsrProvider() {
  return state.settings.asrProviders.find((provider) => provider.id === state.settings.selectedASRProviderId)
    ?? state.settings.asrProviders[0]
    ?? null;
}

// ---------------------------------------------------------------------------
// MiMo ASR（V2.5）：OpenAI Chat Completions 兼容的 HTTP 分段识别。
// 协议要点（与安卓 MiMoASRController、Kelivo _MimoAsrSession 一致）：
//   POST {baseUrl}/chat/completions
//   header: api-key（不是 Authorization: Bearer）
//   body: messages[0].content = [{ type:"input_audio", input_audio:{ data:"data:audio/wav;base64,..." } }]
//   只接受 wav / mp3；无服务端 VAD，按 segmentDurationSec 或 6MiB 切段，结果按段拼接。
// ---------------------------------------------------------------------------

function mimoChatEndpoint(provider: AsrProvider) {
  const base = (provider.baseUrl || "https://api.xiaomimimo.com/v1").trim().replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

function mimoRequestHeaders(provider: AsrProvider): Record<string, string> {
  return { "api-key": provider.apiKey, "Content-Type": "application/json" };
}

/** PCM16LE 单声道裸流包成 44 字节 RIFF/WAVE。 */
function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const rate = Math.max(8000, Number(sampleRate) || 16000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** MiMo 的转写文本在 choices[0].message.content；兼容数组分段与少数 text 兜底字段。 */
function mimoTranscriptText(raw: any): string {
  const content = raw?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part: any) => typeof part === "string" ? part : String(part?.text ?? "")).join("")
    : String(content ?? raw?.text ?? raw?.transcript ?? "");
  return text.trim();
}

async function requestMimoTranscription(audioDataUrl: string, provider: AsrProvider, audioLabel: string): Promise<string> {
  const endpoint = mimoChatEndpoint(provider);
  const headers = mimoRequestHeaders(provider);
  const body: Record<string, unknown> = {
    model: provider.model || "mimo-v2.5-asr",
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: audioDataUrl } }],
    }],
  };
  if (provider.language?.trim()) body.asr_options = { language: provider.language.trim() };
  const started = Date.now();
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: 120_000,
  });
  const rawText = await response.text();
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:asr",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: `chat-completions input_audio\nmodel=${provider.model || "mimo-v2.5-asr"}\nlanguage=${provider.language || "auto"}\naudio=${audioLabel}`,
    responseBody: textBody(rawText),
    error: response.ok ? undefined : textBody(rawText),
  });
  if (!response.ok) throw new Error(`MiMo ASR failed: ${response.status} ${rawText.slice(0, 500)}`);
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  return mimoTranscriptText(raw);
}

const MIMO_MAX_AUDIO_BYTES = Math.floor(7.5 * 1024 * 1024); // 官方上限约 10MB base64 ≈ 7.5MB 原始字节

async function transcribeWithMimo(file: File, provider: AsrProvider): Promise<string> {
  const name = (file.name || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const isWav = mime.includes("wav") || name.endsWith(".wav");
  const isMp3 = mime.includes("mpeg") || mime.includes("mp3") || name.endsWith(".mp3");
  if (!isWav && !isMp3) {
    // 官方只收 wav/mp3；网页录音常见 webm/ogg，服务端无解码器，明确告知而不是上传后 400。
    throw new Error("MiMo 语音识别仅支持 wav / mp3 音频（浏览器录音的 webm/ogg 需先转码）");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MIMO_MAX_AUDIO_BYTES) throw new Error("MiMo 语音识别单次音频不能超过约 7.5MB");
  return requestMimoTranscription(
    `data:${isWav ? "audio/wav" : "audio/mpeg"};base64,${bytes.toString("base64")}`,
    provider,
    file.name || "upload",
  );
}

function openAiAsrTranscriptionEndpoint(provider: AsrProvider) {
  try {
    const url = new URL(provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription");
    url.protocol = "https:";
    const basePath = url.pathname.replace(/\/realtime\/?$/, "").replace(/\/$/, "");
    url.pathname = `${basePath}/audio/transcriptions`;
    url.search = "";
    return url.toString();
  } catch {
    return "https://api.openai.com/v1/audio/transcriptions";
  }
}

export async function transcribeAudioWithAsrProvider(file: File) {
  const provider = selectedAsrProvider();
  if (!provider) throw new Error("No ASR provider configured");
  // 消费点降级(backup C4):step 等桌面端未实现的类型在存储层被原样保留(见
  // normalizeAsrProviders),这里显式拒绝并告知,绝不能落进 else 分支当 volcengine 跑。
  if (!isPcKnownAsrType(provider.type)) {
    throw new Error(`当前桌面端尚不支持「${provider.name}」(${provider.type})语音识别——该配置来自 APP端，请改用 OpenAI / DashScope / 火山引擎 / MiMo，或在 APP端使用`);
  }
  if (!provider.apiKey.trim()) throw new Error("ASR API Key is empty");
  if (provider.type === "mimo") return transcribeWithMimo(file, provider);
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrTranscriptionEndpoint(provider)
    : provider.type === "dashscope"
      ? "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription"
      : "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const form = new FormData();
  if (provider.type === "openai_realtime") {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || "gpt-4o-transcribe");
    if (provider.language?.trim()) form.append("language", provider.language.trim());
    if (provider.prompt?.trim()) form.append("prompt", provider.prompt.trim());
  } else {
    form.append("file", file, file.name || "speech.webm");
    form.append("model", provider.model || (provider.type === "dashscope" ? "paraformer-realtime-v2" : "bigmodel"));
    if (provider.language?.trim()) form.append("language", provider.language.trim());
  }
  const started = Date.now();
  const headers: Record<string, string> = provider.type === "openai_realtime"
    ? { Authorization: `Bearer ${provider.apiKey}` }
    : provider.type === "dashscope"
      ? { Authorization: `Bearer ${provider.apiKey}` }
      : {
          "X-Api-Key": provider.apiKey,
          "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
          "X-Api-Request-Id": id(),
        };
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: form,
    timeoutMs: 120_000, // 长音频转写偏慢,30s 默认会误杀
  });
  const rawText = await response.text();
  addLog({
    providerId: provider.id,
    providerName: provider.name,
    url: endpoint,
    ok: response.ok,
    status: response.status,
    kind: "provider:asr",
    durationMs: Date.now() - started,
    method: "POST",
    requestHeaders: headers,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    requestBody: `multipart audio transcription\nmodel=${provider.model || "gpt-4o-transcribe"}\nlanguage=${provider.language || "auto"}\nfile=${file.name || "speech.webm"}`,
    responseBody: textBody(rawText),
    error: response.ok ? undefined : textBody(rawText),
  });
  if (!response.ok) throw new Error(`ASR failed: ${response.status} ${rawText.slice(0, 500)}`);
  let raw: any = {};
  try {
    raw = rawText ? JSON.parse(rawText) : {};
  } catch {
    raw = { text: rawText };
  }
  return String(
    raw.text ??
    raw.transcript ??
    raw.output_text ??
    raw.output?.text ??
    raw.result?.text ??
    raw.data?.text ??
    raw.data?.result ??
    "",
  ).trim();
}

export const asrRealtimeSessions = new WeakMap<object, AsrRealtimeSession>();

function asrSendClient(session: AsrRealtimeSession, payload: Record<string, unknown>) {
  try {
    session.client.send(JSON.stringify(payload));
  } catch {
    // Client has gone away.
  }
}

function asrPublishTranscript(session: AsrRealtimeSession) {
  const transcript = [...session.completedTranscripts, ...session.partialTranscripts.values()]
    .filter((text) => text.trim().length > 0)
    .join(" ");
  asrSendClient(session, { type: "transcript", transcript });
}

/** 服务端 VAD 判停信号(语音模式专用):一句话说完、转写定稿时推一次。携带该句最终文本,
 *  前端据此收尾当前 utterance 并触发发送。去抖——同一句只推一次(Volcengine definite 会随
 *  累积全文重复到达;OpenAI/DashScope completed 本就一次)。 */
function asrSendTurnEnd(session: AsrRealtimeSession, text: string) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === session.lastTurnEndText) return;
  session.lastTurnEndText = trimmed;
  asrSendClient(session, { type: "turn_end", transcript: trimmed });
}

function asrFail(session: AsrRealtimeSession, message: string) {
  if (session.finished) return;
  asrSendClient(session, { type: "error", error: message });
  addLog({
    providerId: session.provider.id,
    providerName: session.provider.name,
    url: session.provider.type === "mimo" ? mimoChatEndpoint(session.provider) : session.provider.websocketUrl,
    ok: false,
    status: 0,
    kind: "provider:asr:realtime",
    durationMs: Date.now() - session.startedAt,
    error: message,
  });
}

function openAiAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://api.openai.com/v1/realtime?intent=transcription").trim();
  if (endpoint.includes("intent=transcription") || endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint.replace(/\/+$/, "")}${separator}intent=transcription`;
}

function dashScopeAsrEndpoint(provider: AsrProvider) {
  const endpoint = (provider.websocketUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/inference").trim().replace(/\/+$/, "");
  if (endpoint.includes("model=")) return endpoint;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}model=${encodeURIComponent(provider.model || "qwen3-asr-flash-realtime")}`;
}

function openAiAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = { model: provider.model || "gpt-4o-transcribe" };
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  if (provider.prompt?.trim()) transcription.prompt = provider.prompt.trim();
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: Number(provider.sampleRate || 24000) },
          transcription,
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: Number(provider.vadThreshold ?? 0.5),
            prefix_padding_ms: Number(provider.prefixPaddingMs ?? 300),
            silence_duration_ms: Number(provider.silenceDurationMs ?? 500),
          },
        },
      },
    },
  };
}

function dashScopeAsrSessionUpdate(provider: AsrProvider) {
  const transcription: Record<string, unknown> = {};
  if (provider.language?.trim()) transcription.language = provider.language.trim();
  const session: Record<string, unknown> = {
    modalities: ["text"],
    input_audio_format: "pcm",
    sample_rate: Number(provider.sampleRate || 16000),
    input_audio_transcription: transcription,
  };
  const vad = Number(provider.vadThreshold ?? 0.2);
  session.turn_detection = vad > 0
    ? { type: "server_vad", threshold: vad, silence_duration_ms: Number(provider.silenceDurationMs ?? 800) }
    : null;
  return { event_id: "evt_session_update", type: "session.update", session };
}

function base64FromArrayBuffer(data: ArrayBuffer) {
  return Buffer.from(data).toString("base64");
}

function handleTextAsrEvent(session: AsrRealtimeSession, text: string) {
  const event = JSON.parse(text || "{}") as Record<string, any>;
  switch (String(event.type ?? "")) {
    case "conversation.item.input_audio_transcription.delta": {
      const itemId = String(event.item_id || "default");
      const delta = String(event.delta || "");
      if (delta) {
        session.partialTranscripts.set(itemId, `${session.partialTranscripts.get(itemId) ?? ""}${delta}`);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.text": {
      const itemId = String(event.item_id || "default");
      const content = String(event.text || "");
      if (content) {
        session.partialTranscripts.set(itemId, content);
        asrPublishTranscript(session);
      }
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const itemId = String(event.item_id || "default");
      const transcript = String(event.transcript || "").trim();
      session.partialTranscripts.delete(itemId);
      if (transcript) session.completedTranscripts.push(transcript);
      asrPublishTranscript(session);
      // 一句话定稿 = 服务端 VAD 判停;通知语音模式收尾(听写模式忽略此消息)。
      if (transcript) asrSendTurnEnd(session, transcript);
      break;
    }
    case "error": {
      const message = String(event.error?.message || "ASR realtime error");
      asrFail(session, message);
      break;
    }
    default:
      break;
  }
}

const VOLC_MSG_FULL_CLIENT_REQUEST = 0x01;
const VOLC_MSG_AUDIO_ONLY = 0x02;
const VOLC_SER_NONE = 0x00;
const VOLC_SER_JSON = 0x01;
const VOLC_COMP_NONE = 0x00;
const VOLC_COMP_GZIP = 0x01;
const VOLC_FLAG_LAST_PACKET = 0x02;

function volcFrame(messageType: number, flags: number, serialization: number, compression: number, payload: Buffer) {
  const header = Buffer.from([0x11, ((messageType << 4) | (flags & 0x0f)) & 0xff, ((serialization << 4) | (compression & 0x0f)) & 0xff, 0x00]);
  const size = Buffer.alloc(4);
  size.writeInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function volcStartPayload(provider: AsrProvider) {
  const audio: Record<string, unknown> = { format: "pcm", rate: 16000, bits: 16, channel: 1 };
  if (provider.language?.trim()) audio.language = provider.language.trim();
  return Buffer.from(JSON.stringify({
    user: { uid: "rikkahub" },
    audio,
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
    },
  }));
}

function handleVolcAsrEvent(session: AsrRealtimeSession, data: ArrayBuffer) {
  const buffer = Buffer.from(data);
  if (buffer.length < 4) return;
  const byte1 = buffer[1] & 0xff;
  const byte2 = buffer[2] & 0xff;
  const messageType = (byte1 >> 4) & 0x0f;
  const messageFlags = byte1 & 0x0f;
  const compression = byte2 & 0x0f;
  let offset = 4;
  if (messageType === 0x09) {
    if ((messageFlags & 0x01) !== 0) offset += 4;
    if (offset + 4 > buffer.length) return;
    const payloadSize = buffer.readInt32BE(offset);
    offset += 4;
    if (payloadSize <= 0 || offset + payloadSize > buffer.length) return;
    const chunk = buffer.subarray(offset, offset + payloadSize);
    const payload = compression === VOLC_COMP_GZIP ? gunzipSync(chunk) : chunk;
    const raw = JSON.parse(payload.toString("utf8")) as Record<string, any>;
    const text = String(raw.result?.text || "");
    if (text && text !== session.lastText) {
      session.lastText = text;
      asrSendClient(session, { type: "transcript", transcript: text });
    }
    // 火山 VAD 判停:utterances[*].definite=true 表示该句经二遍纠错定稿。取定稿句文本推 turn_end;
    // definite 句会随累积全文重复到达,靠 asrSendTurnEnd 的去抖(lastTurnEndText)只推一次。
    const utterances = (raw.result?.utterances ?? []) as Array<Record<string, any>>;
    const definiteText = utterances
      .filter((u) => u?.definite === true)
      .map((u) => String(u?.text ?? ""))
      .join("")
      .trim();
    if (definiteText) asrSendTurnEnd(session, definiteText);
  } else if (messageType === 0x0f) {
    if (offset + 8 > buffer.length) return;
    offset += 4;
    const size = buffer.readInt32BE(offset);
    offset += 4;
    const message = size > 0 && offset + size <= buffer.length ? buffer.subarray(offset, offset + size).toString("utf8") : "Volcengine ASR error";
    asrFail(session, message);
  }
}

// ---------------------------------------------------------------------------
// MiMo 伪实时:没有 WebSocket 与服务端 VAD,按 segmentDurationSec 把 PCM 攒成 WAV
// 分段上传,结果顺序拼接后按普通 transcript 推给前端(听写模式直接可用)。
// ---------------------------------------------------------------------------

function mimoSampleRate(provider: AsrProvider) {
  const rate = Number(provider.sampleRate || 16000);
  return Number.isFinite(rate) && rate >= 8000 ? Math.floor(rate) : 16000;
}

/** 单段最多字节数:按时长阈值算,并压到请求体积上限以内(留出 base64 膨胀余量)。 */
function mimoSegmentBytes(provider: AsrProvider) {
  const seconds = Number(provider.segmentDurationSec ?? 30);
  const byDuration = seconds > 0 ? seconds * mimoSampleRate(provider) * 2 : MIMO_MAX_AUDIO_BYTES;
  return Math.max(3200, Math.min(Math.floor(byDuration), 6 * 1024 * 1024));
}

async function flushMimoSegment(session: AsrRealtimeSession, force = false) {
  if (session.mimoFlushing) return;
  const provider = session.provider;
  const threshold = mimoSegmentBytes(provider);
  // 循环到缓冲低于阈值(或强制时清空)。上传期间新到的音频会自然进入下一轮,保证顺序。
  while (session.mimoPcm.length >= threshold || (force && session.mimoPcm.length > 0)) {
    const size = force ? session.mimoPcm.length : Math.min(session.mimoPcm.length, threshold);
    const chunk = session.mimoPcm.subarray(0, size);
    session.mimoPcm = session.mimoPcm.subarray(size);
    // 过短片段(低于 ~50ms)送上去只会被拒,直接丢弃。
    if (chunk.length < Math.max(2, Math.floor(mimoSampleRate(provider) * 0.05) * 2)) continue;
    session.mimoFlushing = true;
    try {
      const wav = pcm16MonoToWav(chunk, mimoSampleRate(provider));
      const text = await requestMimoTranscription(
        `data:audio/wav;base64,${wav.toString("base64")}`,
        provider,
        `realtime segment ${chunk.length}B`,
      );
      if (text) {
        session.completedTranscripts.push(text);
        session.lastText = [...session.completedTranscripts, ...session.partialTranscripts.values()].join(" ");
        asrPublishTranscript(session);
      }
    } catch (err) {
      asrFail(session, err instanceof Error ? err.message : String(err));
      // 授权/网络类错误不会因为继续分段而自愈:停掉后续上传,避免每 30s 刷一条错误。
      session.mimoStopped = true;
      session.mimoPcm = Buffer.alloc(0);
    } finally {
      session.mimoFlushing = false;
    }
  }
}

/** stop 后的收尾:等正在上传的分段落盘,再强制清空剩余缓冲。 */
async function drainMimoSession(session: AsrRealtimeSession) {
  while (session.mimoFlushing) await new Promise((resolve) => setTimeout(resolve, 20));
  await flushMimoSegment(session, true);
  while (session.mimoFlushing) await new Promise((resolve) => setTimeout(resolve, 20));
}

export function sendAsrAudio(session: AsrRealtimeSession, data: ArrayBuffer) {
  if (session.provider.type === "mimo") {
    if (session.mimoStopped) return;
    session.mimoPcm = Buffer.concat([session.mimoPcm, Buffer.from(data)]);
    if (session.mimoPcm.length >= mimoSegmentBytes(session.provider)) {
      // 分段上传异步进行;失败经 asrFail 推 error,不阻塞后续音频。
      void flushMimoSegment(session);
    }
    return;
  }
  if (!session.upstream || session.upstream.readyState !== WebSocket.OPEN) {
    session.pendingFrames.push(data);
    return;
  }
  if (session.provider.type === "volcengine") {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, 0x00, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.from(data)));
    return;
  }
  const event: Record<string, unknown> = {
    type: "input_audio_buffer.append",
    audio: base64FromArrayBuffer(data),
  };
  if (session.provider.type === "dashscope") event.event_id = `evt_${Date.now()}`;
  session.upstream.send(JSON.stringify(event));
}

export function startAsrRealtimeSession(client: any, providerId?: string) {
  const provider = state.settings.asrProviders.find((item) => item.id === providerId) ?? selectedAsrProvider();
  if (!provider) {
    client.send(JSON.stringify({ type: "error", error: "No ASR provider configured" }));
    return;
  }
  if (!provider.apiKey.trim()) {
    client.send(JSON.stringify({ type: "error", error: "ASR API Key is empty" }));
    return;
  }
  // 消费点降级(backup C4):未实现的跨端类型(step 等)显式拒绝,不落进下方
  // else 分支被当 volcengine 端点连上错误的 WebSocket。
  if (!isPcKnownAsrType(provider.type)) {
    client.send(JSON.stringify({ type: "error", error: `当前桌面端尚不支持「${provider.name}」(${provider.type})语音识别，请在 APP端使用` }));
    return;
  }
  const endpoint = provider.type === "openai_realtime"
    ? openAiAsrEndpoint(provider)
    : provider.type === "dashscope"
      ? dashScopeAsrEndpoint(provider)
      : provider.websocketUrl || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
  const session: AsrRealtimeSession = {
    provider,
    client,
    upstream: null,
    completedTranscripts: [],
    partialTranscripts: new Map(),
    lastText: "",
    pendingFrames: [],
    opened: false,
    finished: false,
    startedAt: Date.now(),
    volcSequence: 1,
    lastTurnEndText: "",
    mimoPcm: Buffer.alloc(0),
    mimoFlushing: false,
    mimoStopped: false,
  };
  asrRealtimeSessions.set(client, session);
  if (provider.type === "mimo") {
    // 与真·实时会话对齐的首帧:前端拿到 listening 后开始灌音频。
    asrSendClient(session, { type: "status", status: "listening" });
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: mimoChatEndpoint(provider),
      ok: true,
      status: 0,
      kind: "provider:asr:realtime",
      durationMs: 0,
      requestBody: `mimo segmented http\nmodel=${provider.model || "mimo-v2.5-asr"}\nsampleRate=${mimoSampleRate(provider)}\nsegmentDurationSec=${provider.segmentDurationSec ?? 30}`,
    });
    return;
  }
  const headers: Record<string, string> = provider.type === "volcengine"
    ? {
        "X-Api-Key": provider.apiKey,
        "X-Api-Resource-Id": provider.resourceId || "volc.seedasr.sauc.duration",
        "X-Api-Request-Id": id(),
        "X-Api-Sequence": "-1",
      }
    : {
        Authorization: `Bearer ${provider.apiKey}`,
        ...(provider.type === "dashscope" ? { "OpenAI-Beta": "realtime=v1" } : {}),
      };
  // Bun 的 WebSocket 不自动读 HTTPS_PROXY env (跟 fetch 不同), 必须显式传 proxy 选项,
  // 否则 ASR/TTS 的 wss 请求在配了代理的环境下会绕过代理直连失败。
  const wsProxy: string | undefined = (() => {
    const cfg = state?.settings?.proxyConfig;
    const mode = cfg?.mode ?? "auto";
    if (mode === "env" || mode === "direct") return undefined;
    const { url } = resolveEffectiveProxy(state.settings.proxyConfig);
    if (!url) return undefined;
    if (shouldBypassProxy(endpoint, cfg?.bypassRules ?? "")) return undefined;
    return url;
  })();
  const upstream = new WebSocket(endpoint, (wsProxy ? { headers, proxy: wsProxy } : { headers }) as any);
  session.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    session.opened = true;
    if (provider.type === "openai_realtime") upstream.send(JSON.stringify(openAiAsrSessionUpdate(provider)));
    if (provider.type === "dashscope") upstream.send(JSON.stringify(dashScopeAsrSessionUpdate(provider)));
    if (provider.type === "volcengine") {
      upstream.send(volcFrame(VOLC_MSG_FULL_CLIENT_REQUEST, 0x00, VOLC_SER_JSON, VOLC_COMP_GZIP, gzipSync(volcStartPayload(provider))));
    }
    asrSendClient(session, { type: "status", status: "listening" });
    for (const frame of session.pendingFrames.splice(0)) sendAsrAudio(session, frame);
  };
  upstream.onmessage = (event) => {
    try {
      if (typeof event.data === "string") handleTextAsrEvent(session, event.data);
      else handleVolcAsrEvent(session, event.data as ArrayBuffer);
    } catch (err) {
      asrFail(session, err instanceof Error ? err.message : String(err));
    }
  };
  upstream.onerror = () => asrFail(session, "ASR websocket failed");
  upstream.onclose = () => {
    session.finished = true;
    addLog({
      providerId: provider.id,
      providerName: provider.name,
      url: endpoint,
      ok: true,
      status: 0,
      kind: "provider:asr:realtime",
      durationMs: Date.now() - session.startedAt,
      requestBody: `realtime pcm websocket\nprovider=${provider.type}\nsampleRate=${provider.sampleRate || (provider.type === "openai_realtime" ? 24000 : 16000)}`,
      responseBody: session.lastText || [...session.completedTranscripts, ...session.partialTranscripts.values()].join(" "),
    });
    asrSendClient(session, { type: "status", status: "idle" });
  };
}

export function stopAsrRealtimeSession(client: any) {
  const session = asrRealtimeSessions.get(client);
  if (!session) return;
  if (session.provider.type === "mimo") {
    // 前端 stop 后必须等文件段落盘再收尾——立即断开会让最后一段(往往是整句)丢失。
    // 收尾完成后推 idle,前端据此关闭 WebSocket(见 chat-input 的 MiMo 等待逻辑)。
    session.mimoStopped = true;
    asrRealtimeSessions.delete(client);
    void drainMimoSession(session).finally(() => {
      session.finished = true;
      addLog({
        providerId: session.provider.id,
        providerName: session.provider.name,
        url: mimoChatEndpoint(session.provider),
        ok: true,
        status: 0,
        kind: "provider:asr:realtime",
        durationMs: Date.now() - session.startedAt,
        requestBody: `mimo segmented http\nmodel=${session.provider.model || "mimo-v2.5-asr"}\nsampleRate=${mimoSampleRate(session.provider)}\nsegmentDurationSec=${session.provider.segmentDurationSec ?? 30}`,
        responseBody: session.lastText,
      });
      asrSendClient(session, { type: "status", status: "idle" });
    });
    return;
  }
  if (session.provider.type === "volcengine" && session.upstream?.readyState === WebSocket.OPEN) {
    session.upstream.send(volcFrame(VOLC_MSG_AUDIO_ONLY, VOLC_FLAG_LAST_PACKET, VOLC_SER_NONE, VOLC_COMP_NONE, Buffer.alloc(0)));
  }
  session.upstream?.close(1000, "stop");
  asrRealtimeSessions.delete(client);
}
