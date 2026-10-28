// im/wechat/adapter.ts — 微信 iLink 机器人适配器
//
// 与 QQ 那条走 websocket 网关的路不同,iLink 是 HTTP 长轮询:一次 getupdates 挂住最长
// 35s,有消息就立刻返回。所以这里没有"连接"这个对象,只有"轮询循环还在跑"——界面上的
// 「已连接」= 最近一次 getupdates 成功返回过。
//
// 出站需要的会话上下文(session / context_token / typing_ticket)放在模块级,与
// createWechatPort 共享:registry 保证每平台同时只有一个实例,先停再起,不会有第二个循环
// 来抢同一张表。
//
// 两个容易写错的点:
//  - context_token 是每个会话最近一条入站消息带回来的,发消息必须带上它;它过期时平台会
//    拒绝,所以失败要退回不带 token 的主动消息再试一次,而不是直接把错误抛给用户。
//  - 游标 get_updates_buf 只用服务端返回的值覆盖,绝不回退到旧值——否则会把历史消息重放
//    一遍,而用户看到的是重复回复。

import type { ImWechatSettings } from "../../foundation/types/settings/im-access";
import type { ImAdapter, ImAdapterEvent, ImPort, ImRuntime } from "../runtime";
import {
  WECHAT_DEFAULT_BASE_URL,
  extractWechatText,
  getWechatTypingTicket,
  getWechatUpdates,
  sendWechatText,
  sendWechatTyping,
  type WechatMessage,
} from "./protocol";

const WECHAT_TEXT_LIMIT = 3_500;
/** 轮询出错后的退避:3s 起、翻倍封顶 60s,成功一次即复位。凭据被吊销时不至于打成洪水请求。 */
const BACKOFF_START_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;

type Session = { baseUrl: string; token: string };

export type WechatInbound = {
  chatId: string;
  userId: string;
  displayName: string;
  dedupKey: string;
  text: string;
};

/**
 * 入站归一:只收「人」发来的消息。
 *
 * 机器人自己发出的消息会以 message_type=2 回到同一条流里,不挡会自问自答无限循环。
 * 但不能用 from_user_id === 绑定者 userId 来挡:扫码确认返回的 ilink_user_id 是扫码人
 * (也就是主人)自己的 id,入站用户消息的 from_user_id 正是它——照那个过滤等于把主人
 * 发来的每一条消息都丢掉。
 */
export function extractWechatInbound(
  wechat: Pick<ImWechatSettings, "accountId">,
  message: WechatMessage,
): WechatInbound | null {
  if (message.message_type === 2) return null;
  const chatId = message.from_user_id?.trim();
  if (!chatId) return null;
  if (wechat.accountId && chatId === wechat.accountId) return null;
  const text = extractWechatText(message.item_list).trim();
  if (!text) return null;
  return {
    chatId,
    userId: chatId,
    displayName: "微信好友",
    dedupKey: `${message.message_id ?? ""}:${message.seq ?? ""}:${message.create_time_ms ?? ""}`,
    text,
  };
}

let session: Session | null = null;
let cursor = "";
const contextTokens = new Map<string, string>();
const typingTickets = new Map<string, string>();

function requireSession(): Session {
  if (!session) throw new Error("微信机器人尚未绑定");
  return session;
}

export function createWechatPort(): ImPort {
  return {
    platform: "wechat",
    logPrefix: "[微信]",
    textLimit: WECHAT_TEXT_LIMIT,

    async sendText(chatId, text) {
      const current = requireSession();
      const contextToken = contextTokens.get(chatId);
      try {
        await sendWechatText({ ...current, to: chatId, text, ...(contextToken ? { contextToken } : {}) });
        return;
      } catch (err) {
        // 没有 token 可带就已经是主动消息了,再退无可退——把真实错误交给上层。
        if (!contextToken) throw err;
        contextTokens.delete(chatId);
        await sendWechatText({ ...current, to: chatId, text });
      }
    },

    setBusy(chatId, busy) {
      if (!session) return;
      void notifyTyping(chatId, busy ? "typing" : "cancel").catch(() => undefined);
    },
  };
}

async function notifyTyping(chatId: string, status: "typing" | "cancel"): Promise<void> {
  const current = requireSession();
  const ticket = await ticketFor(chatId, current, status);
  if (!ticket) return;
  try {
    await sendWechatTyping({ ...current, ilinkUserId: chatId, typingTicket: ticket, status });
  } catch {
    // ticket 有时效,作废它,下一次调用重新换一张。
    typingTickets.delete(chatId);
  }
}

async function ticketFor(chatId: string, current: Session, status: "typing" | "cancel"): Promise<string | null> {
  const cached = typingTickets.get(chatId);
  if (cached) return cached;
  // cancel 没有 ticket 就什么都不做;typing 才值得为此多打一次 getconfig。
  if (status === "cancel") return null;
  const contextToken = contextTokens.get(chatId);
  const ticket = await getWechatTypingTicket({
    ...current,
    ilinkUserId: chatId,
    ...(contextToken ? { contextToken } : {}),
  });
  if (ticket) typingTickets.set(chatId, ticket);
  return ticket;
}

export function createWechatAdapter(
  wechat: ImWechatSettings,
  runtime: ImRuntime,
  report: (event: ImAdapterEvent) => void,
): ImAdapter {
  let abort: AbortController | null = null;

  async function route(message: WechatMessage): Promise<void> {
    const inbound = extractWechatInbound(wechat, message);
    if (!inbound) return;
    if (message.context_token) contextTokens.set(inbound.chatId, message.context_token);
    await runtime.handleInbound(inbound);
  }

  return {
    async start() {
      session = {
        baseUrl: (wechat.baseUrl || WECHAT_DEFAULT_BASE_URL).replace(/\/+$/, ""),
        token: wechat.botToken,
      };
      cursor = "";
      contextTokens.clear();
      typingTickets.clear();

      abort = new AbortController();
      const signal = abort.signal;
      let backoff = BACKOFF_START_MS;

      // 不等首轮结果:一次空轮询本来就要挂到 35s,等它只会让设置页先误报"连不上"。
      // 连接状态由循环里的 report 异步推进——成功一次转绿,失败写 lastError 并按退避重试。
      const loop = (async () => {
        while (!signal.aborted) {
          try {
            const resp = await getWechatUpdates({ ...requireSession(), getUpdatesBuf: cursor, signal });
            if (signal.aborted) break;
            const rejected = (typeof resp.ret === "number" && resp.ret !== 0)
              || (typeof resp.errcode === "number" && resp.errcode !== 0);
            if (rejected) {
              const message = `微信轮询返回 ${resp.errcode ?? resp.ret}:${resp.errmsg ?? "未知错误"}`;
              report({ connected: false, error: message });
              await sleep(backoff, signal);
              backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
              continue;
            }
            // 只接受前进:平台没带游标就保持原值,带了就覆盖。
            if (resp.get_updates_buf) cursor = resp.get_updates_buf;
            backoff = BACKOFF_START_MS;
            report({ connected: true });
            for (const message of resp.msgs ?? []) {
              await route(message);
            }
          } catch (err) {
            if (signal.aborted) break;
            const message = errMessage(err);
            report({ connected: false, error: message });
            await sleep(backoff, signal);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          }
        }
        report({ connected: false });
      })();

      // 启动失败不抛出:抛出会让 registry 记一次启动失败,而循环仍在后台按退避重试,
      // 网络恢复或凭据修好后自己就连上了——设置页能看到 lastError,不需要用户重开开关。
      void loop;
    },

    async stop() {
      abort?.abort();
      abort = null;
      session = null;
      cursor = "";
      contextTokens.clear();
      typingTickets.clear();
      report({ connected: false });
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
