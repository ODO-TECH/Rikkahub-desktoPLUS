// im/config.ts — 外部接入配置的读取与归一化
//
// 归一化的立场:state.json 是用户可手改的文件,任何一环塌了都不能让服务端启动失败或
// 让适配器拿到 `undefined.split()`。因此这里对每个字段都收口成"类型正确 + 有默认",
// 且**永不**返回新对象以外的副作用(不写盘、不启动连接)。

import type {
  ImAccessConfig,
  ImChatBinding,
  ImPairedUser,
  ImPlatformId,
  ImQqSettings,
  ImWechatSettings,
} from "../foundation/types/settings/im-access";
import { defaultImAccess } from "../foundation/types/settings/im-access";

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 只问"是不是普通对象",不做任何字段类型断言。不用 foundation/utils 的 isRecord:它的
 *  谓词是 `Record<string, JsonValue>`,而 settings 里本切片的声明类型是嵌套接口,窄谓词
 *  反而会把已知形状的对象判成不兼容。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 有限数才收:Infinity/NaN 落进 state.json 会被 JSON.stringify 变成 null,下次读又是
 *  "缺字段",来回震荡。 */
function time(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizePairedUsers(value: unknown): ImPairedUser[] {
  if (!Array.isArray(value)) return [];
  const out: ImPairedUser[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const userId = str(record.userId).trim();
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push({
      userId,
      displayName: str(record.displayName).trim() || userId.slice(0, 12),
      pairedAt: time(record.pairedAt),
    });
  }
  return out;
}

/** 会话绑定表按 key 去重后保留最近活跃的一条:key 是路由主键,重复条目会让同一条 IM
 *  消息在两个本机会话之间跳。 */
function normalizeChats(value: unknown): ImChatBinding[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, ImChatBinding>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const platform = str(record.platform) as ImPlatformId;
    if (platform !== "qq" && platform !== "wechat") continue;
    const chatId = str(record.chatId).trim();
    const conversationId = str(record.conversationId).trim();
    if (!chatId || !conversationId) continue;
    const binding: ImChatBinding = {
      key: `${platform}:${chatId}`,
      platform,
      chatId,
      displayName: str(record.displayName).trim() || chatId.slice(0, 12),
      conversationId,
      lastActiveAt: time(record.lastActiveAt),
    };
    const prev = byKey.get(binding.key);
    if (!prev || prev.lastActiveAt <= binding.lastActiveAt) byKey.set(binding.key, binding);
  }
  return [...byKey.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

function normalizeQq(raw: unknown): ImQqSettings {
  const record = asRecord(raw);
  const d = defaultImAccess().qq;
  if (!record) return d;
  return {
    enabled: bool(record.enabled, d.enabled),
    appId: str(record.appId).trim(),
    appSecret: str(record.appSecret).trim(),
    botName: str(record.botName).trim(),
    assistantId: str(record.assistantId).trim(),
    workspaceId: str(record.workspaceId).trim(),
    // 老配置没有这个字段:QQ 从第一天起就不渲染 Markdown,缺省按"纯文本"处理。
    plainText: bool(record.plainText, d.plainText),
    pairedUsers: normalizePairedUsers(record.pairedUsers),
  };
}

function normalizeWechat(raw: unknown): ImWechatSettings {
  const record = asRecord(raw);
  const d = defaultImAccess().wechat;
  if (!record) return { ...d };
  const baseUrl = str(record.baseUrl).trim().replace(/\/+$/, "");
  return {
    enabled: bool(record.enabled, d.enabled),
    botToken: str(record.botToken).trim(),
    accountId: str(record.accountId).trim(),
    // 空串回落默认域名;尾斜杠归一,协议侧直接拼 `new URL(endpoint, baseUrl)`。
    baseUrl: baseUrl || d.baseUrl,
    userId: str(record.userId).trim(),
    botName: str(record.botName).trim(),
    assistantId: str(record.assistantId).trim(),
    workspaceId: str(record.workspaceId).trim(),
    plainText: bool(record.plainText, d.plainText),
    pairedUsers: normalizePairedUsers(record.pairedUsers),
  };
}

export function normalizeImAccess(raw: unknown): ImAccessConfig {
  const root = asRecord(raw);
  if (!root) return defaultImAccess();
  const pairing = asRecord(root.pairing) ?? {};
  const code = str(pairing.code).trim().toUpperCase();
  const expiresAt = typeof pairing.expiresAt === "number" && Number.isFinite(pairing.expiresAt)
    ? pairing.expiresAt
    : null;
  return {
    qq: normalizeQq(root.qq),
    wechat: normalizeWechat(root.wechat),
    // 老配置没有 enabled 字段:历史行为就是"可配对",缺省按开处理。
    pairing: { enabled: bool(pairing.enabled, true), code: code || null, expiresAt },
    chats: normalizeChats(root.chats),
  };
}

/** 凭据齐备且用户开启,才谈得上启动。缺凭据时 enabled=true 只会静默不启动(界面另标状态)。 */
export function qqConfigured(qq: ImQqSettings): boolean {
  return qq.appId.length > 0 && qq.appSecret.length > 0;
}

export function wechatConfigured(wechat: ImWechatSettings): boolean {
  return wechat.botToken.length > 0 && wechat.accountId.length > 0;
}
