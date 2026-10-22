// api/default-models-toggles.test.ts — settings/default-models 的字段合并锁。
// 覆盖两族语义:① 快速模型子功能开关(非布尔值与缺省键不得覆盖现值,老前端/其他调用方
// 不回传布尔时现值保持);② 全局嵌入 / 重排场景档(缺省键保持、显式空串清空、写入侧不校验)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-default-models-test-"));

import { defaultSettings } from "../app-config/defaults";
import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postDefaultModels(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/default-models");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/default-models");
}

beforeAll(() => {
  setState({
    settings: {
      ...defaultSettings(),
      enableSuggestion: true,
      titleGenerationEnabled: true,
    },
  } as unknown as State);
});

describe("settings/default-models 子功能开关持久化", () => {
  test("布尔值落库:两开关可关", async () => {
    const res = await postDefaultModels({ enableSuggestion: false, titleGenerationEnabled: false });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(false);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("缺省键不动现值:只回传一个开关时另一个保持", async () => {
    const res = await postDefaultModels({ enableSuggestion: true });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("非布尔值被拒绝消化(不覆盖现值)", async () => {
    const res = await postDefaultModels({ enableSuggestion: "yes", titleGenerationEnabled: 1 });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });
});

// 全局「嵌入 / 重排」场景档:特性 C 的向量索引与召回只读这两档,端点漏合并 = 面板选了也不落库。
// 与 OCR/生图同口径(写入侧不校验 id 是否存在),但必须能显式清空回「未设置」。
describe("settings/default-models 嵌入 / 重排场景档持久化", () => {
  test("默认未配置(空串)", () => {
    expect(state.settings.embeddingModelId).toBe("");
    expect(state.settings.rerankModelId).toBe("");
  });

  test("两档可同时落库", async () => {
    const res = await postDefaultModels({
      embeddingModelId: "emb-uuid-1",
      rerankModelId: "rerank-uuid-1",
    });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("emb-uuid-1");
    expect(state.settings.rerankModelId).toBe("rerank-uuid-1");
  });

  test("缺省键不动现值:只回传嵌入时重排保持", async () => {
    const res = await postDefaultModels({ embeddingModelId: "emb-uuid-2" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("emb-uuid-2");
    expect(state.settings.rerankModelId).toBe("rerank-uuid-1");
  });

  test("显式空串可清除回未设置", async () => {
    const res = await postDefaultModels({ embeddingModelId: "", rerankModelId: "" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("");
    expect(state.settings.rerankModelId).toBe("");
  });

  test("写入侧不校验模型是否存在(失效 id 交给读取方兜底)", async () => {
    const res = await postDefaultModels({ embeddingModelId: "已被删除的模型 id" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("已被删除的模型 id");
  });
});
