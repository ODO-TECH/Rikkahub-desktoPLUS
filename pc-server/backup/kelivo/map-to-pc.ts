// backup/kelivo/map-to-pc.ts — Kelivo 备份 → RikkaHub 的纯映射层。
// 只做形状转换，不读写 state；状态合并/去重留在 backup/import.ts，
// 这样这张“外挂解码器”的字段契约可以单独测试。

import type { Assistant, JsonValue, Provider } from "../../foundation/types";
import { isRecord, uniqueStrings } from "../../foundation/utils";
import { model, provider } from "../../model-providers";

export function parseKelivoPayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function kelivoUsToMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n / 1000) : Date.now();
}

export function kelivoUsToIso(value: unknown): string {
  return new Date(kelivoUsToMs(value)).toISOString();
}

export function kelivoText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function kelivoNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Kelivo 助手 payload 中 RikkaHub 能表达的部分。刻意不映射 enableMemory /
 *  useGlobalMemory：匹配到已有助手时，记忆开关是用户的本地决定，导入不得静默改写。 */
export function mapKelivoAssistantFields(
  payload: Record<string, unknown>,
  resolveModelId: (providerKey: string, modelId: string) => string | null,
): Partial<Assistant> {
  const modelId = resolveModelId(kelivoText(payload.chatModelProvider), kelivoText(payload.chatModelId));
  const limitContext = payload.limitContextMessages === true;
  const contextSize = kelivoNumber(payload.contextMessageSize);
  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  const reasoningLevel = kelivoText(reasoning.level).trim();
  const presetMessages = Array.isArray(payload.presetMessages)
    ? payload.presetMessages.flatMap((item) => {
        if (!isRecord(item)) return [];
        const content = kelivoText(item.content);
        if (!content) return [];
        const role = kelivoText(item.role).toLowerCase() === "assistant" ? "ASSISTANT" : "USER";
        return [{ role, content }];
      })
    : [];
  const regexes = Array.isArray(payload.regexRules)
    ? payload.regexRules.flatMap((item) => {
        if (!isRecord(item)) return [];
        const pattern = kelivoText(item.pattern);
        if (!pattern) return [];
        const scopes = Array.isArray(item.scopes)
          ? item.scopes.map((scope) => kelivoText(scope).toUpperCase()).filter((scope) => scope === "USER" || scope === "ASSISTANT")
          : [];
        return [{
          id: kelivoText(item.id) || Bun.randomUUIDv7(),
          name: kelivoText(item.name),
          enabled: item.enabled !== false,
          findRegex: pattern,
          replaceString: kelivoText(item.replacement),
          affectingScope: scopes.length ? scopes : ["ASSISTANT"],
          visualOnly: item.visualOnly === true,
        }];
      })
    : [];

  return {
    name: kelivoText(payload.name).trim() || "Kelivo 助手",
    systemPrompt: kelivoText(payload.systemPrompt),
    chatModelId: modelId,
    temperature: kelivoNumber(payload.temperature),
    topP: kelivoNumber(payload.topP),
    maxTokens: kelivoNumber(payload.maxTokens),
    contextMessageLimit: limitContext && contextSize != null && contextSize > 0 ? Math.floor(contextSize) : 0,
    streamOutput: payload.streamOutput !== false,
    messageTemplate: kelivoText(payload.messageTemplate) || "{{ message }}",
    presetMessages: presetMessages as JsonValue[],
    regexes: regexes as JsonValue[],
    reasoningLevel: reasoningLevel ? reasoningLevel.toUpperCase() : "AUTO",
    enableRecentChatsReference: payload.allowPastConversationRecall === true,
    allowConversationSystemPrompt: payload.allowConversationSystemPrompt !== false,
    allowConversationPromptInjection: payload.allowConversationPromptInjection === true,
  };
}

const KELIVO_PROVIDER_TYPES = new Set(["openai", "google", "claude"]);

/** Kelivo ProviderConfig → RikkaHub Provider。existing 用于幂等合并：
 *  同 id/名字时保留 RikkaHub 模型 UUID，按 modelId 复用，避免每次同步生成新模型。 */
export function mapKelivoProvider(
  payload: Record<string, unknown>,
  providerKey: string,
  existing?: Provider,
): { provider: Provider; modelIdByKelivoModel: Map<string, string> } {
  const type = kelivoText(payload.providerType);
  const baseUrl = kelivoText(payload.baseUrl) || existing?.baseUrl || "";
  const modelIds = Array.isArray(payload.models)
    ? payload.models.map((item) => kelivoText(item)).filter(Boolean)
    : [];
  const overrides = isRecord(payload.modelOverrides) ? payload.modelOverrides : {};
  const existingModels = new Map((existing?.models ?? []).map((item) => [item.modelId, item]));
  const models = modelIds.map((modelId) => {
    const prior = existingModels.get(modelId);
    if (prior) return prior;
    const override = isRecord(overrides[modelId]) ? overrides[modelId] : {};
    const typeName = kelivoText(override.type).toLowerCase();
    const modalities = (key: "input" | "output") => Array.isArray(override[key])
      ? uniqueStrings(override[key].map((item) => kelivoText(item).toUpperCase()))
      : undefined;
    const abilities = Array.isArray(override.abilities)
      ? uniqueStrings(override.abilities.map((item) => {
          const value = kelivoText(item);
          if (value === "structuredOutput") return "STRUCTURED_OUTPUT";
          return value.toUpperCase();
        }))
      : [];
    const created = model(modelId, kelivoText(override.name) || modelId);
    return {
      ...created,
      type: typeName === "embedding" ? "EMBEDDING" as const : typeName === "image" ? "IMAGE" as const : "CHAT" as const,
      inputModalities: modalities("input")?.length ? modalities("input")! : created.inputModalities,
      outputModalities: modalities("output")?.length ? modalities("output")! : created.outputModalities,
      abilities: abilities.length ? abilities : created.abilities,
    };
  });
  const headers = Array.isArray(payload.customHeaders)
    ? payload.customHeaders.filter(isRecord).map((entry) => ({
        name: kelivoText(entry.name),
        value: kelivoText(entry.value),
      })).filter((entry) => entry.name)
    : undefined;
  const mapped = provider({
    ...existing,
    id: existing?.id ?? `kelivo:${providerKey || kelivoText(payload.id) || Bun.randomUUIDv7()}`,
    name: kelivoText(payload.name).trim() || existing?.name || providerKey || "Kelivo 供应商",
    type: KELIVO_PROVIDER_TYPES.has(type) ? type as Provider["type"] : existing?.type ?? "openai",
    enabled: payload.enabled !== false,
    builtIn: existing?.builtIn ?? false,
    apiKey: kelivoText(payload.apiKey) || existing?.apiKey || "",
    baseUrl,
    chatCompletionsPath: kelivoText(payload.chatPath) || existing?.chatCompletionsPath || "/chat/completions",
    useResponseApi: payload.useResponseApi === true,
    models,
    customHeaders: headers ?? existing?.customHeaders ?? [],
    shortDescription: existing?.shortDescription ?? "",
    description: existing?.description ?? "",
  });
  const modelIdByKelivoModel = new Map(mapped.models.map((item) => [item.modelId, item.id]));
  return { provider: mapped, modelIdByKelivoModel };
}

const WORLD_BOOK_POSITIONS = new Set([
  "before_system_prompt",
  "after_system_prompt",
  "top_of_chat",
  "bottom_of_chat",
  "at_depth",
]);

export function mapKelivoWorldBook(payload: Record<string, unknown>): Record<string, JsonValue> {
  const entries = Array.isArray(payload.entries)
    ? payload.entries.flatMap((raw) => {
        if (!isRecord(raw)) return [];
        const position = kelivoText(raw.position).toLowerCase();
        const role = kelivoText(raw.role).toLowerCase() === "assistant" ? "assistant" : "user";
        return [{
          id: kelivoText(raw.id) || Bun.randomUUIDv7(),
          name: kelivoText(raw.name),
          enabled: raw.enabled !== false,
          priority: kelivoNumber(raw.priority) ?? 0,
          position: WORLD_BOOK_POSITIONS.has(position) ? position : "after_system_prompt",
          role,
          injectDepth: kelivoNumber(raw.injectDepth) ?? 4,
          content: kelivoText(raw.content),
          keywords: Array.isArray(raw.keywords) ? raw.keywords.map(kelivoText).filter(Boolean) : [],
          useRegex: raw.useRegex === true,
          caseSensitive: raw.caseSensitive === true,
          scanDepth: kelivoNumber(raw.scanDepth) ?? 4,
          constantActive: raw.constantActive === true,
        }];
      })
    : [];
  return {
    id: kelivoText(payload.id) || Bun.randomUUIDv7(),
    name: kelivoText(payload.name).trim() || "Kelivo 世界书",
    description: kelivoText(payload.description),
    enabled: payload.enabled !== false,
    entries,
  } as unknown as Record<string, JsonValue>;
}

export function mapKelivoInjection(payload: Record<string, unknown>): Record<string, JsonValue> {
  const title = kelivoText(payload.title).trim();
  const prompt = kelivoText(payload.prompt);
  return {
    type: "mode",
    id: kelivoText(payload.id) || Bun.randomUUIDv7(),
    name: title || prompt.split("\n")[0]?.slice(0, 40) || "Kelivo 提示词",
    enabled: true,
    priority: 0,
    position: "after_system_prompt",
    content: prompt,
    injectDepth: 4,
    role: "user",
  };
}

export function mapKelivoQuickPhrase(payload: Record<string, unknown>): Record<string, JsonValue> | null {
  const content = kelivoText(payload.content);
  if (!content) return null;
  return {
    id: kelivoText(payload.id) || Bun.randomUUIDv7(),
    title: kelivoText(payload.title).trim() || content.slice(0, 30),
    content,
  };
}

/** RikkaHub 真正实现的搜索服务类型。Kelivo 多出来的 kelivo/duckduckgo/parallel… 只能跳过。 */
export const PC_SEARCH_SERVICE_TYPES = new Set([
  "bing_local", "zhipu", "tavily", "exa", "searxng", "linkup", "brave", "metaso", "ollama",
  "perplexity", "firecrawl", "jina", "bocha", "rikkahub", "grok", "tinyfish", "serper", "custom_js",
  "doubao",
]);

export function mapKelivoSearchService(payload: Record<string, unknown>): Record<string, JsonValue> | null {
  const type = kelivoText(payload.type).toLowerCase();
  if (!PC_SEARCH_SERVICE_TYPES.has(type) || type === "custom_js") return null;
  const mapped: Record<string, JsonValue> = {
    ...(payload as Record<string, JsonValue>),
    id: kelivoText(payload.id) || Bun.randomUUIDv7(),
    type,
  };
  if (type === "tavily") {
    const depth = kelivoText(payload.depth).toLowerCase();
    mapped.depth = depth === "basic" ? "basic" : "advanced";
  }
  if (type === "linkup") {
    const depth = kelivoText(payload.depth).toLowerCase();
    mapped.depth = depth === "deep" ? "deep" : "standard";
  }
  if (type === "exa" || type === "tavily" || type === "jina" || type === "grok") {
    if (!mapped.url) mapped.url = "";
  }
  return mapped;
}