// api/handlers/im.ts — 设置 › 网络 › 外部接入(QQ 机器人 / 微信)
//
// 三条主线:
//  - 配置读写:两个平台各自一个字段级合并端点(照 settings/proxy 的规矩:不发 = 保留原值,
//    要清空 = 显式发空串)。写完 updateSettings,其内部的 reconcileImAdapters 负责把适配器
//    追上配置,本文件不管启停。
//  - 扫码绑定:QQ 与微信都只提供 start/poll 这一对(而不是"服务端自己等完成")。绑定会话活在
//    服务端(im/qq/bind.ts、im/wechat/protocol.ts),所以界面关掉再回来还能接上同一个 sessionKey。
//    拿到凭据即写回 settings 并顺带打开开关:用户扫完码期待的就是"它能开始干活了"。
//  - 配对码:桌面端生成、IM 侧redeem。配对码本身不是秘密(6 位、一小时、一次性),但它打开
//    的是"能让本机模型烧额度、能读到助手人设与记忆"的门,所以生成/撤销都记一条日志。
//
// 凭据可见性:appSecret / botToken 与其他本机凭据(SSH 口令、供应商 apiKey)同等待遇——
// 存在 settings 里、经 SSE 快照下发给本机界面、导安卓备份时整块剥离(见 backup/export.ts)。

import type { JsonValue } from "../../foundation/types";
import type { ImAccessConfig, ImPlatformId } from "../../foundation/types/settings/im-access";
import { isRecord } from "../../foundation/utils";
import { state } from "../../persistence/json-store";
import { updateSettings } from "../../app-config";
import { error, json, readJson } from "../request";
import { normalizeImAccess } from "../../im/config";
import {
  issuePairingCode,
  pairingCodeActive,
  revokePairingCode,
  setPairingEnabled,
  unpairUser,
} from "../../im/pairing";
import { getImStatus } from "../../im/registry";
import { getWorkspace } from "../../workspace";
import { renderQrDataUrl } from "../../im/qr";
import { cancelQqBind, pollQqBind, startQqBind } from "../../im/qq/bind";
import {
  cancelWechatLogin,
  pollWechatLogin,
  startWechatLogin,
  WECHAT_DEFAULT_BASE_URL,
} from "../../im/wechat/protocol";

const PLATFORMS: readonly ImPlatformId[] = ["qq", "wechat"];

function config(): ImAccessConfig {
  return state.settings.imAccess;
}

function isPlatform(value: unknown): value is ImPlatformId {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** 字段级合并:只认识白名单里的键,未知键静默丢弃(防止把 chats/pairing 从这边搅乱)。 */
function mergePlatform(platform: ImPlatformId, patch: Record<string, JsonValue>): ImAccessConfig {
  const current = config();
  const slice = platform === "qq" ? current.qq : current.wechat;
  const merged = { ...slice };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in slice)) continue;
    if (key === "enabled" || key === "plainText") {
      if (typeof value === "boolean") (merged as Record<string, unknown>)[key] = value;
      continue;
    }
    if (key === "pairedUsers") continue; // 配对名单只由 redeem / 界面删除两条路改动
    if (typeof value === "string") (merged as Record<string, unknown>)[key] = value.trim();
  }
  return normalizeImAccess({ ...current, [platform]: merged });
}

async function readBody(request: Request): Promise<Record<string, JsonValue>> {
  const body = await readJson<Record<string, JsonValue>>(request);
  return isRecord(body) ? body : {};
}

export async function handleImRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "im/status" && request.method === "GET") {
    const current = config();
    return json({
      platforms: getImStatus(),
      pairing: {
        enabled: current.pairing.enabled,
        code: pairingCodeActive(current) ? current.pairing.code : null,
        expiresAt: pairingCodeActive(current) ? current.pairing.expiresAt : null,
      },
      // 会话绑定回显 conversationId:界面要能点进那条会话,也才能解释"这个 IM 会话在跟谁说话"。
      chats: current.chats.map((chat) => ({
        key: chat.key,
        platform: chat.platform,
        displayName: chat.displayName,
        conversationId: chat.conversationId,
        lastActiveAt: chat.lastActiveAt,
      })),
      pairedUsers: {
        qq: current.qq.pairedUsers,
        wechat: current.wechat.pairedUsers,
      },
    });
  }

  const platformSave = path.match(/^im\/(qq|wechat)$/);
  if (platformSave && request.method === "POST") {
    const body = await readBody(request);
    // 工作区是 agent 能力的边界:写进来的 id 必须真实存在,否则这条通道会静默退化成
    // 纯聊天,用户只会看到"绑了工作区但助手什么也做不了"。
    if (typeof body.workspaceId === "string" && body.workspaceId.trim() && !getWorkspace(body.workspaceId.trim())) {
      return error("workspace not found", 400, "im.workspace_not_found");
    }
    const next = mergePlatform(platformSave[1] as ImPlatformId, body);
    updateSettings({ ...state.settings, imAccess: next });
    const platform = platformSave[1] as ImPlatformId;
    return json({ status: "ok", config: platform === "qq" ? next.qq : next.wechat });
  }

  if (path === "im/qq/bind/start" && request.method === "POST") {
    const body = await readBody(request);
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    try {
      const result = await startQqBind(sessionKey ? { sessionKey } : {});
      return json({ status: "ok", ...result, qrDataUrl: await renderQrDataUrl(result.verificationUrl) });
    } catch (err) {
      return error(errMessage(err), 502, "im.bind_failed");
    }
  }

  if (path === "im/qq/bind/poll" && request.method === "POST") {
    const body = await readBody(request);
    const sessionKey = String(body.sessionKey ?? "").trim();
    if (!sessionKey) return error("sessionKey is required", 400);
    const result = pollQqBind(sessionKey);
    if (!result.connected) {
      // 平台换码时才带新的 verificationUrl/qrDataUrl(见 bind.ts 的 urlVersion),界面据此重画。
      return json({
        status: "ok",
        connected: false,
        state: result.status,
        message: result.message,
        ...(result.verificationUrl
          ? { verificationUrl: result.verificationUrl, qrDataUrl: await renderQrDataUrl(result.verificationUrl) }
          : {}),
      });
    }
    // appSecret 不回前端:绑定成功即已写进 settings,SSE 快照会把 botName 之类的展示字段带过去,
    // 而界面从来不需要读回明文密钥。
    updateSettings({
      ...state.settings,
      imAccess: normalizeImAccess({
        ...config(),
        qq: { ...config().qq, appId: result.appId ?? "", appSecret: result.appSecret ?? "", enabled: true },
      }),
    });
    console.info(`[IM] QQ 机器人绑定成功:appId=${result.appId ?? ""}`);
    return json({ status: "ok", connected: true, state: "completed", message: result.message, appId: result.appId ?? "" });
  }

  if (path === "im/qq/bind/cancel" && request.method === "POST") {
    const body = await readBody(request);
    cancelQqBind(String(body.sessionKey ?? "").trim());
    return json({ status: "cancelled" });
  }

  if (path === "im/wechat/bind/start" && request.method === "POST") {
    const body = await readBody(request);
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    try {
      const result = await startWechatLogin(sessionKey || undefined);
      return json({ status: "ok", ...result, qrDataUrl: await renderQrDataUrl(result.qrcodeUrl) });
    } catch (err) {
      return error(errMessage(err), 502, "im.bind_failed");
    }
  }

  if (path === "im/wechat/bind/poll" && request.method === "POST") {
    const body = await readBody(request);
    const sessionKey = String(body.sessionKey ?? "").trim();
    if (!sessionKey) return error("sessionKey is required", 400);
    const result = await pollWechatLogin(sessionKey);
    if (!result.connected) {
      return json({ status: "ok", connected: false, state: result.status, message: result.message });
    }
    updateSettings({
      ...state.settings,
      imAccess: normalizeImAccess({
        ...config(),
        wechat: {
          ...config().wechat,
          botToken: result.botToken,
          accountId: result.accountId,
          baseUrl: result.baseUrl || WECHAT_DEFAULT_BASE_URL,
          ...(result.userId ? { userId: result.userId } : {}),
          enabled: true,
        },
      }),
    });
    console.info(`[IM] 微信机器人绑定成功:accountId=${result.accountId}`);
    return json({ status: "ok", connected: true, state: "confirmed", message: result.message, accountId: result.accountId });
  }

  if (path === "im/wechat/bind/cancel" && request.method === "POST") {
    const body = await readBody(request);
    cancelWechatLogin(String(body.sessionKey ?? "").trim());
    return json({ status: "cancelled" });
  }

  if (path === "im/pairing" && request.method === "POST") {
    const body = await readBody(request);
    const current = config();
    if (typeof body.enabled === "boolean") {
      const next = setPairingEnabled(current, body.enabled);
      updateSettings({ ...state.settings, imAccess: next });
      console.info(body.enabled ? "[IM] 已开启配对" : "[IM] 已关闭配对(存量配对码作废)");
      return json({ status: "ok", enabled: next.pairing.enabled, code: null, expiresAt: null });
    }
    if (body.action === "revoke") {
      updateSettings({ ...state.settings, imAccess: revokePairingCode(current) });
      console.info("[IM] 配对码已撤销");
      return json({ status: "ok", code: null, expiresAt: null });
    }
    // 界面在关闭状态下不显示生成按钮;这里再拦一道,防脚本/旧界面绕开开关。
    if (!current.pairing.enabled) return error("pairing is disabled", 400, "im.pairing_disabled");
    const issued = issuePairingCode(current);
    updateSettings({ ...state.settings, imAccess: issued.config });
    console.info("[IM] 已生成新的配对码");
    return json({ status: "ok", code: issued.code, expiresAt: issued.config.pairing.expiresAt });
  }

  if (path === "im/pairing/unpair" && request.method === "POST") {
    const body = await readBody(request);
    if (!isPlatform(body.platform)) return error("platform must be qq or wechat", 400);
    const userId = String(body.userId ?? "").trim();
    if (!userId) return error("userId is required", 400);
    updateSettings({ ...state.settings, imAccess: unpairUser(config(), body.platform, userId) });
    return json({ status: "ok" });
  }

  const chatDelete = path.match(/^im\/chat\/([^/]+)$/);
  if (chatDelete && request.method === "DELETE") {
    // 只删绑定,不删会话:桌面端那条记录是用户的历史,IM 侧解绑不该顺手毁掉。
    const key = decodeURIComponent(chatDelete[1]);
    const current = config();
    updateSettings({
      ...state.settings,
      imAccess: { ...current, chats: current.chats.filter((chat) => chat.key !== key) },
    });
    return json({ status: "deleted" });
  }

  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
