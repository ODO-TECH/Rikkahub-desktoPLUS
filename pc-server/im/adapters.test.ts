// im/adapters.test.ts — 两个平台的"入站归一"与 QQ 绑定凭据解密。
//
// 归一层的判据很硬:这里放过去什么,会话引擎就会拿它去调一次真实模型。所以空的、机器人
// 自己发的、群里的(QQ 只做私聊)、图片/文件类没有文字的,一律返回空——宁可漏一条,
// 不可让一条莫名其妙的空消息触发一轮额度消耗。

import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";

import { extractQqPayload } from "./qq/adapter";
import { decryptBotSecret } from "./qq/bind";
import { extractWechatInbound } from "./wechat/adapter";
import { buildClientVersion, extractWechatText } from "./wechat/protocol";

describe("extractQqPayload", () => {
  const base = {
    kind: "c2c",
    senderId: "openid-1",
    senderName: "小明",
    senderIsBot: false,
    content: "在吗",
    messageId: "msg-1",
    timestamp: 1_700_000_000_000,
  };

  test("私聊文本:chatId 取发送者,回复锚点带 msgId", () => {
    const payload = extractQqPayload(base as never);
    expect(payload).not.toBeNull();
    expect(payload?.chatId).toBe("openid-1");
    expect(payload?.text).toBe("在吗");
    expect(payload?.displayName).toBe("小明");
    expect(payload?.dedupKey).toBe("msg-1");
    expect(payload?.replyTarget).toEqual({ scope: "c2c", targetId: "openid-1", msgId: "msg-1" });
  });

  test("群消息 / 机器人自己发的 / 无发送者:一律丢弃", () => {
    expect(extractQqPayload({ ...base, kind: "group" } as never)).toBeNull();
    expect(extractQqPayload({ ...base, senderIsBot: true } as never)).toBeNull();
    expect(extractQqPayload({ ...base, senderId: "  " } as never)).toBeNull();
    expect(extractQqPayload(undefined)).toBeNull();
  });

  test("语音转写并入正文;两者都空时不投递", () => {
    const payload = extractQqPayload({
      ...base,
      content: "",
      attachments: [{ url: "https://cdn/x.silk", asr_refer_text: "帮我看看这个" }],
    } as never);
    expect(payload?.text).toBe("帮我看看这个");
    expect(extractQqPayload({ ...base, content: "  ", attachments: [{ url: "https://cdn/x.png" }] } as never)).toBeNull();
  });

  test("没有 messageId 时用 用户+时间+正文前缀 兜底去重", () => {
    const payload = extractQqPayload({ ...base, messageId: "" } as never);
    expect(payload?.dedupKey).toBe(`openid-1:${base.timestamp}:在吗`);
    expect(payload?.replyTarget).toEqual({ scope: "c2c", targetId: "openid-1" });
  });

  test("没有昵称时给一个可读占位", () => {
    expect(extractQqPayload({ ...base, senderName: "" } as never)?.displayName).toBe("QQ 好友");
  });
});

describe("extractWechatText", () => {
  test("文本项取 text;语音项取服务端 ASR", () => {
    expect(extractWechatText([{ type: 1, text_item: { text: "你好" } }])).toBe("你好");
    expect(extractWechatText([{ type: 3, voice_item: { text: "语音转写" } }])).toBe("语音转写");
  });

  test("图片/文件等没有文字的类型返回空", () => {
    expect(extractWechatText([{ type: 2 }])).toBe("");
    expect(extractWechatText([])).toBe("");
    expect(extractWechatText(undefined)).toBe("");
  });

  test("引用消息把被引用内容前置,模型才读得懂「这个怎么处理」", () => {
    const text = extractWechatText([
      {
        type: 1,
        text_item: { text: "这个怎么处理" },
        ref_msg: { title: "阿花", message_item: { type: 1, text_item: { text: "上周的报表发你了" } } },
      },
    ]);
    expect(text).toBe("[引用: 阿花 | 上周的报表发你了]\n这个怎么处理");
  });
});

describe("extractWechatInbound", () => {
  const bot = { accountId: "bot-1@im.bot" };
  const owner = "owner-1@im.wechat";
  const message = (over: Record<string, unknown> = {}) => ({
    seq: 429,
    message_id: 9812451782375,
    from_user_id: owner,
    to_user_id: "bot-1@im.bot",
    create_time_ms: 1774158905123,
    message_type: 1,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "在吗" } }],
    ...over,
  });

  test("扫码人自己发来的消息必须收下(回归:曾按绑定者 userId 过滤,主人发什么都进不来)", () => {
    const inbound = extractWechatInbound(bot, message() as never);
    expect(inbound?.chatId).toBe(owner);
    expect(inbound?.userId).toBe(owner);
    expect(inbound?.text).toBe("在吗");
    expect(inbound?.dedupKey).toBe("9812451782375:429:1774158905123");
  });

  test("机器人自己发出的消息(message_type=2)丢弃,避免自问自答", () => {
    expect(extractWechatInbound(bot, message({ message_type: 2 }) as never)).toBeNull();
  });

  test("没有发送者 / 发送者是机器人自己 / 无文字:一律丢弃", () => {
    expect(extractWechatInbound(bot, message({ from_user_id: "  " }) as never)).toBeNull();
    expect(extractWechatInbound(bot, message({ from_user_id: "bot-1@im.bot" }) as never)).toBeNull();
    expect(extractWechatInbound(bot, message({ item_list: [{ type: 2 }] }) as never)).toBeNull();
  });
});

describe("decryptBotSecret", () => {
  /** 与服务端同构的构造:iv(12) + 密文 + tag(16),整体 base64。 */
  function seal(plain: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
  }

  test("往返解出明文", () => {
    const key = randomBytes(32);
    expect(decryptBotSecret(seal("s3cr3t-app-secret", key), key.toString("base64"))).toBe("s3cr3t-app-secret");
  });

  test("换了密钥(tag 校验失败)必须抛错,不能返回半截明文", () => {
    const key = randomBytes(32);
    expect(() => decryptBotSecret(seal("x", key), randomBytes(32).toString("base64"))).toThrow();
  });

  test("密文长度不足时给出明确错误", () => {
    expect(() => decryptBotSecret(Buffer.from("short").toString("base64"), randomBytes(32).toString("base64"))).toThrow(
      /长度异常/,
    );
  });
});

describe("buildClientVersion", () => {
  test("按 (major<<16 | minor<<8 | patch) 打包,脏输入当 0", () => {
    expect(buildClientVersion("2.1.7")).toBe((2 << 16) | (1 << 8) | 7);
    expect(buildClientVersion("")).toBe(0);
    expect(buildClientVersion("x.y.z")).toBe(0);
  });
});
