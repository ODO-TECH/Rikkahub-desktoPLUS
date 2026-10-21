// media/asr-mimo.test.ts — MiMo ASR 协议与伪实时分段的行为锁。
// 用本地 HTTP stub 取代真实 MiMo 服务,验证:api-key 头(非 Bearer)、chat/completions +
// input_audio 报文、wav/mp3 限制、到达阈值即上传、stop 后冲刷最后一段并推 idle。
import { afterAll, expect, mock, test } from "bun:test";

// model-providers 会拉入 pi 子仓(本仓 checkout 不含),这里只用到 textBody 的纯函数语义。
mock.module("../model-providers", () => ({ textBody: (text: string) => text }));
mock.module("../api/logs", () => ({ addLog: () => {} }));

const { setState } = await import("../persistence/json-store");
const { transcribeAudioWithAsrProvider, startAsrRealtimeSession, stopAsrRealtimeSession, sendAsrAudio, asrRealtimeSessions } = await import("./asr");

const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
let reply = "你好世界";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json();
    requests.push({ url: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body });
    return Response.json({ choices: [{ message: { content: reply } }] });
  },
});

function configure(overrides: Record<string, unknown> = {}) {
  const provider = {
    type: "mimo",
    id: "m1",
    name: "MiMo ASR",
    apiKey: "secret-key",
    websocketUrl: "",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    model: "mimo-v2.5-asr",
    language: "auto",
    sampleRate: 16000,
    segmentDurationSec: 30,
    ...overrides,
  };
  setState({ settings: { asrProviders: [provider], selectedASRProviderId: "m1", proxyConfig: undefined } } as any);
  return provider;
}

test("file transcription: protocol shape", async () => {
  configure();
  requests.length = 0;
  reply = "文件转写";
  const wav = new Uint8Array(100).buffer;
  const file = new File([wav], "a.wav", { type: "audio/wav" });
  const text = await transcribeAudioWithAsrProvider(file as any);
  expect(text).toBe("文件转写");
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("/v1/chat/completions");
  expect(requests[0].headers["api-key"]).toBe("secret-key");
  expect(requests[0].headers["authorization"]).toBeUndefined();
  expect(requests[0].body.model).toBe("mimo-v2.5-asr");
  expect(requests[0].body.asr_options).toEqual({ language: "auto" });
  expect(requests[0].body.messages[0].content[0].type).toBe("input_audio");
  expect(requests[0].body.messages[0].content[0].input_audio.data.startsWith("data:audio/wav;base64,")).toBe(true);
});

test("file transcription: non wav/mp3 rejected before upload", async () => {
  configure();
  requests.length = 0;
  const file = new File([new Uint8Array(10)], "a.webm", { type: "audio/webm" });
  await expect(transcribeAudioWithAsrProvider(file as any)).rejects.toThrow(/wav \/ mp3/);
  expect(requests).toHaveLength(0);
});

test("realtime: segments at threshold, flushes tail on stop, emits idle", async () => {
  configure({ segmentDurationSec: 0.1 }); // 3200 bytes ≈ 100ms
  requests.length = 0;
  reply = "第一段";
  const messages: any[] = [];
  const client = { send: (raw: string) => messages.push(JSON.parse(raw)) };
  startAsrRealtimeSession(client, "m1");
  expect(messages[0]).toEqual({ type: "status", status: "listening" });
  // 150ms 音频 → 满 100ms 的第一段立即上传,剩 50ms 留在缓冲。
  sendAsrAudio(asrRealtimeSessions.get(client)!, new Uint8Array(4800).buffer);
  await new Promise((r) => setTimeout(r, 100));
  expect(requests).toHaveLength(1);
  expect(messages.some((m) => m.type === "transcript" && m.transcript === "第一段")).toBe(true);
  // stop:剩余 100ms 强制上传,然后 idle。
  reply = "第二段";
  stopAsrRealtimeSession(client);
  const deadline = Date.now() + 3000;
  while (!messages.some((m) => m.type === "status" && m.status === "idle") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(requests).toHaveLength(2);
  expect(messages.at(-1)).toEqual({ type: "status", status: "idle" });
  const finalTranscript = [...messages].reverse().find((m) => m.type === "transcript")?.transcript;
  expect(finalTranscript).toBe("第一段 第二段");
});

afterAll(() => server.stop(true));
