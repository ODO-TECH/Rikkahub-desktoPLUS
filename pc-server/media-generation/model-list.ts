// media-generation/model-list.ts — 设置页「获取模型」：列供应商侧全部模型 id 并猜图片/视频类型。
// 只读列举、不落库：勾选哪些进 模型列表 由用户在设置页决定，类型猜错也能就地改。

import { supportedMediaKinds } from "../app-config/media-generation-config";
import type { JsonValue } from "../foundation/types";
import type {
  MediaGenerationModel,
  MediaGenerationProviderConfig,
} from "../foundation/types/settings";
import { isRecord } from "../foundation/utils";
import { mediaProviderBaseUrl } from "./config";
import { bearerHeaders, getMediaJson } from "./providers/http";
import { MediaGenerationApiError, type MediaKind, type MediaProviderContext } from "./types";

// 先判视频：i2v / t2v 这类命名里同时可能带 image 词根，视频线索更具体。
const VIDEO_HINTS =
  /(i2v|t2v|s2v|r2v|k2v|v2v|ti2v|it2v|video|seedance|kling|veo|sora|hailuo|cogvideo|pika|movio|wan\d+(\.\d+)?v(\b|-|_|$))/i;
const IMAGE_HINTS =
  /(image|img|t2i|i2i|text-to-image|wanx|seedream|flux|dall|diffusion|stable-diffusion|sd-|z-image|kolors|jimeng|drawing|paint|sketch|midjourney|niji|crocoi|photogen)/i;

/** 猜一个模型 id 属于图片还是视频；只在供应商支持的类型里选，猜不中回落首个支持类型。 */
export function inferMediaKind(modelId: string, kinds: MediaKind[]): MediaKind {
  const value = modelId.toLowerCase();
  if (kinds.includes("video") && VIDEO_HINTS.test(value)) return "video";
  if (kinds.includes("image") && IMAGE_HINTS.test(value)) return "image";
  return kinds[0] ?? "image";
}

function idOf(entry: JsonValue | undefined): string {
  if (typeof entry === "string") return entry.trim();
  if (!isRecord(entry)) return "";
  for (const key of ["id", "name", "model", "model_id", "modelId"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function collectIds(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(idOf).filter((item) => item !== "");
}

/** OpenAI 形如 {data:[]}，火山/阿里/MiniMax 常见 {models:[]} 或 {result:[…]}，逐个试。 */
export function parseMediaModelList(body: Record<string, JsonValue>): string[] {
  for (const key of ["data", "models", "result", "items", "list"]) {
    const ids = collectIds(body[key]);
    if (ids.length > 0) return ids;
  }
  return [];
}

/** 打 <baseUrl>/models 取全量模型 id；供应商没有列表端点时给出可操作的报错。 */
export async function fetchMediaProviderModels(
  provider: MediaGenerationProviderConfig,
): Promise<{ endpoint: string; models: MediaGenerationModel[] }> {
  const baseUrl = mediaProviderBaseUrl(provider);
  const endpoint = `${baseUrl}/models`;
  const kinds = supportedMediaKinds(provider.type);
  const ctx: MediaProviderContext = {
    config: provider,
    model: { modelId: "", kind: kinds[0] ?? "image" },
    baseUrl,
  };
  const body = await getMediaJson(
    ctx,
    endpoint,
    { kind: "provider:media:models" },
    { ...bearerHeaders(provider.apiKey.trim()), Accept: "application/json" },
  );
  const ids = parseMediaModelList(body);
  if (ids.length === 0) {
    throw new MediaGenerationApiError(
      `${provider.name} 没有返回模型列表：这家供应商可能未开放模型列表接口，请在模型列表里手动填写模型 ID。`,
    );
  }
  const seen = new Set<string>();
  const models = ids
    .filter((modelId) => (seen.has(modelId) ? false : (seen.add(modelId), true)))
    .map((modelId) => ({ modelId, kind: inferMediaKind(modelId, kinds) }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
  return { endpoint, models };
}
