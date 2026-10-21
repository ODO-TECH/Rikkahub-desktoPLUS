// backup/kelivo/encode.ts — RikkaHub → Kelivo 兼容备份（schema v3）。
//
// 产出与 Kelivo 自己的归档同构：
//   manifest.json
//   settings.json
//   database/kelivo.db
// Kelivo 恢复端会校验 manifest 哈希、DB user_version=3、表/列顺序与行数，
// 所以这里复刻的是对方契约，不是“能读就行”的近似格式。
//
// 附件（图片/视频/音频/文档）不进入 Kelivo 备份：RikkaHub 的 /api/files 引用
// 与 Kelivo 的资产目录不是同一套。文本/思考/工具调用完整保留，纯附件消息降级为
// 一行占位文本，并在返回值里报告数量。

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Assistant, Conversation, JsonValue, Message, MessagePart, Provider } from "../../foundation/types";
import type { Settings } from "../../foundation/types/settings";
import type { BackupScope } from "../../foundation/types/settings/storage-config";
import { isRecord } from "../../foundation/utils";
import { tempDir } from "../../foundation/platform";
import { state } from "../../persistence/json-store";
import { FULL_BACKUP_SCOPE, applyBackupScopeToSettings } from "../export";
import { GLOBAL_MEMORY_ID, memoryStore } from "../../memory/index";
import { flushConvDirtyNow, getConversationsDb, loadConversationNodesFromDb } from "../../conversations";
import { listAllConversationMetas } from "../../conversations/read-queries";
import { defaultAssistant } from "../../assistants/index";
import { createZipFromDirectory } from "../zip";
import { KELIVO_SCHEMA_SQL, KELIVO_SCHEMA_VERSION } from "./schema";
// 版本号单一真源：写进 manifest 的 appVersion 过去是硬编码字面量，改版本号时
// bump-version 覆盖不到它，导出的包会长期自报一个旧版本。
import { APP_VERSION } from "../../updates/index";

const KELIVO_BACKUP_FORMAT_VERSION = 3;
const KELIVO_MINIMUM_READABLE_FORMAT = 3;
const KELIVO_MINIMUM_READABLE_SCHEMA = 3;

export interface KelivoExportResult {
  size: number;
  conversationCount: number;
  messageCount: number;
  skippedAttachmentParts: number;
}

interface ModelRef {
  providerKey: string;
  modelId: string;
}

function usFromIso(value: string | null | undefined, fallback = Date.now()): number {
  if (!value) return fallback * 1000;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms * 1000 : fallback * 1000;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function hashFile(path: string): { bytes: number; sha256: string } {
  // 流式哈希：Kelivo 归档可能随会话增长到数百 MB，不能整文件进 JS 堆。
  const bytes = statSync(path).size;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let position = 0;
    while (position < bytes) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function chooseKelivoProviderKey(provider: Provider): string {
  return provider.id;
}

function mapModelRefs(settings: Settings): Map<string, ModelRef> {
  const refs = new Map<string, ModelRef>();
  for (const provider of settings.providers ?? []) {
    const providerKey = chooseKelivoProviderKey(provider);
    for (const modelItem of provider.models ?? []) {
      if (!refs.has(modelItem.id)) refs.set(modelItem.id, { providerKey, modelId: modelItem.modelId });
    }
  }
  return refs;
}

function modelRefString(ref: ModelRef | null | undefined): string | null {
  return ref ? `${ref.providerKey}::${ref.modelId}` : null;
}

const REASONING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function kelivoAssistantPayload(
  assistant: Assistant,
  refs: Map<string, ModelRef>,
): Record<string, unknown> {
  const ref = assistant.chatModelId ? refs.get(assistant.chatModelId) ?? null : null;
  const reasoning = String(assistant.reasoningLevel ?? "auto").toLowerCase();
  const presetMessages = Array.isArray(assistant.presetMessages)
    ? assistant.presetMessages.flatMap((item) => {
        if (!isRecord(item)) return [];
        const content = String(item.content ?? "");
        if (!content) return [];
        return [{
          id: String(item.id ?? Bun.randomUUIDv7()),
          role: String(item.role ?? "USER").toLowerCase() === "assistant" ? "assistant" : "user",
          content,
        }];
      })
    : [];
  const regexRules = Array.isArray(assistant.regexes)
    ? assistant.regexes.flatMap((item) => {
        if (!isRecord(item)) return [];
        const pattern = String(item.findRegex ?? item.pattern ?? "");
        if (!pattern) return [];
        return [{
          id: String(item.id ?? Bun.randomUUIDv7()),
          name: String(item.name ?? ""),
          pattern,
          replacement: String(item.replaceString ?? item.replacement ?? ""),
          scopes: Array.isArray(item.affectingScope)
            ? item.affectingScope.map((scope) => String(scope).toLowerCase()).filter((scope) => scope === "user" || scope === "assistant")
            : [],
          visualOnly: item.visualOnly === true,
          replaceOnly: false,
          enabled: item.enabled !== false,
        }];
      })
    : [];
  const customHeaders = Array.isArray(assistant.customHeaders) ? assistant.customHeaders : [];
  const customBody = Array.isArray(assistant.customBodies) ? assistant.customBodies : [];
  return {
    id: assistant.id,
    // Kelivo 的助手名允许空串，但空名字在双向同步里无法匹配，会每次多造一个空助手。
    // 导出时给一个稳定兜底名，保证反复同步仍按名字命中。
    name: assistant.name.trim() || "RikkaHub 助手",
    avatar: null,
    useAssistantAvatar: false,
    useAssistantName: true,
    chatModelProvider: ref?.providerKey ?? null,
    chatModelId: ref?.modelId ?? null,
    temperature: assistant.temperature,
    topP: assistant.topP,
    contextMessageSize: assistant.contextMessageLimit > 0 ? assistant.contextMessageLimit : 64,
    limitContextMessages: assistant.contextMessageLimit > 0,
    streamOutput: assistant.streamOutput !== false,
    reasoning: { level: REASONING_LEVELS.has(reasoning) ? reasoning : "auto", budgetTokens: null },
    maxTokens: assistant.maxTokens,
    systemPrompt: assistant.systemPrompt ?? "",
    allowConversationSystemPrompt: assistant.allowConversationSystemPrompt !== false,
    allowConversationPromptInjection: assistant.allowConversationPromptInjection === true,
    messageTemplate: assistant.messageTemplate || "{{ message }}",
    searchEnabled: false,
    mcpServerIds: [],
    localToolIds: [],
    defaultWorkspaceId: null,
    defaultWorkspaceSetup: "suggest",
    skillIds: null,
    healthDataTypeIds: [],
    background: null,
    useGradientBackground: false,
    gradientBackgroundAnimated: true,
    gradientBackgroundPhase: 7.0,
    gradientBackgroundOffsetX: 0,
    gradientBackgroundOffsetY: 0,
    customHeaders,
    customBody,
    enableMemory: assistant.enableMemory === true,
    autoOrganizeMemory: false,
    memoryOrganizeEveryNTurns: 1,
    memorySmartAddMode: "batched",
    memoryWriteScope: "alwaysAssistant",
    allowPastConversationRecall: assistant.enableRecentChatsReference === true,
    generateConversationSummary: false,
    recentChatsSummaryMessageCount: 5,
    appendCurrentTimeToUserMessage: false,
    useIso8601TimeFormat: true,
    presetMessages,
    regexRules,
  };
}

function kelivoProviderPayload(provider: Provider): Record<string, unknown> {
  const models = (provider.models ?? []).map((modelItem) => modelItem.modelId);
  const modelOverrides: Record<string, unknown> = {};
  for (const modelItem of provider.models ?? []) {
    const abilities = (modelItem.abilities ?? []).map((ability) => {
      const value = String(ability);
      if (value === "STRUCTURED_OUTPUT") return "structuredOutput";
      const lower = value.toLowerCase();
      return lower === "tool" || lower === "reasoning" || lower === "structuredoutput" ? lower : "";
    }).filter(Boolean);
    modelOverrides[modelItem.modelId] = {
      apiModelId: modelItem.modelId,
      name: modelItem.displayName || modelItem.modelId,
      type: String(modelItem.type ?? "CHAT").toLowerCase(),
      input: (modelItem.inputModalities ?? []).map((item) => String(item).toLowerCase()),
      output: (modelItem.outputModalities ?? []).map((item) => String(item).toLowerCase()),
      abilities,
      headers: [],
      body: [],
    };
  }
  return {
    id: provider.id,
    enabled: provider.enabled !== false,
    name: provider.name,
    apiKey: provider.apiKey ?? "",
    baseUrl: provider.baseUrl ?? "",
    providerType: provider.type,
    chatPath: provider.chatCompletionsPath,
    useResponseApi: provider.useResponseApi === true,
    promptCacheKeyEnabled: provider.promptCacheKey === true,
    models,
    modelOverrides,
    customHeaders: Array.isArray(provider.customHeaders) ? provider.customHeaders : [],
    customBody: [],
    proxyEnabled: false,
    multiKeyEnabled: false,
  };
}

function kelivoWorldBookPayload(bookValue: JsonValue): Record<string, unknown> | null {
  if (!isRecord(bookValue)) return null;
  const entries = Array.isArray(bookValue.entries)
    ? bookValue.entries.flatMap((entryValue) => {
        if (!isRecord(entryValue)) return [];
        return [{
          id: String(entryValue.id ?? Bun.randomUUIDv7()),
          name: String(entryValue.name ?? ""),
          enabled: entryValue.enabled !== false,
          priority: Number(entryValue.priority ?? 0),
          position: String(entryValue.position ?? "after_system_prompt").toUpperCase(),
          content: String(entryValue.content ?? ""),
          injectDepth: Number(entryValue.injectDepth ?? 4),
          role: String(entryValue.role ?? "user").toUpperCase() === "ASSISTANT" ? "ASSISTANT" : "USER",
          keywords: Array.isArray(entryValue.keywords) ? entryValue.keywords.map(String) : [],
          useRegex: entryValue.useRegex === true,
          caseSensitive: entryValue.caseSensitive === true,
          scanDepth: Number(entryValue.scanDepth ?? 4),
          constantActive: entryValue.constantActive === true,
          sticky: 0,
          cooldown: 0,
          delay: 0,
        }];
      })
    : [];
  return {
    id: String(bookValue.id ?? Bun.randomUUIDv7()),
    name: String(bookValue.name ?? ""),
    description: String(bookValue.description ?? ""),
    enabled: bookValue.enabled !== false,
    entries,
  };
}

function kelivoInjectionPayload(value: JsonValue): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const content = String(value.content ?? "");
  if (!content.trim()) return null;
  return {
    id: String(value.id ?? Bun.randomUUIDv7()),
    title: String(value.name ?? ""),
    prompt: content,
    group: "",
  };
}

function kelivoSearchPayload(value: JsonValue): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const type = String(value.type ?? "").toLowerCase();
  // Kelivo 没有 RikkaHub 的本地服务端搜索与 custom_js；其余同名类型字段基本同构。
  if (!type || type === "custom_js" || type === "rikkahub") return null;
  const payload: Record<string, unknown> = { ...value, type, id: String(value.id ?? Bun.randomUUIDv7()) };
  delete payload.testPassed;
  delete payload.testPassedAt;
  delete payload.name;
  return payload;
}

function memoryNormalized(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function selectedMessage(nodeMessages: Message[], selectIndex: number): Message | null {
  if (!Array.isArray(nodeMessages) || nodeMessages.length === 0) return null;
  const index = Math.max(0, Math.min(Number(selectIndex) || 0, nodeMessages.length - 1));
  return nodeMessages[index] ?? null;
}

function toolContent(part: Extract<MessagePart, { type: "tool" }>): string {
  const texts = (part.output ?? []).flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type === "text") return [String(record.text ?? "")];
    if (type === "reasoning") return [String(record.reasoning ?? "")];
    if ("error" in record) return [String(record.error ?? "")];
    return [];
  }).filter(Boolean);
  return texts.join("\n");
}

/** 生成 Kelivo schema v3 数据库并返回会话/消息计数。 */
/** 把一份（已按同步选项裁剪过的）设置写进 Kelivo 库。settings 必须是调用方算好的
 *  scoped 副本——此函数不读全局，避免开关只作用于 zip 外层而库里仍是全量。 */
function buildKelivoDatabase(
  dbPath: string,
  refs: Map<string, ModelRef>,
  settings: Settings,
  include: { conversations: boolean; memories: boolean; searchServices: boolean },
): {
  conversationCount: number;
  messageCount: number;
  skippedAttachmentParts: number;
} {
  const db = new Database(dbPath);
  let skippedAttachmentParts = 0;
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(KELIVO_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${KELIVO_SCHEMA_VERSION};`);

    const assistants = [...(settings.assistants ?? [])];
    const assistantIds = new Set(assistants.map((assistant) => assistant.id));
    if (include.conversations && assistantIds.size === 0) {
      // 同步选项关掉「助手」但保留对话时，Kelivo 会话仍必须挂在助手上——保底造一个，
      // 只为承载对话；关掉对话时不再凭空多出一个助手。
      const fallback = { ...defaultAssistant(), id: Bun.randomUUIDv7(), name: "RikkaHub" };
      assistants.push(fallback);
      assistantIds.add(fallback.id);
    }
    const fallbackAssistantId = assistants[0]?.id ?? null;

    const insertAssistant = db.prepare(
      "INSERT INTO assistant_rows (id, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertProvider = db.prepare(
      "INSERT INTO provider_rows (provider_key, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertPreference = db.prepare(
      "INSERT OR REPLACE INTO preference_rows (key, value, updated_at) VALUES (?, ?, ?)",
    );
    const insertWorldBook = db.prepare(
      "INSERT INTO world_book_rows (id, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertInjection = db.prepare(
      "INSERT INTO instruction_injection_rows (id, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertQuickPhrase = db.prepare(
      "INSERT INTO quick_phrase_rows (id, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertSearch = db.prepare(
      "INSERT INTO search_service_rows (id, sort_order, payload, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertMemory = db.prepare(
      `INSERT INTO memory_entry_rows
       (id, sort_order, scope, assistant_id, type, status, content, content_normalized,
        entry_created_at, entry_updated_at, payload, updated_at)
       VALUES (?, ?, ?, ?, 'workflow', 'active', ?, ?, ?, ?, ?, ?)`,
    );
    const insertConversation = db.prepare(
      `INSERT INTO conversation_rows
       (id, title, created_at, updated_at, is_pinned, assistant_id, truncate_index,
        version_selections_json, summary, last_summarized_message_count, chat_suggestions_json,
        injected_memory_hash, last_memory_extracted_order, chat_model_provider, chat_model_id, extras_json)
       VALUES (?, ?, ?, ?, ?, ?, -1, '{}', NULL, 0, ?, NULL, -1, NULL, NULL, '{}')`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO message_rows
       (id, conversation_id, role, timestamp, model_id, provider_id, total_tokens, is_streaming,
        reasoning_start_at, reasoning_finished_at, translation, reasoning_segments_json, group_id,
        version, prompt_tokens, completion_tokens, cached_tokens, duration_ms, message_order,
        updated_at, sender_id, extras_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, NULL, NULL, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, NULL, '{}')`,
    );
    const insertPart = db.prepare(
      `INSERT INTO message_part_rows
       (conversation_id, revision_id, ordinal, kind, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const nowUs = Date.now() * 1000;
    // 导出前先算出“实际写进 Kelivo 的搜索服务”，选中下标要跟着过滤后的数组走；
    // 否则用户在 RikkaHub 选中的是 custom_js/rikkahub，Kelivo 侧会落到别的服务。
    const searchExport = (settings.searchServices ?? []).flatMap((service, index) => {
      const payload = kelivoSearchPayload(service);
      return payload ? [{ sourceIndex: index, payload }] : [];
    });
    const exportedSearchSelected = Math.max(0, searchExport.findIndex((entry) => entry.sourceIndex === (settings.searchServiceSelected ?? 0)));
    let conversationCount = 0;
    let messageCount = 0;
    db.transaction(() => {
      // 助手
      assistants.forEach((assistant, index) => {
        insertAssistant.run(assistant.id, index, safeJson(kelivoAssistantPayload(assistant, refs)), nowUs);
      });

      // 供应商
      const providers = settings.providers ?? [];
      providers.forEach((provider, index) => {
        insertProvider.run(provider.id, index, safeJson(kelivoProviderPayload(provider)), nowUs);
      });
      const providerOrder = providers.map((provider) => provider.id);
      const selectedRef = settings.chatModelId ? refs.get(settings.chatModelId) ?? null : null;
      const fastRef = settings.fastModelId ? refs.get(settings.fastModelId) ?? null : null;
      const translateRef = settings.translateModeId ? refs.get(settings.translateModeId) ?? null : null;
      const ocrRef = settings.ocrModelId ? refs.get(settings.ocrModelId) ?? null : null;
      const compressRef = settings.compressModelId ? refs.get(settings.compressModelId) ?? null : null;
      const favoriteRefs = (settings.favoriteModels ?? [])
        .map((modelId) => refs.get(modelId))
        .filter((ref): ref is ModelRef => Boolean(ref));

      // 世界书
      (settings.lorebooks ?? []).forEach((book, index) => {
        const payload = kelivoWorldBookPayload(book);
        if (payload) insertWorldBook.run(String(payload.id), index, safeJson(payload), nowUs);
      });

      // 提示词注入
      (settings.modeInjections ?? []).forEach((injection, index) => {
        const payload = kelivoInjectionPayload(injection);
        if (payload) insertInjection.run(String(payload.id), index, safeJson(payload), nowUs);
      });

      // 快捷消息（RikkaHub 没有全局/助手级判别，统一导出为全局；内容不丢）
      (settings.quickMessages ?? []).forEach((item, index) => {
        if (!isRecord(item)) return;
        const content = String(item.content ?? "");
        if (!content) return;
        const payload = {
          id: String(item.id ?? Bun.randomUUIDv7()),
          title: String(item.title ?? content.slice(0, 30)),
          content,
          isGlobal: true,
          assistantId: null,
        };
        insertQuickPhrase.run(payload.id, index, safeJson(payload), nowUs);
      });

      // 搜索引擎
      searchExport.forEach((entry, index) => {
        insertSearch.run(String(entry.payload.id), index, safeJson(entry.payload), nowUs);
      });

      // 记忆（同步选项未勾选时整组不写）
      const memories = include.memories ? memoryStore.exportFlat() : [];
      memories.forEach((memory, index) => {
        const assistantId = memory.assistantId === GLOBAL_MEMORY_ID || !assistantIds.has(memory.assistantId)
          ? null
          : memory.assistantId;
        const scope = assistantId ? "assistant" : "global";
        const id = `mem_${memory.id}`;
        const createdAt = memory.createdAt * 1000;
        const updatedAt = Math.max(createdAt, memory.updatedAt * 1000);
        const payload = {
          id,
          scope,
          assistantId,
          type: "workflow",
          status: "active",
          content: memory.content,
          source: "manual",
          relatedIds: [],
          createdAt,
          updatedAt,
        };
        insertMemory.run(
          id, index, scope, assistantId, memory.content, memoryNormalized(memory.content),
          createdAt, updatedAt, safeJson(payload), updatedAt,
        );
      });

      // 会话与消息（未勾选「对话」时整个导出为空包，只留配置）
      if (include.conversations) flushConvDirtyNow();
      const liveDb = include.conversations ? getConversationsDb() : null;
      const metas = liveDb ? listAllConversationMetas(liveDb) : [];
      const seenMessageIds = new Set<string>();
      for (const meta of metas) {
        const nodes = liveDb ? loadConversationNodesFromDb(liveDb, meta.id) : [];
        const conversation: Conversation = { ...meta, messages: nodes };
        const assistantId = assistantIds.has(conversation.assistantId) ? conversation.assistantId : fallbackAssistantId;
        const createdUs = conversation.createAt * 1000;
        const updatedUs = Math.max(createdUs, conversation.updateAt * 1000);
        insertConversation.run(
          conversation.id,
          conversation.title || "未命名对话",
          createdUs,
          updatedUs,
          conversation.isPinned ? 1 : 0,
          assistantId,
          safeJson(conversation.chatSuggestions ?? []),
        );
        conversationCount += 1;

        let messageOrder = 0;
        for (const node of nodes) {
          const message = selectedMessage(node.messages, node.selectIndex);
          if (!message) continue;
          let messageId = message.id;
          if (!messageId || seenMessageIds.has(messageId)) messageId = Bun.randomUUIDv7();
          seenMessageIds.add(messageId);
          const usage = isRecord(message.usage) ? message.usage : {};
          const numberOrNull = (value: unknown): number | null => {
            const n = Number(value);
            return Number.isFinite(n) && n >= 0 ? n : null;
          };
          const createdUs2 = usFromIso(message.createdAt);
          const finishedUs = message.finishedAt ? usFromIso(message.finishedAt, createdUs2 / 1000) : createdUs2;
          insertMessage.run(
            messageId,
            conversation.id,
            String(message.role ?? "USER").toLowerCase(),
            createdUs2,
            message.modelId ?? null,
            numberOrNull(usage.totalTokens),
            message.translation ?? null,
            numberOrNull(usage.promptTokens),
            numberOrNull(usage.completionTokens),
            numberOrNull(usage.cachedTokens),
            numberOrNull(usage.durationMs),
            messageOrder,
            finishedUs,
          );
          messageOrder += 1;
          messageCount += 1;

          let ordinal = 0;
          for (const part of message.parts ?? []) {
            let kind = "";
            let payload = "";
            let partCreatedUs = createdUs2;
            let partUpdatedUs = finishedUs;
            if (part.type === "text") {
              kind = "text";
              payload = part.text;
            } else if (part.type === "reasoning") {
              kind = "reasoning";
              payload = part.reasoning;
              partCreatedUs = usFromIso(part.createdAt, createdUs2 / 1000);
              partUpdatedUs = part.finishedAt ? usFromIso(part.finishedAt, partCreatedUs / 1000) : finishedUs;
            } else if (part.type === "tool") {
              kind = "tool_call";
              payload = safeJson({
                id: part.toolCallId,
                name: part.toolName,
                arguments: part.input,
                content: toolContent(part),
              });
            } else {
              skippedAttachmentParts += 1;
              continue;
            }
            insertPart.run(
              conversation.id,
              messageId,
              ordinal,
              kind,
              payload,
              partCreatedUs,
              Math.max(partCreatedUs, partUpdatedUs),
            );
            ordinal += 1;
          }
          if (ordinal === 0) {
            // 纯附件消息：给 Kelivo 一个可见占位，避免出现“空消息”。
            insertPart.run(conversation.id, messageId, 0, "text", "[附件未包含在 Kelivo 备份中]", createdUs2, finishedUs);
          }
        }
      }

      // 偏好（同时写 settings.json；DB 里也保留一份，Kelivo 恢复后无需二次写）
      const preferences: Record<string, unknown> = {
        providers_order_v1: providerOrder,
        current_assistant_id_v1: assistantIds.has(settings.assistantId) ? settings.assistantId : fallbackAssistantId,
        selected_model_v1: modelRefString(selectedRef),
        title_model_v1: modelRefString(fastRef),
        suggestion_model_v1: modelRefString(fastRef),
        summary_model_v1: modelRefString(fastRef),
        translate_model_v1: modelRefString(translateRef),
        ocr_model_v1: modelRefString(ocrRef),
        compress_model_v1: modelRefString(compressRef),
        pinned_models_v1: favoriteRefs.map((ref) => `${ref.providerKey}::${ref.modelId}`),
        per_chat_model_enabled_v1: false,
        provider_group_map_v1: "{}",
        provider_group_collapsed_v1: "{}",
        provider_ungrouped_position_v1: 0,
        reasoning_choice_by_model_v1: "{}",
        search_enabled_v1: include.searchServices && settings.enableWebSearch === true,
        search_selected_v1: exportedSearchSelected,
        search_common_v1: safeJson({ resultSize: settings.searchCommonOptions?.resultSize ?? 10 }),
        instruction_injections_active_ids_by_assistant_v1: "{}",
        world_books_active_ids_by_assistant_v1: "{}",
      };
      const injectionBindings: Record<string, string[]> = {};
      const lorebookBindings: Record<string, string[]> = {};
      for (const assistant of assistants) {
        const injectionIds = assistant.modeInjectionIds ?? [];
        if (injectionIds.length) injectionBindings[assistant.id] = injectionIds;
        const lorebookIds = assistant.lorebookIds ?? [];
        if (lorebookIds.length) lorebookBindings[assistant.id] = lorebookIds;
      }
      preferences.instruction_injections_active_ids_by_assistant_v1 = safeJson(injectionBindings);
      preferences.world_books_active_ids_by_assistant_v1 = safeJson(lorebookBindings);
      for (const [key, value] of Object.entries(preferences)) {
        if (value == null || value === "") continue;
        insertPreference.run(key, safeJson(value), nowUs);
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_storage_meta_rows (key, value) VALUES (?, ?)",
      ).run("hive_import_complete", "true");
    })();

    return { conversationCount, messageCount, skippedAttachmentParts };
  } finally {
    // close(true) 才会让 Windows 释放独占句柄；否则 PowerShell 打包时
    // 报 “kelivo.db is being used by another process”。
    db.close(true);
  }
}

/** 生成 Kelivo 兼容备份 zip。 */
export function createKelivoBackupZipToPath(targetZipPath: string): KelivoExportResult {
  const stageDir = join(tempDir(), `rikkahub-kelivo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const dbDir = join(stageDir, "database");
  mkdirSync(dbDir, { recursive: true });
  try {
    // 统一「同步选项」：Kelivo 包与桌面端备份包共用一份 backupScope。先算裁剪后的
    // 设置副本，外层 settings.json 与内层 kelivo.db 都只写这份，避免两层数据不一致。
    const scope: BackupScope = state.settings.backupScope ?? FULL_BACKUP_SCOPE;
    const settings = applyBackupScopeToSettings(state.settings, scope);
    const dbPath = join(dbDir, "kelivo.db");
    const refs = mapModelRefs(settings);
    const counts = buildKelivoDatabase(dbPath, refs, settings, {
      conversations: scope.conversations,
      memories: scope.memories,
      searchServices: scope.searchServices,
    });

    // settings.json —— Kelivo 的实体类别是 JSON 字符串，偏好是原生 JSON 值。
    const assistants = (settings.assistants ?? []).map((assistant) => kelivoAssistantPayload(assistant, refs));
    const providers = Object.fromEntries(
      (settings.providers ?? []).map((provider) => [chooseKelivoProviderKey(provider), kelivoProviderPayload(provider)]),
    );
    const worldBooks = (settings.lorebooks ?? []).map(kelivoWorldBookPayload).filter(Boolean);
    const injections = (settings.modeInjections ?? []).map(kelivoInjectionPayload).filter(Boolean);
    const quickPhrases = (settings.quickMessages ?? []).flatMap((item) => {
      if (!isRecord(item)) return [];
      const content = String(item.content ?? "");
      if (!content) return [];
      return [{
        id: String(item.id ?? Bun.randomUUIDv7()),
        title: String(item.title ?? content.slice(0, 30)),
        content,
        isGlobal: true,
        assistantId: null,
      }];
    });
    const searchExport = (settings.searchServices ?? []).flatMap((service, index) => {
      const payload = kelivoSearchPayload(service);
      return payload ? [{ sourceIndex: index, payload }] : [];
    });
    const searchServices = searchExport.map((entry) => entry.payload);
    const exportedSearchSelected = Math.max(0, searchExport.findIndex((entry) => entry.sourceIndex === (settings.searchServiceSelected ?? 0)));
    const memories = memoryStore.exportFlat().map((memory) => {
      const assistantId = memory.assistantId === GLOBAL_MEMORY_ID || !assistants.some((item) => item.id === memory.assistantId)
        ? null
        : memory.assistantId;
      const scope = assistantId ? "assistant" : "global";
      const id = `mem_${memory.id}`;
      const createdAt = memory.createdAt * 1000;
      const updatedAt = Math.max(createdAt, memory.updatedAt * 1000);
      return {
        id,
        scope,
        assistantId,
        type: "workflow",
        status: "active",
        content: memory.content,
        source: "manual",
        relatedIds: [],
        createdAt,
        updatedAt,
      };
    });
    const selectedRef = settings.chatModelId ? refs.get(settings.chatModelId) ?? null : null;
    const fastRef = settings.fastModelId ? refs.get(settings.fastModelId) ?? null : null;
    const preferences: Record<string, unknown> = {
      providers_order_v1: (settings.providers ?? []).map((provider) => provider.id),
      current_assistant_id_v1: (settings.assistants ?? []).some((assistant) => assistant.id === settings.assistantId)
        ? settings.assistantId
        : null,
      selected_model_v1: modelRefString(selectedRef),
      title_model_v1: modelRefString(fastRef),
      suggestion_model_v1: modelRefString(fastRef),
      summary_model_v1: modelRefString(fastRef),
      pinned_models_v1: (settings.favoriteModels ?? []).flatMap((modelId) => {
        const ref = refs.get(modelId);
        return ref ? [`${ref.providerKey}::${ref.modelId}`] : [];
      }),
      per_chat_model_enabled_v1: false,
      provider_group_map_v1: "{}",
      provider_group_collapsed_v1: "{}",
      provider_ungrouped_position_v1: 0,
      reasoning_choice_by_model_v1: "{}",
      search_enabled_v1: scope.searchServices && settings.enableWebSearch === true,
      search_selected_v1: exportedSearchSelected,
      search_common_v1: safeJson({ resultSize: settings.searchCommonOptions?.resultSize ?? 10 }),
      instruction_injections_active_ids_by_assistant_v1: "{}",
      world_books_active_ids_by_assistant_v1: "{}",
    };
    const injectionBindings: Record<string, string[]> = {};
    const lorebookBindings: Record<string, string[]> = {};
    for (const assistant of settings.assistants ?? []) {
      if (assistant.modeInjectionIds?.length) injectionBindings[assistant.id] = assistant.modeInjectionIds;
      if (assistant.lorebookIds?.length) lorebookBindings[assistant.id] = assistant.lorebookIds;
    }
    preferences.instruction_injections_active_ids_by_assistant_v1 = safeJson(injectionBindings);
    preferences.world_books_active_ids_by_assistant_v1 = safeJson(lorebookBindings);

    const settingsJson: Record<string, unknown> = {
      assistants_v1: safeJson(assistants),
      provider_configs_v1: safeJson(providers),
      provider_groups_v1: "[]",
      mcp_servers_v1: "[]",
      world_books_v1: safeJson(worldBooks),
      assistant_memories_v1: "[]",
      quick_phrases_v1: safeJson(quickPhrases),
      search_services_v1: safeJson(searchServices),
      tts_services_v1: "[]",
      instruction_injections_v1: safeJson(injections),
      assistant_tags_v1: "[]",
      memory_entries_v1: safeJson(memories),
      workspaces_v1: "[]",
      skills_v1: "[]",
      user_profile_fields_v1: "[]",
      ...Object.fromEntries(Object.entries(preferences).filter(([, value]) => value != null && value !== "")),
    };
    const settingsPath = join(stageDir, "settings.json");
    writeFileSync(settingsPath, safeJson(settingsJson));

    const dbMeta = hashFile(dbPath);
    const settingsMeta = hashFile(settingsPath);
    const manifest = {
      format: "kelivo-backup",
      formatVersion: KELIVO_BACKUP_FORMAT_VERSION,
      minimumReadableFormatVersion: KELIVO_MINIMUM_READABLE_FORMAT,
      payloadKind: "sqlite",
      createdAtUtc: new Date().toISOString(),
      appVersion: `rikkahub-pc-${APP_VERSION}`,
      includeChats: scope.conversations,
      includeFiles: false,
      secretsIncluded: true,
      scope: {
        // 与桌面端「同步选项」一一对应：关掉哪一类，manifest 自述里也不声称包含它。
        chats: scope.conversations,
        files: false,
        assistants: scope.assistants,
        providers: scope.models,
        mcp: false,
        environmentVariables: false,
        skills: false,
        worldBooks: scope.worldBooks,
        memories: scope.memories,
        quickPhrases: scope.quickMessages,
        instructions: scope.promptInjections,
        workspaces: false,
        searchServices: scope.searchServices,
        speechServices: false,
        settings: true,
      },
      database: {
        entry: "database/kelivo.db",
        schemaVersion: KELIVO_SCHEMA_VERSION,
        minimumReadableSchemaVersion: KELIVO_MINIMUM_READABLE_SCHEMA,
        conversationCount: counts.conversationCount,
        messageCount: counts.messageCount,
      },
      entries: {
        "database/kelivo.db": dbMeta,
        "settings.json": settingsMeta,
      },
    };
    writeFileSync(join(stageDir, "manifest.json"), safeJson(manifest));

    if (existsSync(targetZipPath)) rmSync(targetZipPath, { force: true });
    createZipFromDirectory(stageDir, targetZipPath, 120_000);
    return {
      size: statSync(targetZipPath).size,
      conversationCount: counts.conversationCount,
      messageCount: counts.messageCount,
      skippedAttachmentParts: counts.skippedAttachmentParts,
    };
  } finally {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}