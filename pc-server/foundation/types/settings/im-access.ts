// 外部接入(IM)配置切片:QQ 机器人与微信机器人把消息送进本机的会话。
//
// 凭据可见性沿用 SSH 的口径(见 ssh-config.ts 头注):本地可信 UI 模型,随 settings 明文
// 下发并落 state.json,但整块不进 Android 兼容备份(安卓端没有 IM 接入这条链路,见
// backup/export.ts 的剥离块)。
//
// 运行态(网关是否连上、最后一次错误、进行中的扫码会话)一律不落这里——它们活在
// pc-server/im/registry.ts 的内存里,经 /api/im/status 暴露。settings 只存"重启后仍成立"
// 的事实。

/** 一个通过配对码获得授权的 IM 用户。 */
export interface ImPairedUser {
  /** 平台侧的稳定用户标识(QQ 的 openid / 微信的 ilink user id)。 */
  userId: string;
  displayName: string;
  pairedAt: number;
}

/** 一个 IM 会话与本机会话(conversation)的绑定。 /new 换绑时写回新的 conversationId。 */
export interface ImChatBinding {
  /** `${platform}:${chatId}`,主键。 */
  key: string;
  platform: ImPlatformId;
  /** 平台侧的会话标识(QQ 的 peer openid / 群 id;微信的 from_user_id)。 */
  chatId: string;
  displayName: string;
  conversationId: string;
  lastActiveAt: number;
}

export type ImPlatformId = "qq" | "wechat";

export interface ImQqSettings {
  /** 用户手动开关:关掉就断开网关、保留凭据。凭据缺失时即使为 true 也不会启动。 */
  enabled: boolean;
  /** 扫码绑定拿到的机器人凭据。 */
  appId: string;
  appSecret: string;
  /** 绑定成功的用户昵称,仅用于界面上认人。 */
  botName: string;
  /** 回答 IM 消息所用的助手。空串 = 用当前默认助手。 */
  assistantId: string;
  /** 这条通道新建的会话绑到哪个工作区(agent 模式)。空串 = 纯聊天,不给工具。
   *  只在会话创建时刻生效:改绑只影响之后新建的会话,已有会话保持原工作区。 */
  workspaceId: string;
  /** 发到 QQ 的回复去掉 Markdown 排版(QQ 不渲染)。默认开;桌面端会话内容不受影响。 */
  plainText: boolean;
  pairedUsers: ImPairedUser[];
}

export interface ImWechatSettings {
  enabled: boolean;
  /** iLink 机器人凭据,扫码确认后由服务端下发。 */
  botToken: string;
  accountId: string;
  baseUrl: string;
  /** 绑定者自己的 ilink user id,用于「给自己发一条」验证通路。 */
  userId: string;
  botName: string;
  assistantId: string;
  /** 同 QQ:新建会话绑定的工作区,空串 = 纯聊天。 */
  workspaceId: string;
  /** 同 QQ:发到微信的回复去掉 Markdown 排版。 */
  plainText: boolean;
  pairedUsers: ImPairedUser[];
}

/** 配对码与它的总开关。关闭 = 不再接受新的配对;已授权的人不受影响。 */
export interface ImPairingSettings {
  /** 是否开放配对。关掉时不能生成新码,存量码立即作废。 */
  enabled: boolean;
  /** 一次性配对码:在界面生成,由陌生人在 IM 里发来兑换。 */
  code: string | null;
  expiresAt: number | null;
}

export interface ImAccessConfig {
  qq: ImQqSettings;
  wechat: ImWechatSettings;
  pairing: ImPairingSettings;
  chats: ImChatBinding[];
}

/**
 * 一个平台的运行态:GET /api/im/status 的线上形状(与 registry 内存态一一对应)。
 * 落在这里而不是留在 registry:它是界面消费的契约,界面只 import 类型,不能依赖服务端模块。
 */
export interface ImPlatformStatus {
  platform: ImPlatformId;
  /** 凭据是否齐备(没凭据时开关再开也不会启动)。 */
  configured: boolean;
  enabled: boolean;
  /** 有实例在跑(含正在重连)。 */
  running: boolean;
  /** 网关/长轮询已就绪,能收消息。 */
  connected: boolean;
  connectedAt: number | null;
  lastError: string | null;
  pairedCount: number;
  chatCount: number;
}

/** 出厂默认:两平台均未绑定、未启用——不绑定就不会有任何出站连接,零网络足迹。
 *  函数而非常量:返回的对象会被 normalizeState 就地补键,共享引用会让一次污染永久生效。 */
export function defaultImAccess(): ImAccessConfig {
  return {
    qq: {
      enabled: false,
      appId: "",
      appSecret: "",
      botName: "",
      assistantId: "",
      workspaceId: "",
      plainText: true,
      pairedUsers: [],
    },
    wechat: {
      enabled: false,
      botToken: "",
      accountId: "",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "",
      botName: "",
      assistantId: "",
      workspaceId: "",
      plainText: true,
      pairedUsers: [],
    },
    pairing: { enabled: true, code: null, expiresAt: null },
    chats: [],
  };
}

export interface ImAccessSlice {
  imAccess: ImAccessConfig;
}
