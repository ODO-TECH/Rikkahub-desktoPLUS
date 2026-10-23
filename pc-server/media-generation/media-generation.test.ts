// media-generation.test.ts — 媒体生成的本地协议回归：零真实出站、零付费额度。
// 适配器指向本机 Bun.serve mock，覆盖能力矩阵、5 家协议、落盘账本与手动任务的异步/取消。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-media-generation-test-"));

import type { State } from "../foundation/types";
import type { MediaGenerationProviderConfig, MediaModelRef } from "../foundation/types/settings";
import type { MediaKind, MediaProviderContext } from "./types";

const { dataDir, filesDir } = await import("../foundation/paths");
mkdirSync(filesDir, { recursive: true });

const jsonStore = await import("../persistence/json-store");
const { setState } = jsonStore;
const { defaultRequestStats } = await import("../api/logs");
const {
  cancelMediaGeneration,
  generateMedia,
  isMediaRecordCancelled,
  startMediaGeneration,
  withMediaConversationLock,
} = await import("./service");
const { mediaCapability } = await import("./capabilities");
const { openaiMediaAdapter } = await import("./providers/openai");
const { aliyunMediaAdapter } = await import("./providers/aliyun");
const { volcengineMediaAdapter } = await import("./providers/volcengine");
const { minimaxMediaAdapter } = await import("./providers/minimax");
const { openrouterMediaAdapter } = await import("./providers/openrouter");

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const REF_PNG_PATH = join(dataDir, "reference.png");

const IMAGE_REF: MediaModelRef = { providerId: "p-openai", modelId: "gpt-image-1" };
const MINIMAX_REF: MediaModelRef = { providerId: "p-minimax", modelId: "MiniMax-H3" };
const ALIYUN_VIDEO_REF: MediaModelRef = { providerId: "p-aliyun", modelId: "wan-video" };

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let handler: (request: Request, url: URL) => Response | Promise<Response> = () => json({}, 404);
let captured: Array<{ method: string; pathname: string; headers: Record<string, string>; body: string }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function provider(
  id: string,
  type: MediaGenerationProviderConfig["type"],
  name: string,
  models: MediaGenerationProviderConfig["models"],
): MediaGenerationProviderConfig {
  return { id, type, name, apiKey: `${type}-key`, baseUrl, models };
}

function resetState() {
  setState({
    settings: {
      mediaGenerationProviders: [
        provider("p-openai", "openai", "Test OpenAI", [{ modelId: "gpt-image-1", kind: "image" }]),
        provider("p-minimax", "minimax", "Test MiniMax", [{ modelId: "MiniMax-H3", kind: "video" }]),
        provider("p-aliyun", "aliyun", "Test Aliyun", [
          { modelId: "wanx-image", kind: "image" },
          { modelId: "wan-video", kind: "video" },
        ]),
        provider("p-volcengine", "volcengine", "Test Volcengine", [
          { modelId: "seedance", kind: "video" },
        ]),
        provider("p-openrouter", "openrouter", "Test OpenRouter", [
          { modelId: "openai/gpt-image", kind: "image" },
          { modelId: "google/veo", kind: "video" },
        ]),
      ],
      uploadS3Config: null,
    },
    files: [],
    generatedMedia: [],
    nextFileId: 1,
    logs: [],
    stats: defaultRequestStats(),
  } as unknown as State);
}

function adapterContext(
  type: MediaGenerationProviderConfig["type"],
  name: string,
  modelId: string,
  kind: MediaKind,
): MediaProviderContext {
  return {
    config: provider(`p-${type}`, type, name, [{ modelId, kind }]),
    model: { modelId, kind },
    baseUrl,
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();
      captured.push({
        method: request.method,
        pathname: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });
      return handler(request, url);
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  writeFileSync(REF_PNG_PATH, Buffer.from("89504e470d0a1a0a", "hex"));
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  captured = [];
  handler = () => json({}, 404);
  resetState();
});

describe("能力矩阵", () => {
  test("OpenAI 只有图片，MiniMax 只有视频，其余三家双向", () => {
    expect(mediaCapability("openai", "image")).not.toBeNull();
    expect(mediaCapability("openai", "video")).toBeNull();
    expect(mediaCapability("minimax", "image")).toBeNull();
    expect(mediaCapability("minimax", "video")).not.toBeNull();
    for (const type of ["aliyun", "volcengine", "openrouter"] as const) {
      expect(mediaCapability(type, "image")).not.toBeNull();
      expect(mediaCapability(type, "video")).not.toBeNull();
    }
  });

  test("MiniMax 视频要求分辨率 / 比例 / 时长全部显式给出", () => {
    expect(mediaCapability("minimax", "video")?.required).toEqual([
      "resolution",
      "aspectRatio",
      "durationSeconds",
    ]);
    expect(mediaCapability("minimax", "video")?.requiresPrompt).toBe(true);
    expect(mediaCapability("aliyun", "video")?.framesExcludeReferences).toBe(true);
  });
});

describe("手动任务账本", () => {
  test("startMediaGeneration 先返回记录 id，后台完成后账本带 outputs", async () => {
    handler = (_request, url) =>
      url.pathname === "/images/generations" ? json({ created: 1, data: [{ b64_json: PNG_B64 }] }) : json({}, 404);
    const recordId = await startMediaGeneration({
      kind: "image",
      ref: IMAGE_REF,
      prompt: "a red fox",
      count: 1,
    });
    expect(recordId).toBeTruthy();
    expect(jsonStore.state.generatedMedia.some((record) => record.id === recordId)).toBe(true);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (jsonStore.state.generatedMedia.find((record) => record.id === recordId)?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const record = jsonStore.state.generatedMedia.find((item) => item.id === recordId);
    expect(record?.status).toBe("succeeded");
    expect(record?.outputs).toHaveLength(1);
    expect(record?.fileId).toBe(record?.outputs?.[0]?.fileId ?? -1);
  });

  test("取消排队中的任务：账本停在 cancelled，记录进入取消集", async () => {
    handler = (_request, url) =>
      url.pathname === "/services/aigc/video-generation/video-synthesis"
        ? json({ output: { task_id: "ali-cancel", task_status: "PENDING" } })
        : json({}, 404);
    const recordId = await startMediaGeneration({
      kind: "video",
      ref: ALIYUN_VIDEO_REF,
      prompt: "waves",
      resolution: "720P",
      aspectRatio: "16:9",
      durationSeconds: 5,
    });
    expect(cancelMediaGeneration(recordId)).not.toBeNull();
    expect(isMediaRecordCancelled(recordId)).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (jsonStore.state.generatedMedia.find((record) => record.id === recordId)?.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(jsonStore.state.generatedMedia.find((record) => record.id === recordId)?.status).toBe("cancelled");
  });
});

describe("供应商适配器", () => {
  test("OpenAI：无参考走 generations，有参考走 multipart edits", async () => {
    handler = (_request, url) =>
      url.pathname === "/images/generations" ? json({ created: 1, data: [{ b64_json: PNG_B64 }] }) : json({}, 404);
    const ctx = adapterContext("openai", "Test OpenAI", "gpt-image-1", "image");
    const task = await openaiMediaAdapter.create(ctx, {
      prompt: "a cat",
      inputs: [],
      count: 2,
      resolution: "1024x1024",
    });
    expect(task.status).toBe("succeeded");
    expect(task.outputs).toHaveLength(1);
    expect(task.outputs[0]?.data?.toString("base64")).toBe(PNG_B64);
    expect(task.outputs[0]?.mime).toBe("image/png");
    const generation = captured.find((entry) => entry.pathname === "/images/generations");
    expect(generation?.headers.authorization).toBe("Bearer openai-key");
    expect(JSON.parse(generation?.body ?? "{}")).toMatchObject({
      model: "gpt-image-1",
      prompt: "a cat",
      n: 2,
      size: "1024x1024",
    });

    captured = [];
    handler = (_request, url) => (url.pathname === "/images/edits" ? json({ data: [{ b64_json: PNG_B64 }] }) : json({}, 404));
    const edit = await openaiMediaAdapter.create(ctx, {
      prompt: "restyle",
      inputs: [
        { type: "image", role: "reference", url: "file://reference.png", localPath: REF_PNG_PATH, fileName: "reference.png" },
      ],
    });
    expect(edit.status).toBe("succeeded");
    const edits = captured.find((entry) => entry.pathname === "/images/edits");
    expect(edits?.headers.authorization).toBe("Bearer openai-key");
    expect(edits?.headers["content-type"]).toContain("multipart/form-data");
    expect(edits?.body).toContain('name="image"');
    expect(edits?.body).toContain('filename="reference.png"');
    expect(edits?.body).toContain("restyle");
  });

  test("阿里云：异步创建带 X-DashScope-Async，轮询取回 video_url", async () => {
    handler = (_request, url) => {
      if (url.pathname === "/services/aigc/video-generation/video-synthesis") {
        return json({ output: { task_id: "ali-task-1", task_status: "PENDING" } });
      }
      if (url.pathname === "/tasks/ali-task-1") {
        return json({
          output: {
            task_id: "ali-task-1",
            task_status: "SUCCEEDED",
            video_url: "https://cdn.example.com/v.mp4",
          },
          usage: { output_video_duration: 5, SR: "720P", ratio: "16:9" },
        });
      }
      return json({}, 404);
    };
    const ctx = adapterContext("aliyun", "Test Aliyun", "wan-video", "video");
    const created = await aliyunMediaAdapter.create(ctx, {
      prompt: "waves",
      inputs: [],
      resolution: "720P",
      aspectRatio: "16:9",
      durationSeconds: 5,
      generateAudio: true,
      watermark: false,
      seed: 42,
    });
    expect(created.providerTaskId).toBe("ali-task-1");
    expect(created.status).toBe("queued");
    const submission = captured[0];
    expect(submission?.pathname).toBe("/services/aigc/video-generation/video-synthesis");
    expect(submission?.headers["x-dashscope-async"]).toBe("enable");
    expect(JSON.parse(submission?.body ?? "{}")).toMatchObject({
      model: "wan-video",
      parameters: { resolution: "720P", ratio: "16:9", duration: 5, audio: true, watermark: false, seed: 42 },
    });

    const polled = await aliyunMediaAdapter.query!(ctx, "ali-task-1");
    expect(polled.status).toBe("succeeded");
    expect(polled.outputs[0]).toMatchObject({
      url: "https://cdn.example.com/v.mp4",
      mime: "video/mp4",
      durationSeconds: 5,
      resolution: "720P",
      aspectRatio: "16:9",
    });
  });

  test("火山：任务创建与查询映射 status / content.video_url", async () => {
    handler = (_request, url) => {
      if (url.pathname === "/contents/generations/tasks") {
        return json({ id: "volc-1", status: "queued" });
      }
      if (url.pathname === "/contents/generations/tasks/volc-1") {
        return json({
          id: "volc-1",
          status: "succeeded",
          content: { video_url: "https://cdn.example.com/volc.mp4" },
          duration: 6,
          resolution: "1080P",
          ratio: "16:9",
        });
      }
      return json({}, 404);
    };
    const ctx = adapterContext("volcengine", "Test Volcengine", "seedance", "video");
    const created = await volcengineMediaAdapter.create(ctx, {
      prompt: "fire",
      inputs: [],
      resolution: "1080P",
      aspectRatio: "16:9",
      durationSeconds: 6,
      generateAudio: false,
    });
    expect(created.providerTaskId).toBe("volc-1");
    expect(created.status).toBe("queued");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      model: "seedance",
      content: [{ type: "text", text: "fire" }],
      resolution: "1080P",
      ratio: "16:9",
      duration: 6,
      generate_audio: false,
    });

    const polled = await volcengineMediaAdapter.query!(ctx, "volc-1");
    expect(polled.status).toBe("succeeded");
    expect(polled.outputs[0]).toMatchObject({ url: "https://cdn.example.com/volc.mp4", durationSeconds: 6 });
  });

  test("MiniMax：task_id 创建 + task 轮询，同源下载才带 Bearer", async () => {
    handler = (_request, url) => {
      if (url.pathname === "/video_generation") return json({ task_id: "mm-1" });
      if (url.pathname === "/query/video_generation/mm-1") {
        return json({
          task: {
            id: "mm-1",
            status: "success",
            model: "MiniMax-H3",
            content: { url: `${baseUrl}/files/out.mp4` },
            duration: 6,
            resolution: "768P",
            ratio: "16:9",
          },
        });
      }
      return json({}, 404);
    };
    const ctx = adapterContext("minimax", "Test MiniMax", "MiniMax-H3", "video");
    const created = await minimaxMediaAdapter.create(ctx, {
      prompt: "rain",
      inputs: [],
      resolution: "768P",
      aspectRatio: "16:9",
      durationSeconds: 6,
      watermark: true,
    });
    expect(created.providerTaskId).toBe("mm-1");
    expect(JSON.parse(captured[0]?.body ?? "{}")).toMatchObject({
      model: "MiniMax-H3",
      resolution: "768P",
      ratio: "16:9",
      duration: 6,
      aigc_watermark: true,
    });

    const polled = await minimaxMediaAdapter.query!(ctx, "mm-1");
    expect(polled.status).toBe("succeeded");
    expect(polled.outputs[0]?.url).toBe(`${baseUrl}/files/out.mp4`);
    expect(minimaxMediaAdapter.downloadHeaders?.(ctx, `${baseUrl}/files/out.mp4`)).toEqual({
      Authorization: "Bearer minimax-key",
    });
    expect(minimaxMediaAdapter.downloadHeaders?.(ctx, "https://other.example.com/out.mp4")).toEqual({});
  });

  test("OpenRouter：图片同步 base64，视频轮询把相对地址补成绝对地址", async () => {
    handler = (_request, url) =>
      url.pathname === "/images" ? json({ data: [{ b64_json: PNG_B64, media_type: "image/webp" }] }) : json({}, 404);
    const imageCtx = adapterContext("openrouter", "Test OpenRouter", "openai/gpt-image", "image");
    const imageTask = await openrouterMediaAdapter.create(imageCtx, { prompt: "a cat", inputs: [], count: 1 });
    expect(imageTask.status).toBe("succeeded");
    expect(imageTask.outputs[0]?.mime).toBe("image/webp");
    expect(captured[0]?.headers["x-title"]).toBe("RikkaHub");

    captured = [];
    handler = (request, url) => {
      if (request.method === "POST" && url.pathname === "/videos") {
        return json({ id: "or-1", status: "pending", unsigned_urls: [] });
      }
      if (request.method === "GET" && url.pathname === "/videos/or-1") {
        return json({ id: "or-1", status: "completed", unsigned_urls: ["/files/or.mp4"] });
      }
      return json({}, 404);
    };
    const videoCtx = adapterContext("openrouter", "Test OpenRouter", "google/veo", "video");
    const created = await openrouterMediaAdapter.create(videoCtx, { prompt: "waves", inputs: [] });
    expect(created.providerTaskId).toBe("or-1");
    expect(created.status).toBe("queued");
    const polled = await openrouterMediaAdapter.query!(videoCtx, "or-1");
    expect(polled.status).toBe("succeeded");
    expect(polled.outputs[0]?.url).toBe(`${baseUrl}/files/or.mp4`);
  });
});

describe("generateMedia 服务", () => {
  test("OpenAI 同步图片：提交、落盘并登记账本", async () => {
    handler = (_request, url) =>
      url.pathname === "/images/generations" ? json({ created: 1, data: [{ b64_json: PNG_B64 }] }) : json({}, 404);
    const result = await generateMedia({
      kind: "image",
      ref: IMAGE_REF,
      prompt: "a red fox",
      count: 1,
    });
    expect(result.task.status).toBe("succeeded");
    expect(result.record.status).toBe("succeeded");
    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0]!;
    expect(output.mime).toBe("image/png");
    expect(existsSync(output.file.path)).toBe(true);
    expect(readFileSync(output.file.path).toString("base64")).toBe(PNG_B64);
    expect(jsonStore.state.generatedMedia[0]).toMatchObject({
      status: "succeeded",
      kind: "image",
      modelId: "gpt-image-1",
      fileId: output.file.id,
      prompt: "a red fox",
    });
    const submission = captured.find((entry) => entry.pathname === "/images/generations");
    expect(submission?.headers.authorization).toBe("Bearer openai-key");
    expect(JSON.parse(submission?.body ?? "{}")).toMatchObject({
      model: "gpt-image-1",
      prompt: "a red fox",
      n: 1,
    });
  });

  test("供应商 4xx：原样抛出可读错误，账本记为 failed", async () => {
    handler = () => json({ error: { code: "invalid_api_key", message: "bad key" } }, 401);
    let message = "";
    try {
      await generateMedia({ kind: "image", ref: IMAGE_REF, prompt: "a cat" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Test OpenAI 媒体请求失败 (401, invalid_api_key)");
    expect(message).toContain("bad key");
    expect(jsonStore.state.generatedMedia[0]?.status).toBe("failed");
    expect(jsonStore.state.generatedMedia[0]?.error ?? "").toContain("bad key");
  });

  test("能力矩阵前置校验：缺必填、参数越界、首尾帧与参考图互斥", async () => {
    await expect(
      generateMedia({
        kind: "video",
        ref: MINIMAX_REF,
        prompt: "x",
        resolution: "720P",
        aspectRatio: "16:9",
      }),
    ).rejects.toThrow("缺少必填参数：durationSeconds");
    await expect(
      generateMedia({ kind: "image", ref: IMAGE_REF, prompt: "x", aspectRatio: "16:9" }),
    ).rejects.toThrow("不支持参数：aspectRatio");
    await expect(
      generateMedia({
        kind: "video",
        ref: ALIYUN_VIDEO_REF,
        prompt: "x",
        inputs: [
          { type: "image", role: "first_frame", url: "https://example.com/first.png" },
          { type: "image", role: "reference", url: "https://example.com/ref.png" },
        ],
      }),
    ).rejects.toThrow("首尾帧与参考图不能同时使用");
    expect(captured).toHaveLength(0);
  });

  test("同一会话的媒体任务串行执行", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withMediaConversationLock("c-lock", async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    });
    const second = withMediaConversationLock("c-lock", async () => {
      events.push("second-start");
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("「获取模型」列举", () => {
  test("认得 data / models / result 三种报文形态", async () => {
    const { parseMediaModelList } = await import("./model-list");
    expect(parseMediaModelList({ data: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
    expect(parseMediaModelList({ models: ["c", "d"] })).toEqual(["c", "d"]);
    expect(parseMediaModelList({ result: [{ model_id: "e" }, { name: "" }] })).toEqual(["e"]);
    expect(parseMediaModelList({ error: "nope" })).toEqual([]);
  });

  test("类型猜测：视频线索优先，猜不中回落该供应商首个类型", async () => {
    const { inferMediaKind } = await import("./model-list");
    const both: MediaKind[] = ["image", "video"];
    expect(inferMediaKind("wan2.2-t2v-plus", both)).toBe("video");
    expect(inferMediaKind("jimeng-t2i-v3", both)).toBe("image");
    expect(inferMediaKind("mystery-model", both)).toBe("image");
    expect(inferMediaKind("mystery-model", ["video"])).toBe("video");
  });

  test("GET <baseUrl>/models：带 Bearer、去重、排序并猜类型", async () => {
    const { fetchMediaProviderModels } = await import("./model-list");
    handler = () =>
      json({
        data: [
          { id: "z-image-turbo" },
          { id: "wan2.2-t2v-plus" },
          { id: "z-image-turbo" },
          { id: "" },
          { id: "seedream-4-0" },
        ],
      });
    const result = await fetchMediaProviderModels(
      provider("p-aliyun", "aliyun", "Test Aliyun", [{ modelId: "占位", kind: "image" }]),
    );
    expect(captured.map((item) => [item.method, item.pathname])).toEqual([["GET", "/models"]]);
    expect(captured[0].headers.authorization).toBe("Bearer aliyun-key");
    expect(result.models).toEqual([
      { modelId: "seedream-4-0", kind: "image" },
      { modelId: "wan2.2-t2v-plus", kind: "video" },
      { modelId: "z-image-turbo", kind: "image" },
    ]);
  });

  test("阿里云地址里的 {WorkspaceId} 先替换再请求", async () => {
    const { fetchMediaProviderModels } = await import("./model-list");
    handler = () => json({ data: [{ id: "wanx-v1" }] });
    await fetchMediaProviderModels({
      ...provider("p-aliyun", "aliyun", "Test Aliyun", []),
      baseUrl: `${baseUrl}/ws-{WorkspaceId}`,
      workspaceId: "ws-42",
    });
    expect(captured[0].pathname).toBe("/ws-ws-42/models");
  });

  test("供应商没有模型列表接口：报错文案告诉用户手填", async () => {
    const { fetchMediaProviderModels } = await import("./model-list");
    handler = () => json({ code: "AccessDenied" });
    await expect(
      fetchMediaProviderModels(provider("p-openai", "openai", "Test OpenAI", [])),
    ).rejects.toThrow("没有返回模型列表");
  });
});
