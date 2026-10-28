// im/qq/adapter.ts — QQ 开放平台机器人适配器
//
// 用官方 SDK `@tencent-connect/qqbot-nodejs`(MIT,唯一运行时依赖 ws)走 websocket 网关:
// token 管理、心跳、断线 RESUME、重连全部交给它,本文件只做三件事——
//  1. 把 SDK 的 InboundMessage 收敛成 runtime 的 ImInbound(并只放行 c2c);
//  2. 记住每个会话的回复锚点(平台要求被动回复带上入站 msgId);
//  3. 把连接事件回报给 registry 用于界面显示。
//
// 为什么只收 c2c(私聊)不收群消息:配对授权的是「人」。群里一条消息换成另一个成员发,
// userId 就变了,白名单按 userId 收口才成立;而群聊里机器人一旦回复,同群所有人都能借这个
// 会话间接驱动模型——那是把单聊的授权扩大成了群发。真要做群,需要按群维度的独立授权模型。
//
// 代理:SDK 的 websocket 不受 foundation/net 的 fetch 拦截器影响,直连网关;只有 REST
// (取 token、发消息)走 globalThis.fetch,因而继承系统代理设置。

import { QQBot, type QQBotInboundMessage, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { ImQqSettings } from "../../foundation/types/settings/im-access";
import type { ImAdapter, ImAdapterEvent, ImInbound, ImPort, ImRuntime } from "../runtime";

/** QQ 单条文本消息上限,超出由 runtime 切片后逐条发送。 */
const QQ_TEXT_LIMIT = 1_500;
/** 「对方正在输入」的展示时长。 */
const TYPING_SECONDS = 30;
/** 首连等待预算。超时不判失败:网关侧的网络抖动不该让设置页弹一个红色报错。 */
const CONNECT_TIMEOUT_MS = 20_000;

export interface QqInboundPayload extends ImInbound {
  replyTarget: ReplyTarget;
}

/**
 * 归一化一条入站消息,不合格返回 null(调用方直接丢弃)。
 *
 * 语音消息不下载音频本体:QQ 服务端已经做过 ASR,`asr_refer_text` 就是那句话的文字,
 * 而模型读不了 amr。文本与转写按到达顺序拼成一条消息文本。
 */
export function extractQqPayload(message: QQBotInboundMessage | undefined): QqInboundPayload | null {
  if (!message || message.kind !== "c2c") return null;
  if (message.senderIsBot) return null;
  const userId = message.senderId?.trim();
  if (!userId) return null;

  const attachments = (message.attachments ?? []).filter((item) => Boolean(item?.url));
  const transcripts = attachments
    .map((item) => item.asr_refer_text?.trim())
    .filter((value): value is string => Boolean(value));
  const text = [message.content?.trim(), ...transcripts].filter(Boolean).join("\n").trim();
  if (!text) return null;

  const messageId = message.messageId?.trim();
  return {
    chatId: userId,
    userId,
    displayName: message.senderName?.trim() || "QQ 好友",
    text,
    dedupKey: messageId || `${userId}:${message.timestamp}:${text.slice(0, 32)}`,
    replyTarget: { scope: "c2c", targetId: userId, ...(messageId ? { msgId: messageId } : {}) },
  };
}

/**
 * 出站要用的连接与回复锚点。
 *
 * port(怎么说)与 adapter(什么时候说)是两件事,但它们必须指向同一个 QQBot 实例和同一张
 * 锚点表——registry 每平台只保证一个实例在跑(先停再起),所以这份状态放在模块级单例里,
 * 而不是在两个工厂函数之间传来传去。
 */
let currentBot: QQBot | null = null;
const replyTargets = new Map<string, ReplyTarget>();

export function createQqPort(): ImPort {
  /** 没有已知锚点时按主动消息发:平台允许但频率受限,只作为兜底。 */
  const targetFor = (chatId: string): ReplyTarget => replyTargets.get(chatId) ?? { scope: "c2c", targetId: chatId };
  return {
    platform: "qq",
    logPrefix: "[QQ]",
    textLimit: QQ_TEXT_LIMIT,
    async sendText(chatId, text) {
      const bot = currentBot;
      if (!bot) throw new Error("QQ 机器人尚未连接");
      await bot.sendText(targetFor(chatId), text);
    },
    setBusy(chatId, busy) {
      if (!busy) return;
      const bot = currentBot;
      if (!bot) return;
      // 输入中提示纯属礼节:失败不能影响回复本身。
      void bot.sendTyping(targetFor(chatId), TYPING_SECONDS).catch(() => undefined);
    },
  };
}

export function createQqAdapter(
  qq: ImQqSettings,
  runtime: ImRuntime,
  report: (event: ImAdapterEvent) => void,
): ImAdapter {
  return {
    async start() {
      const bot = new QQBot({
        appId: qq.appId,
        appSecret: qq.appSecret,
        accountId: qq.appId,
        transport: "websocket",
        // 首连同步取 token:AppID/AppSecret 写错要在这里立刻炸出来,而不是等用户第一条消息
        // 发不出去才发现。
        tokenPrefetch: "sync",
        logger: {
          info: (msg, meta) => console.info(`[QQ] ${msg}`, meta ?? ""),
          warn: (msg, meta) => console.warn(`[QQ] ${msg}`, meta ?? ""),
          error: (msg, meta) => console.error(`[QQ] ${msg}`, meta ?? ""),
          debug: () => undefined,
        },
      });

      let connected = false;
      let settleFirst: (outcome: FirstOutcome) => void = () => undefined;
      const first = new Promise<FirstOutcome>((resolve) => {
        settleFirst = resolve;
      });

      bot.on("ready", () => {
        connected = true;
        report({ connected: true });
        settleFirst({ kind: "connected" });
      });
      bot.on("resumed", () => {
        if (connected) return;
        connected = true;
        report({ connected: true });
        settleFirst({ kind: "connected" });
      });
      bot.on("error", (err) => {
        report({ connected: false, error: errMessage(err) });
        settleFirst({ kind: "failed", error: errMessage(err) });
      });
      bot.on("message", (_ctx, message) => {
        const payload = extractQqPayload(message);
        if (!payload) return;
        replyTargets.set(payload.chatId, payload.replyTarget);
        void runtime.handleInbound({
          chatId: payload.chatId,
          userId: payload.userId,
          displayName: payload.displayName,
          dedupKey: payload.dedupKey,
          text: payload.text,
        });
      });

      const abort = new AbortController();
      // bot.start() 正常路径要到 stop() 才落定,所以它绝不能被 await 住;把它折成一个
      // 永不 reject 的信号,再和首连事件、超时一起 race。
      const loop = bot.start(abort.signal).then(
        () => ({ kind: "closed" }) as FirstOutcome,
        (err: unknown) => ({ kind: "failed", error: errMessage(err) }) as FirstOutcome,
      );

      const outcome = await Promise.race([first, loop, after(CONNECT_TIMEOUT_MS)]);
      if (outcome.kind === "failed") {
        teardown(bot, abort);
        currentBot = null;
        report({ connected: false, error: outcome.error });
        throw new Error(outcome.error || "QQ 网关连接失败");
      }
      if (outcome.kind === "closed") {
        currentBot = null;
        report({ connected: false, error: "QQ 网关连接已关闭。" });
        return;
      }
      if (!connected) {
        // 超时:连接尝试留在后台继续,SDK 自己会重连;先记一条"还没连上"而不是报错。
        report({ connected: false, error: `连接 QQ 网关超时(${Math.round(CONNECT_TIMEOUT_MS / 1000)}s),后台仍在重试。` });
        currentBot = bot;
        return;
      }
      currentBot = bot;
    },

    async stop() {
      const bot = currentBot;
      currentBot = null;
      replyTargets.clear();
      if (bot) {
        try {
          bot.stop();
        } catch {
          // 已经断开的连接再 stop 会抛,忽略。
        }
      }
      report({ connected: false });
    },
  };
}

function teardown(bot: QQBot, abort: AbortController): void {
  abort.abort();
  try {
    bot.stop();
  } catch {
    // 同上。
  }
}

type FirstOutcome =
  | { kind: "connected" }
  | { kind: "failed"; error: string }
  | { kind: "closed" }
  | { kind: "timeout" };

function after(ms: number): Promise<FirstOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    timer.unref?.();
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
