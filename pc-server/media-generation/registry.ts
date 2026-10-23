// media-generation/registry.ts — type → 适配器

import type { MediaGenerationProviderType } from "../foundation/types/settings";
import type { MediaProviderAdapter } from "./types";
import { MediaGenerationApiError } from "./types";
import { aliyunMediaAdapter } from "./providers/aliyun";
import { minimaxMediaAdapter } from "./providers/minimax";
import { openaiMediaAdapter } from "./providers/openai";
import { openrouterMediaAdapter } from "./providers/openrouter";
import { volcengineMediaAdapter } from "./providers/volcengine";

const ADAPTERS: Record<MediaGenerationProviderType, MediaProviderAdapter> = {
  openai: openaiMediaAdapter,
  aliyun: aliyunMediaAdapter,
  volcengine: volcengineMediaAdapter,
  minimax: minimaxMediaAdapter,
  openrouter: openrouterMediaAdapter,
};

export function getMediaAdapter(type: MediaGenerationProviderType): MediaProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new MediaGenerationApiError(`不支持的媒体供应商类型：${type}`);
  return adapter;
}
