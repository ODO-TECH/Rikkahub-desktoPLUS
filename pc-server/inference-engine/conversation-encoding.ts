// inference-engine/conversation-encoding.ts — 会话 → 三家 Provider 请求体的编码层
// （模板变量、提示词注入、OpenAI messages / Responses API input / Google contents 构建）
// 纪律：纯搬迁自 server.ts（阶段 5.3d），行为不变。

import type { ApiMessage, Assistant, Conversation, JsonValue, Message, Model } from "../foundation/types";
import { applyPlaceholders, cloneJson, getStringArray, message, renderTemplate, textFromParts } from "../foundation/utils";
import { state } from "../persistence/json-store";
import { frozenContextBlocks } from "./context-snapshots";
import { buildSearchContext } from "../search";
import { findModel } from "../model-providers";
import { listSkills } from "../tools/skills";
import { conversationFunctionTools } from "../tools/bound";
import { GOOGLE_SAFETY_SETTINGS, apiContentFromParts, apiContentText, appendAssistantApiMessages, googleContentsFromApiMessages, googleFunctionDeclarations, googleGenerationConfig, hasBuiltInTool, hostOfProvider, responseApiMessagesFromUiMessages, supportsAbility, supportsOutputModality } from "./message-builder";
import { responsesHistoryReasoningAllowed } from "../model-providers/request-dialect";
import { isEmptyAssistantPlaceholder } from "./parts";
import { enrichMessages, templateVariables } from "./message-enrichment";
import { findEffectiveCompaction, parseEngineCompactions, pinnedMessagesBefore } from "./engine-compaction";
import { readDynamicRecallBlock } from "../memory/dynamic-recall";

// 消息模板/时间提醒/lorebook+模式注入/滞回截断 已上收至 message-enrichment.ts
// (引擎无关层);本文件只负责"富化产物 → 三家 Provider 请求体"的编码。

function buildSkillsContext(assistant: Assistant) {
  const enabled = new Set(getStringArray(assistant.enabledSkills));
  const available = listSkills().filter((skill) => enabled.has(skill.name));
  if (available.length === 0) return "";
  const body = available
    .map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n  </skill>`)
    .join("\n");
  return `**Skills**
You have access to the following skills. Use the \`use_skill\` tool to load a skill's instructions when the user's request matches.
<available_skills>
${body}
</available_skills>`;
}

export function buildGoogleRequestBody(messagesForApi: ApiMessage[], modelItem: Model, assistant: Assistant) {
  const systemContent = messagesForApi.find((item) => item.role === "system")?.content;
  const hasImageOutput = supportsOutputModality(modelItem, "IMAGE");
  const functionTools = supportsAbility(modelItem, "TOOL")
    ? conversationFunctionTools(assistant, modelItem)
    : [];
  const functionDeclarations = googleFunctionDeclarations(functionTools);
  // 内置工具（googleSearch/urlContext）目前与函数工具互斥，优先内置工具，镜像安卓
  // buildCompletionRequestBody:446-468（model.tools 覆盖 functionDeclarations）。
  const builtInTools: Record<string, JsonValue>[] = [];
  if (hasBuiltInTool(modelItem, "search")) builtInTools.push({ googleSearch: {} });
  if (hasBuiltInTool(modelItem, "url_context") || hasBuiltInTool(modelItem, "urlContext")) {
    builtInTools.push({ urlContext: {} });
  }
  const tools = builtInTools.length
    ? builtInTools
    : functionDeclarations.length
      ? [{ functionDeclarations }]
      : undefined;
  const body: Record<string, JsonValue> = {
    // system 在图片输出模型上不发送，对齐安卓 buildCompletionRequestBody:352。
    ...(systemContent && !hasImageOutput
      ? { systemInstruction: { parts: [{ text: apiContentText(systemContent) }] } }
      : {}),
    generationConfig: googleGenerationConfig(modelItem, assistant),
    contents: googleContentsFromApiMessages(messagesForApi),
    ...(tools ? { tools } : {}),
    safetySettings: GOOGLE_SAFETY_SETTINGS,
  };
  return body;
}

// 按工具边界把 ASSISTANT 消息的 parts 分组。镜像安卓
// ai/src/main/java/me/rerere/ai/provider/providers/ProviderMessageUtils.kt 的
// groupPartsByToolBoundary：连续的"已执行 tool" parts 合为一组，与它们之前的
// content（含 reasoning）共同组成一条 assistant 消息，避免把同一个 reasoning
// 在多次 tool flush 中提前清空——这是 DeepSeek V4 thinking 模式要求每条带
// tool_calls 的 assistant 消息都必须携带 reasoning_content 的核心修复点。
//
// 本函数现在只做"选路 + system 装配 + 空占位剔除",消息加工(模板/提醒/注入/截断)
// 全部委托 message-enrichment.enrichMessages——pi 工作区引擎吃同一份裁决。
// 导出给自动压缩预检(conversations/auto-compaction.ts)复用:阈值必须按模型真实
// 收到的同一份富化产物估算(含 system / 摘要 / 注入),不能只数原始消息。
export function conversationTransformedMessages(
  conversation: Conversation,
  assistant: Assistant,
  /** dynamicRecall=true 时把按最新用户消息检索的易变召回块追加到该 USER 消息末尾。
   *  只给真实生成/压缩估算开；辅助调用（标题、翻译等）保持关闭，不带实验注入。 */
  options?: { dynamicRecall?: boolean },
) {
  const picked = findModel(assistant.chatModelId ?? state.settings.chatModelId);
  // 1.5.0 跟进安卓 Migration_16_17:truncateIndex("清除上下文"分割线)机制废弃,
  // 上下文裁剪只剩两条正交机制——助手级 contextMessageLimit 切片 + 压缩对话历史。
  const visibleNodes = conversation.messages;
  // 剔除尾部"正在生成"的空 ASSISTANT 占位后再富化,见 isEmptyAssistantPlaceholder
  // 的说明(issue #16 + 工具恢复兼容)。
  const contextNodes = visibleNodes.filter((node, index) => {
    if (index !== visibleNodes.length - 1) return true;
    const selected = node.messages[node.selectIndex] ?? node.messages[0];
    return !isEmptyAssistantPlaceholder(selected);
  });
  const selectedMessages = contextNodes
    .map((node) => node.messages[node.selectIndex] ?? node.messages[0])
    .filter(Boolean)
    .map((msg) => cloneJson(msg));

  const conversationSystemPrompt = assistant.allowConversationSystemPrompt
    ? String(conversation.systemPrompt ?? "").trim()
    : "";
  const effectiveSystemPrompt = conversationSystemPrompt || assistant.systemPrompt.trim();
  // 专题11-P1-2:system 各区块按“稳定→易变”排列。专题12 进一步把记忆/最近会话
  // 冻结为会话级快照(context-snapshots.ts)。P6 退役:原居首的工作区段已移除——
  // 工作区可用必走 pi 会话(agent 身份由 pi 系统提示词+appendSystemPrompt 承载)。
  const systemParts = [
    effectiveSystemPrompt
      ? renderTemplate(effectiveSystemPrompt, templateVariables("", "system", assistant, picked.model))
      : "",
    buildSkillsContext(assistant),
    buildSearchContext(),
    ...frozenContextBlocks(assistant, conversation.id),
  ].filter(Boolean);

  const systemMessage = systemParts.length
    ? message("SYSTEM", [{ type: "text", text: systemParts.join("\n\n") }])
    : null;

  // 压缩(P9 双引擎统一):聊天引擎与 pi 共用同一份会话级记录——切点仍在选中路径的
  // 最新一条生效(编辑/fork 删掉切点行 → 记录自动失效,退回全量原文,绝不丢历史)。
  // 与 pi 的差别只在摘要承载方式:pi 把它交给引擎 appendCompaction,聊天引擎把摘要
  // 合成一条 USER 行注入序列最前(enrichMessages 的 compactionSummary)。
  const compaction = findEffectiveCompaction(
    parseEngineCompactions(conversation.engineCompactions),
    selectedMessages,
    () => true,
  );
  // 阶段四:钉住的消息只补"切点之前"那部分——切点之后的钉住消息本来就在窗口里
  // 逐字可见,再注入一遍就是重复内容。工具型消息的纯文本可能为空,Skip。
  const pinned = compaction
    ? pinnedMessagesBefore(selectedMessages, compaction.cutMessageId)
        .map((msg) => ({ role: msg.role, text: textFromParts(msg.parts).trim() }))
        .filter((msg) => msg.text.length > 0)
    : [];
  const enriched = enrichMessages(selectedMessages, {
    conversation,
    assistant,
    model: picked.model,
    windowStartMessageId: compaction?.cutMessageId,
    compactionSummary: compaction?.summary,
    pinnedMessages: pinned,
    timeReminderAnchor: systemMessage ?? undefined,
  });

  // 系统位注入(before/after_system_prompt)并入 system 面:before 在前、after 在后,
  // 与安卓 PromptInjectionTransformer 的 system 位语义一致;无 system 时注入单独成条。
  const systemWithInjections = [
    enriched.systemInjectionBefore,
    systemMessage ? textFromParts(systemMessage.parts) : "",
    enriched.systemInjectionAfter,
  ].filter(Boolean).join("\n");

  const internalMessages: Message[] = [];
  if (systemWithInjections) {
    internalMessages.push(message("SYSTEM", [{ type: "text", text: systemWithInjections }]));
  }
  internalMessages.push(...enriched.messages);
  if (options?.dynamicRecall) {
    // 易变召回块贴在最新 USER 消息末尾:Google / Responses 会丢弃序列中段的
    // system 消息,尾部 SYSTEM 在三家方言里并不可靠;用户消息是唯一处处保真的插槽。
    for (let index = internalMessages.length - 1; index >= 0; index -= 1) {
      const candidate = internalMessages[index]!;
      if (candidate.role !== "USER") continue;
      const block = readDynamicRecallBlock(conversation.id, assistant, candidate.id);
      if (block) internalMessages[index] = appendMessageText(candidate, block);
      break;
    }
  }
  return { messages: internalMessages, picked };
}

/** 把一段注入文本追加到消息最后一个 text part（返回副本，不改富化产物/落库消息）。 */
function appendMessageText(msg: Message, extra: string): Message {
  const parts = [...msg.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type !== "text") continue;
    parts[index] = { ...part, text: part.text ? `${part.text}\n\n${extra}` : extra };
    return { ...msg, parts };
  }
  parts.push({ type: "text", text: extra });
  return { ...msg, parts };
}

export function conversationMessagesForApi(
  conversation: Conversation,
  assistant: Assistant,
  // 对齐安卓 commit e63d017：OpenAI providerSetting.includeHistoryReasoning
  // 控制是否把历史 assistant 消息的 reasoning_content 回传给上游。默认 true，
  // 与安卓 ChatCompletionsAPI.buildMessages 的默认值一致。
  includeHistoryReasoning: boolean = true,
  /** 真实生成才置 true：把易变召回块追加到最新 USER 消息（见 S9）。 */
  dynamicRecall: boolean = false,
) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall });

  const items: ApiMessage[] = [];
  for (const selected of transformedMessages) {
    const role = selected.role === "SYSTEM" ? "system" : selected.role === "TOOL" ? "tool" : selected.role === "ASSISTANT" ? "assistant" : "user";
    if (selected.role === "ASSISTANT") {
      appendAssistantApiMessages(items, selected, includeHistoryReasoning);
      continue;
    }
    const rawContent = textFromParts(selected.parts);
    const content = apiContentFromParts(selected.parts, rawContent, picked.model);
    if (!content) continue;
    items.push({ role, content });
  }
  return items;
}

/** Interactions 路的历史 assistant parts:与 messagesForApi 的 assistant 消息按下标
 *  对齐(两者都出自 conversationTransformedMessages 的同一次富化,顺序天然一致)。
 *  供应商签名(interactions_signature)只活在落库 parts 的 metadata 里——chat-completions
 *  形态的 messagesForApi 带不上它,Interactions 的无状态回传必须回源头取。 */
export function conversationAssistantHistoryParts(
  conversation: Conversation,
  assistant: Assistant,
  messagesForApi: ApiMessage[],
): Array<Record<string, unknown>[]> {
  const expected = messagesForApi.filter((item) => item?.role === "assistant").length;
  const { messages: transformedMessages } = conversationTransformedMessages(conversation, assistant);
  const parts: Array<Record<string, unknown>[]> = [];
  for (const selected of transformedMessages) {
    if (selected.role !== "ASSISTANT") continue;
    parts.push(selected.parts as unknown as Array<Record<string, unknown>>);
    if (parts.length >= expected) break;
  }
  return parts;
}

export function conversationResponseApiInput(
  conversation: Conversation,
  assistant: Assistant,
  /** 真实生成才置 true：易变召回块追加到最新 USER 输入项。 */
  dynamicRecall: boolean = false,
) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant, { dynamicRecall });
  // 历史思考项回传方言：仅官方 OpenAI 主机（第三方 Responses 端点形态各异，火山
  // 直接 400，见 responsesHistoryReasoningAllowed 头注）；另尊重 provider 级
  // includeHistoryReasoning 开关（与 chat-completions 路径 e63d017 同语义——
  // Responses 路径只有 openai 型 provider 会走到，无需再判 type）。
  const includeReasoningItems = responsesHistoryReasoningAllowed(hostOfProvider(picked.provider))
    && picked.provider.includeHistoryReasoning !== false;
  return responseApiMessagesFromUiMessages(transformedMessages, picked.model, includeReasoningItems);
}

export function conversationResponseApiInstructions(conversation: Conversation, assistant: Assistant) {
  const { messages: transformedMessages, picked } = conversationTransformedMessages(conversation, assistant);
  return transformedMessages
    .filter((item) => item.role === "SYSTEM")
    .map((item) =>
      applyPlaceholders(
        textFromParts(item.parts),
        templateVariables(textFromParts(item.parts), "system", assistant, picked.model),
      )
    )
    .filter(Boolean)
    .join("\n");
}
