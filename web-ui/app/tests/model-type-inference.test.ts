// model-type 推断锁：新增的 RERANK 档位必须在 EMBEDDING 之前命中，否则重排模型会被标成
// 嵌入模型——检测会打到 /embeddings 并返回「可用」，用户拿到的是假信号，真实召回才会失败。
import { describe, expect, it } from "bun:test";

import { applyAutoModelType, inferModelType } from "~/components/settings/providers/common";

describe("inferModelType", () => {
  it("重排优先于嵌入：名字里同时带 bge/m3 与 rerank 的模型判为 RERANK", () => {
    for (const id of [
      "BAAI/bge-reranker-v2-m3",
      "qwen3-rerank",
      "jina-reranker-v2-base-multi",
      "cohere-rerank-english-v3.0",
      "rerank-v3.5",
      "mixed-bge-reranker-v2-gemma",
      "ReaderLM-v2",
    ]) {
      expect(inferModelType(id)).toBe("RERANK");
    }
  });

  it("嵌入家族仍判 EMBEDDING（含 siliconflow / voyage / jina / gemini 命名）", () => {
    for (const id of [
      "text-embedding-3-small",
      "BAAI/bge-m3",
      "BAAI/bge-large-zh-v1.5",
      "Qwen/Qwen3-Embedding-8B",
      "gemini-embedding-001",
      "jina-embeddings-v3",
      "voyage-3",
      "nomic-embed-text",
      "text-embeddings-inference",
    ]) {
      expect(inferModelType(id)).toBe("EMBEDDING");
    }
  });

  it("图像与聊天不受影响，空串回落 CHAT", () => {
    expect(inferModelType("gpt-image-1")).toBe("IMAGE");
    expect(inferModelType("seedream-4-0")).toBe("IMAGE");
    expect(inferModelType("gpt-4o-mini")).toBe("CHAT");
    expect(inferModelType("deepseek-chat")).toBe("CHAT");
    expect(inferModelType("")).toBe("CHAT");
  });

  it("applyAutoModelType 只补空档位：CHAT 视作「还没判过」会被重判，其余档位一律尊重", () => {
    expect(applyAutoModelType({ modelId: "bge-m3" }).type).toBe("EMBEDDING");
    expect(applyAutoModelType({ modelId: "bge-reranker-v2-m3", type: "" }).type).toBe("RERANK");
    // CHAT 是新导入模型的出厂值，不能当成「用户显式选过」，否则整个自动识别形同不存在。
    expect(applyAutoModelType({ modelId: "bge-m3", type: "CHAT" }).type).toBe("EMBEDDING");
    // 用户手动改成非 CHAT 档位后，重新勾选不得覆写。
    expect(applyAutoModelType({ modelId: "bge-m3", type: "RERANK" }).type).toBe("RERANK");
    // 推断不出工具型档位时不硬写键：原对象保持原样，缺省 type 由读取侧按 CHAT 处理。
    expect(applyAutoModelType({ modelId: "gpt-4o-mini" }).type).toBeUndefined();
    expect(applyAutoModelType({ modelId: "gpt-4o-mini", type: "CHAT" }).type).toBe("CHAT");
  });
});
