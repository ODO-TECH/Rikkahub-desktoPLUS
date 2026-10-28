// im/wechat/protocol.ts — 微信 iLink 机器人协议
//
// 腾讯「微信机器人」(ilinkai.weixin.qq.com) 的 HTTP 协议,纯 fetch、零第三方依赖,
// 因此可以整段自带而不引入任何许可风险。要点:
//  - 绑定 = 扫码: get_bot_qrcode → 轮询 get_qrcode_status → confirmed 时直接带回
//    bot_token / ilink_bot_id / baseurl,不需要用户去任何后台复制粘贴。
//  - 收消息 = 长轮询 getupdates,游标是服务端给的 get_updates_buf(不透明字符串),
//    本地只负责"推进到最新一次返回值",不能自己构造。
//  - 发消息 = sendmessage,必须带上该会话最近一条入站消息的 context_token,否则服务端
//    拒绝(它把"能不能主动给这个人发"绑在会话上下文上)。
//  - 「正在输入」= getconfig 换 typing_ticket → sendtyping;ticket 是按用户下发的,要缓存。
//
// 与 cc-haha 同名模块的差别:HTTP 走 foundation/net 的 fetchWithTimeout,于是自动继承
// 系统代理设置,且每个调用都有明确超时(裸 fetch + AbortController 的写法在这里没有必要)。

import { randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../../foundation/net";

export const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_BOT_TYPE = "3";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.1.7";
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

const QR_LOGIN_TTL_MS = 5 * 60_000;
const QR_STATUS_TIMEOUT_MS = 35_000;
const GET_UPDATES_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;

export type WechatQrStatus = "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";

export type WechatCredentials = {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
};

export type WechatQrStartResult = { sessionKey: string; qrcodeUrl: string; message: string };

export type WechatQrPollResult =
  | ({ connected: true; status: "confirmed"; message: string } & WechatCredentials)
  | { connected: false; status: WechatQrStatus | "not_started"; message: string };

export type WechatCdnMedia = {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
};

export type WechatMessageItem = {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: { title?: string; message_item?: WechatMessageItem };
};

export type WechatMessage = {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
};

export type WechatGetUpdatesResp = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
};

type QrCodeResponse = { qrcode?: string; qrcode_img_content?: string };
type QrStatusResponse = {
  status?: WechatQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  /** 扫码后平台可能把人重定向到另一个接入网关,后续状态查询要跟着走。 */
  currentBaseUrl: string;
};

const activeLogins = new Map<string, ActiveLogin>();

/** 版本号打包成整数:微信侧按 (major<<16 | minor<<8 | patch) 校验客户端版本。 */
export function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * 从 item_list 里取出这条消息的文字。
 *
 * type 1 = 文本、3 = 语音(语音的 text 是服务端 ASR 结果);只认这两种,图片/文件在本机
 * 会话模型里暂时无处安放(见 im/runtime.ts:入站只有 text 一条通道)。
 * 引用消息把被引用内容前置成 `[引用: …]`,否则模型看到的就是一句没有上文的"这个怎么处理"。
 */
export function extractWechatText(itemList?: WechatMessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      const refBody = ref.message_item ? extractWechatText([ref.message_item]) : "";
      if (refBody) parts.push(refBody);
      return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export async function startWechatLogin(sessionKey?: string): Promise<WechatQrStartResult> {
  purgeExpiredLogins();
  const key = sessionKey?.trim() || randomUUID();
  const fresh = activeLogins.get(key);
  if (fresh) {
    return { sessionKey: key, qrcodeUrl: fresh.qrcodeUrl, message: "二维码已就绪,请使用微信扫描。" };
  }

  const raw = await apiGet(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_BOT_TYPE)}`, {
    baseUrl: WECHAT_DEFAULT_BASE_URL,
    label: "微信二维码",
  });
  const qr = JSON.parse(raw) as QrCodeResponse;
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信未返回二维码,请稍后重试。");

  activeLogins.set(key, {
    sessionKey: key,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
    currentBaseUrl: WECHAT_DEFAULT_BASE_URL,
  });
  return { sessionKey: key, qrcodeUrl: qr.qrcode_img_content, message: "使用微信扫描二维码完成绑定。" };
}

export async function pollWechatLogin(sessionKey: string): Promise<WechatQrPollResult> {
  purgeExpiredLogins();
  const login = activeLogins.get(sessionKey);
  if (!login) {
    return { connected: false, status: "not_started", message: "当前没有进行中的微信绑定,请重新生成二维码。" };
  }

  let status: QrStatusResponse;
  try {
    const raw = await apiGet(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}`, {
      baseUrl: login.currentBaseUrl,
      timeoutMs: QR_STATUS_TIMEOUT_MS,
      label: "微信扫码状态",
    });
    status = JSON.parse(raw) as QrStatusResponse;
  } catch {
    // 扫码状态查询是长轮询:网络抖动或超时就当成"还在等",不让界面报红。
    return { connected: false, status: "wait", message: "等待微信扫码确认…" };
  }

  switch (status.status) {
    case "scaned":
      return { connected: false, status: "scaned", message: "已扫码,请在微信里点确认。" };
    case "scaned_but_redirect":
      if (status.redirect_host) login.currentBaseUrl = `https://${status.redirect_host}`;
      return { connected: false, status: "scaned_but_redirect", message: "已扫码,正在切换微信接入网关…" };
    case "expired":
      activeLogins.delete(sessionKey);
      return { connected: false, status: "expired", message: "二维码已过期,请重新生成。" };
    case "confirmed": {
      activeLogins.delete(sessionKey);
      const botToken = status.bot_token?.trim();
      const accountId = status.ilink_bot_id?.trim();
      if (!botToken || !accountId) {
        return { connected: false, status: "expired", message: "微信已确认,但没有返回完整凭据,请重新扫码。" };
      }
      return {
        connected: true,
        status: "confirmed",
        message: "微信绑定成功。",
        botToken,
        accountId,
        baseUrl: status.baseurl?.trim() || login.currentBaseUrl || WECHAT_DEFAULT_BASE_URL,
        userId: status.ilink_user_id?.trim(),
      };
    }
    default:
      return { connected: false, status: "wait", message: "等待微信扫码确认…" };
  }
}

export function cancelWechatLogin(sessionKey: string): void {
  activeLogins.delete(sessionKey);
}

/** 测试隔离:模块级登录会话表不能跨用例泄漏。 */
export function __resetWechatLoginForTest(): void {
  activeLogins.clear();
}

/**
 * 长轮询取新消息。
 *
 * 超时是常态(服务端挂着等有消息才返回),所以超时一律折成空响应而不是抛错——
 * 调用方(适配器的轮询循环)只关心"这一轮有没有新东西"。
 */
export async function getWechatUpdates(params: {
  baseUrl: string;
  token: string;
  getUpdatesBuf?: string;
  signal?: AbortSignal;
}): Promise<WechatGetUpdatesResp> {
  try {
    const raw = await apiPost("ilink/bot/getupdates", {
      baseUrl: params.baseUrl,
      token: params.token,
      body: JSON.stringify({ get_updates_buf: params.getUpdatesBuf ?? "", base_info: baseInfo() }),
      timeoutMs: GET_UPDATES_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
      label: "微信消息轮询",
    });
    return JSON.parse(raw) as WechatGetUpdatesResp;
  } catch (err) {
    if (isAbortError(err)) return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    throw err;
  }
}

export async function sendWechatText(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: `rikkahub-wechat-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: params.text } }],
      context_token: params.contextToken,
    },
    base_info: baseInfo(),
  });
  const raw = await apiPost("ilink/bot/sendmessage", {
    baseUrl: params.baseUrl,
    token: params.token,
    body,
    timeoutMs: API_TIMEOUT_MS,
    label: "微信发送",
  });
  assertWechatOk(raw, "微信发送");
}

/** 换取某个用户的 typing_ticket(平台按用户下发,所以要缓存)。 */
export async function getWechatTypingTicket(params: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<string | null> {
  const raw = await apiPost("ilink/bot/getconfig", {
    baseUrl: params.baseUrl,
    token: params.token,
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: baseInfo(),
    }),
    timeoutMs: CONFIG_TIMEOUT_MS,
    label: "微信配置",
  });
  const config = JSON.parse(raw) as { typing_ticket?: string };
  return config.typing_ticket?.trim() || null;
}

export async function sendWechatTyping(params: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  typingTicket: string;
  status: "typing" | "cancel";
}): Promise<void> {
  const raw = await apiPost("ilink/bot/sendtyping", {
    baseUrl: params.baseUrl,
    token: params.token,
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status === "typing" ? 1 : 2,
      base_info: baseInfo(),
    }),
    timeoutMs: CONFIG_TIMEOUT_MS,
    label: "微信输入提示",
  });
  assertWechatOk(raw, "微信输入提示");
}

export const WECHAT_GET_UPDATES_TIMEOUT_MS = GET_UPDATES_TIMEOUT_MS;

async function apiGet(
  endpoint: string,
  params: { baseUrl: string; timeoutMs?: number; label: string },
): Promise<string> {
  const response = await fetchWithTimeout(new URL(endpoint, ensureTrailingSlash(params.baseUrl)), {
    method: "GET",
    headers: commonHeaders(),
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${params.label} ${response.status}:${text.slice(0, 200)}`);
  return text;
}

async function apiPost(
  endpoint: string,
  params: { baseUrl: string; token: string; body: string; timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<string> {
  const response = await fetchWithTimeout(new URL(endpoint, ensureTrailingSlash(params.baseUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${params.token.trim()}`,
      "X-WECHAT-UIN": randomWechatUin(),
      ...commonHeaders(),
    },
    body: params.body,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${params.label} ${response.status}:${text.slice(0, 200)}`);
  return text;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function commonHeaders(): Record<string, string> {
  return { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION) };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const uint32 = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** 微信的接口即使业务失败也回 HTTP 200,真正的错误码在 body 里(ret / errcode)。 */
function assertWechatOk(rawText: string, label: string): void {
  if (!rawText.trim()) return;
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return;
  }
  if (!body || typeof body !== "object") return;
  const record = body as Record<string, unknown>;
  const code = typeof record.ret === "number"
    ? record.ret
    : typeof record.errcode === "number"
      ? record.errcode
      : 0;
  if (code === 0) return;
  const message = typeof record.errmsg === "string" ? record.errmsg : rawText.slice(0, 200);
  throw new Error(`${label} 返回 ${code}:${message}`);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function purgeExpiredLogins(): void {
  const now = Date.now();
  for (const [sessionKey, login] of activeLogins) {
    if (now - login.startedAt >= QR_LOGIN_TTL_MS) activeLogins.delete(sessionKey);
  }
}
