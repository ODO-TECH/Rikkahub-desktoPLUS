// im/runtime.ts — 一条 IM 消息如何变成本机会话里的一轮问答
//
// 与 cc-haha 的 chat-runtime.ts 同构,但把「WsBridge → 桌面端 → Claude Code 会话」整段
// 换成了直接调用本进程的会话编排:IM 消息与键盘消息走的是同一条 generateAnswer 路径
// (对齐 api/handlers/conversations.ts 的 voice/send),因此桌面端界面能实时看到 IM 会话
// 正在长的字,用户也能随时在界面上接手继续聊——这是"接入"而不是"另开一套聊天"的意义。
//
// 纪律:
//  - 未配对的用户永远到不了模型(见 pairing.ts 头注)。
//  - 每个会话的消息串行处理,但跨会话不互相阻塞。
//  - 本模块不 import registry,配置读写经注入的回调,免得形成环。

import type { Conversation, MessageNode, MessagePart } from "../foundation/types";
import type { ImAccessConfig, ImChatBinding, ImPlatformId } from "../foundation/types/settings/im-access";
import { id, message, textFromParts } from "../foundation/utils";
import { getConversation, persistConversation } from "../conversations";
import { checkoutConversation, releaseConversation } from "../conversations/working-set";
import { ensureConversation, findAssistant, presetMessageNodes, seedConversationInjectionBinding } from "../conversations/helpers";
import { findModel } from "../model-providers";
import { getWorkspace } from "../workspace";
import { generateAnswer } from "../conversations/orchestrator";
import { abortGeneration, compressing, generating } from "../conversations/generation-state";
import { cancelWaitingQueuedMessages, enqueueMessage, holdMessageQueue, releaseMessageQueueHold, waitForQueuedReply } from "../conversations/message-queue";
import { broadcastConversation, broadcastNodeUpdate } from "../api/sse";
import { applyInputRegexTransformParts } from "../assistants/index";
import { bumpAnalyticsMsgCount } from "../app-config/analytics";
import { isUserPaired, redeemPairingCode } from "./pairing";
import { markdownToPlainText } from "./markdown";
import { MessageDedup, enqueueForChat, splitMessage } from "./util";

export interface ImPort {
  platform: ImPlatformId;
  /** 日志前缀,如 `[QQ]`。 */
  logPrefix: string;
  /** 平台单条消息的字符上限,超长由 runtime 切分。 */
  textLimit: number;
  /** 发出一段文本(runtime 已按 textLimit 切好片,实现只管发)。 */
  sendText(chatId: string, text: string): Promise<void>;
  /** 输入中提示。best-effort:实现内部自行吞错,绝不能因此影响回复。 */
  setBusy?(chatId: string, busy: boolean): void;
}

export interface ImInbound {
  /** 平台侧会话标识:私聊是对方 id,群聊是群 id。 */
  chatId: string;
  /** 发送者标识,配对白名单按它收口(群里换个人说话就是另一个人)。 */
  userId: string;
  displayName: string;
  /** 平台消息 id;重连重放时同一条消息的 key 不变。 */
  dedupKey: string;
  text: string;
}

export interface ImRuntimeDeps {
  getConfig: () => ImAccessConfig;
  /** 覆盖写回配置(持久化 + 触发 reconcile)。只在配对/换绑会话时调用。 */
  updateConfig: (next: ImAccessConfig) => void;
}

/** 一个平台适配器的生命周期。start 允许在网关尚未连上时就返回(连接在后台跑)。 */
export interface ImAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** 适配器向 registry 回报的连接状态。 */
export type ImAdapterEvent = { connected: boolean; error?: string | null };

const PLATFORM_LABEL: Record<ImPlatformId, string> = { qq: "QQ", wechat: "微信" };

const HELP_TEXT = [
  "可用命令:",
  "/status 查看当前助手与模型",
  "/new 开一个新会话(旧的保留在桌面端)",
  "/stop 停止正在生成的回复",
  "",
  "直接发消息即可对话。回复在桌面端的会话列表里同样可见、可继续。",
].join("\n");

/** 绑定表里 lastActiveAt 的推进粒度:每条消息都写一次 state.json 不值得,一分钟一次够了。 */
const ACTIVE_TOUCH_MS = 60_000;

function isStopCommand(text: string): boolean {
  return text.toLowerCase() === "/stop" || text === "停止";
}

export class ImRuntime {
  private readonly dedup = new MessageDedup();
  private stopped = false;

  constructor(
    private readonly port: ImPort,
    private readonly deps: ImRuntimeDeps,
  ) {}

  destroy(): void {
    this.stopped = true;
    this.dedup.destroy();
  }

  /** 入口:平台适配器把归一化后的入站消息交到这里。返回的 Promise 在这条消息处理完时落定。 */
  handleInbound(inbound: ImInbound): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const { chatId, dedupKey } = inbound;
    if (!chatId) return Promise.resolve();
    if (dedupKey && !this.dedup.tryRecord(`${this.port.platform}:${dedupKey}`)) {
      console.info(`${this.port.logPrefix} 跳过重复消息 ${dedupKey}`);
      return Promise.resolve();
    }
    const text = inbound.text.trim();
    if (!text) return Promise.resolve();

    // /stop 必须绕过会话串行链:普通问答任务在链上等待生成结束时,排在后面的 stop
    // 永远轮不到,用户看到的是「按了停止但模型继续答完」。配对闸门仍在:未配对的人
    // 不能被 fast path 跳过配对流程。
    if (isStopCommand(text) && isUserPaired(this.deps.getConfig(), this.port.platform, inbound.userId)) {
      return this.stopNow(chatId).catch(async (err) => {
        console.error(`${this.port.logPrefix} 停止失败:`, err);
        this.port.setBusy?.(chatId, false);
        await this.saySafely(chatId, `停止失败:${errMessage(err)}`);
      });
    }

    return enqueueForChat(`${this.port.platform}:${chatId}`, async () => {
      try {
        await this.route(chatId, inbound, text);
      } catch (err) {
        console.error(`${this.port.logPrefix} 处理消息失败:`, err);
        this.port.setBusy?.(chatId, false);
        await this.saySafely(chatId, `处理失败:${errMessage(err)}`);
      }
    }).then(() => undefined);
  }

  private async route(chatId: string, inbound: ImInbound, text: string): Promise<void> {
    const config = this.deps.getConfig();
    const { userId, displayName } = inbound;

    if (!isUserPaired(config, this.port.platform, userId)) {
      await this.tryPair(chatId, config, userId, displayName, text);
      return;
    }

    if (await this.tryCommand(chatId, config, text)) return;

    const conversation = this.openConversation(config, chatId, displayName);
    if (!conversation) return;

    this.port.setBusy?.(chatId, true);
    const raw = await askAssistant(conversation, text);
    // 只改发出去的那份;桌面端会话里保留模型原始输出(含 Markdown)。
    const reply = formatReplyForIm(config, this.port.platform, raw);
    this.port.setBusy?.(chatId, false);

    await this.say(chatId, reply.trim() || "（本轮没有文本回复，请在桌面端查看该会话。）");
  }

  private async tryPair(
    chatId: string,
    config: ImAccessConfig,
    userId: string,
    displayName: string,
    text: string,
  ): Promise<void> {
    const attempt = redeemPairingCode(config, this.port.platform, userId, displayName, text);
    if (attempt.outcome === "not_attempted") return;
    if (attempt.outcome === "paired") {
      this.deps.updateConfig(attempt.config);
      console.info(`${this.port.logPrefix} 配对成功:${displayName}(${userId})`);
      await this.say(chatId, "配对成功,现在可以开始对话了。\n发送 /help 查看可用命令。");
      return;
    }
    const hint: Record<"disabled" | "no_code" | "expired" | "mismatch" | "rate_limited", string> = {
      disabled: "未授权。这台机器目前未开放配对。",
      no_code: "未授权。请在桌面端「设置 › 网络 › 外部接入」生成配对码后发给我。",
      expired: "配对码已过期,请在桌面端重新生成。",
      mismatch: "配对码不正确。请核对桌面端显示的 6 位码后重发。",
      rate_limited: "配对码尝试次数过多,请 5 分钟后再试。",
    };
    await this.say(chatId, hint[attempt.reason]);
  }

  /** 命中命令返回 true(调用方不再走模型)。 */
  private async tryCommand(chatId: string, config: ImAccessConfig, text: string): Promise<boolean> {
    const normalized = text.toLowerCase();
    if (normalized === "/help" || text === "帮助") {
      await this.say(chatId, HELP_TEXT);
      return true;
    }
    if (normalized === "/status" || text === "状态") {
      await this.say(chatId, this.statusText(config, chatId));
      return true;
    }
    if (normalized === "/new" || text === "新会话") {
      const conversation = this.openConversation(config, chatId, "", { forceNew: true });
      await this.say(chatId, conversation ? "已开启新会话,之前的记录保留在桌面端。" : "新会话创建失败,请在桌面端检查助手配置。");
      return true;
    }
    if (isStopCommand(text)) {
      await this.stopNow(chatId);
      return true;
    }
    return false;
  }

  private async stopNow(chatId: string): Promise<void> {
    const binding = findBinding(this.deps.getConfig(), this.port.platform, chatId);
    if (!binding) {
      await this.say(chatId, "当前会话还没有内容,无需停止。");
      return;
    }
    abortGeneration(binding.conversationId, "interrupted");
    // 与桌面端「停止」同义:冻结队列,否则被掐断的这一轮收尾时会把队列里的下一条点起来。
    holdMessageQueue(binding.conversationId);
    // 停止后这些排队消息不会再自动派发;等待方必须拿到终态,否则 IM 会话串行链
    // 会永久卡在 waitForQueuedReply 上,后续命令全部失效。
    cancelWaitingQueuedMessages(binding.conversationId);
    await this.say(chatId, "已停止本轮生成。");
  }

  private statusText(config: ImAccessConfig, chatId: string): string {
    const binding = findBinding(config, this.port.platform, chatId);
    const conversation = binding ? getConversation(binding.conversationId) : undefined;
    const assistant = findAssistant(conversation?.assistantId ?? assistantIdFor(config, this.port.platform));
    // findModel 自己会回退:assistant 没单独选模型就用全局聊天模型,再没有就成一个占位 auto。
    const picked = findModel(assistant.chatModelId);
    const workspaceId = workspaceIdFor(config, this.port.platform);
    const workspace = workspaceId ? getWorkspace(workspaceId) : null;
    const workspaceText = workspace
      ? `已绑定「${workspace.name}」`
      : workspaceIdForRaw(config, this.port.platform)
        ? "设置里的工作区已不存在(按纯聊天运行)"
        : "纯聊天(未绑定工作区)";
    return [
      `平台:${PLATFORM_LABEL[this.port.platform]}`,
      `助手:${assistant.name}`,
      `模型:${picked.model.displayName || picked.model.modelId}`,
      `工作区:${workspaceText}`,
      `消息数:${conversation?.messages.length ?? 0}`,
      `会话:${conversation?.title || "(尚未开始)"}`,
    ].join("\n");
  }

  /**
   * 取到(或建好)这个 IM 会话对应的本机会话。
   *
   * forceNew 用于 /new:换绑一个新的 conversationId,旧会话原样留在桌面端——IM 用户想要
   * 的是"重新开一段",不是"把历史删掉"。
   */
  private openConversation(
    config: ImAccessConfig,
    chatId: string,
    displayName: string,
    opts: { forceNew?: boolean } = {},
  ): Conversation | null {
    const existing = findBinding(config, this.port.platform, chatId);
    if (existing && !opts.forceNew) {
      this.touch(existing);
      return bindAssistant(existing.conversationId, this.port.platform, config);
    }

    const conversationId = id();
    const label = displayName.trim() || existing?.displayName || "会话";
    const binding: ImChatBinding = {
      key: `${this.port.platform}:${chatId}`,
      platform: this.port.platform,
      chatId,
      displayName: label,
      conversationId,
      lastActiveAt: Date.now(),
    };
    const next: ImAccessConfig = {
      ...config,
      chats: [...config.chats.filter((c) => c.key !== binding.key), binding],
    };
    this.deps.updateConfig(next);

    // 工作区归属只在创建时刻生效(见 helpers.ensureConversation 头注):之后改绑设置,
    // 已有会话保持原工作区,用户发 /new 才会换到新工作区。
    const conversation = ensureConversation(conversationId, {
      workspaceId: workspaceIdFor(config, this.port.platform),
    });
    conversation.title = `${PLATFORM_LABEL[this.port.platform]} · ${label}`;
    return bindAssistant(conversationId, this.port.platform, config, conversation);
  }

  /** 活跃时间推进:超过一分钟没动才写盘,避免每条消息都触发一次全量 saveState。 */
  private touch(binding: ImChatBinding): void {
    const now = Date.now();
    if (now - binding.lastActiveAt < ACTIVE_TOUCH_MS) return;
    const config = this.deps.getConfig();
    const chats = config.chats.map((c) => (c.key === binding.key ? { ...c, lastActiveAt: now } : c));
    this.deps.updateConfig({ ...config, chats });
  }

  private async say(chatId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, this.port.textLimit)) {
      await this.port.sendText(chatId, chunk);
    }
  }

  /** 错误回复自身也可能失败(网络抖动/对方撤回),那时只能记日志——不能再抛。 */
  private async saySafely(chatId: string, text: string): Promise<void> {
    try {
      await this.say(chatId, text);
    } catch (err) {
      console.error(`${this.port.logPrefix} 错误提示也发不出去:`, err);
    }
  }
}

function findBinding(config: ImAccessConfig, platform: ImPlatformId, chatId: string) {
  return config.chats.find((c) => c.platform === platform && c.chatId === chatId);
}

function assistantIdFor(config: ImAccessConfig, platform: ImPlatformId): string | undefined {
  const idValue = platform === "qq" ? config.qq.assistantId : config.wechat.assistantId;
  return idValue || undefined;
}

function workspaceIdForRaw(config: ImAccessConfig, platform: ImPlatformId): string {
  return (platform === "qq" ? config.qq.workspaceId : config.wechat.workspaceId).trim();
}

function plainTextFor(config: ImAccessConfig, platform: ImPlatformId): boolean {
  return platform === "qq" ? config.qq.plainText : config.wechat.plainText;
}

/** 发到 IM 平台的最终文本:平台开了纯文本输出就去 Markdown,否则原样。 */
export function formatReplyForIm(config: ImAccessConfig, platform: ImPlatformId, text: string): string {
  return plainTextFor(config, platform) ? markdownToPlainText(text) : text;
}

/** 真正可用的工作区 id:设置写了但工作区已被删除时按"未绑定"处理(落成纯聊天会话,
 *  而不是建一个 workspaceId 指向空、工具全挂不上的会话)。 */
function workspaceIdFor(config: ImAccessConfig, platform: ImPlatformId): string | null {
  const wanted = workspaceIdForRaw(config, platform);
  return wanted && getWorkspace(wanted) ? wanted : null;
}

/**
 * 把会话挂到该平台的助手上。
 *
 * 只在会话还没有用户消息时重播种预置消息:换助手应当带来新的人设开场,但已经聊过几轮的
 * 会话里重放一遍预置消息会把上下文搅乱。
 */
function bindAssistant(
  conversationId: string,
  platform: ImPlatformId,
  config: ImAccessConfig,
  prefetched?: Conversation,
): Conversation | null {
  const conversation = prefetched
    ?? getConversation(conversationId)
    ?? ensureConversation(conversationId, { workspaceId: workspaceIdFor(config, platform) });
  const assistant = findAssistant(assistantIdFor(config, platform));
  if (conversation.assistantId === assistant.id) return conversation;
  conversation.assistantId = assistant.id;
  if (!conversation.messages.some((node) => node.messages[node.selectIndex]?.role === "USER")) {
    conversation.messages = presetMessageNodes(assistant);
    seedConversationInjectionBinding(conversation, assistant);
  }
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);
  return conversation;
}

/**
 * 一轮问答:发进去、等出来。
 *
 * 与 voice/send 逐行同构,包括两处容易写错的地方:
 *  - 空闲分支要先 releaseMessageQueueHold,否则用户上次在桌面端按过「停止」会让这里永久静默;
 *  - 生成期间会话可能已被删除/替换,`getConversation(id) !== conversation` 即作废返回,
 *    否则会把回复发给一个已经不存在的会话。
 */
async function askAssistant(conversation: Conversation, text: string): Promise<string> {
  if (compressing.has(conversation.id)) return "上下文正在压缩,请稍后再发一次。";

  const assistant = findAssistant(conversation.assistantId);
  const parts = applyInputRegexTransformParts([{ type: "text", text } satisfies MessagePart], assistant);

  if (generating.has(conversation.id)) {
    const item = enqueueMessage(conversation.id, parts, { waitingReply: true });
    broadcastConversation(conversation);
    return (await waitForQueuedReply(conversation.id, item.id)) ?? "";
  }

  releaseMessageQueueHold(conversation.id);
  const userMessage = message("USER", parts);
  bumpAnalyticsMsgCount();
  const userNode: MessageNode = { id: id(), messages: [userMessage], selectIndex: 0 };
  conversation.messages.push(userNode);
  conversation.chatSuggestions = [];
  conversation.updateAt = Date.now();
  persistConversation(conversation);
  broadcastConversation(conversation);

  checkoutConversation(conversation.id);
  try {
    broadcastNodeUpdate(conversation, userNode);
    await generateAnswer(conversation);
    if (getConversation(conversation.id) !== conversation) return "";
    const lastNode = conversation.messages[conversation.messages.length - 1];
    const assistantMessage = lastNode?.messages?.[lastNode.selectIndex];
    return assistantMessage?.role === "ASSISTANT" ? textFromParts(assistantMessage.parts).trim() : "";
  } finally {
    releaseConversation(conversation.id);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
