// im/wechat/adapter.test.ts — 用本地假网关跑一遍轮询 → 入站 → 出站。
//
// 重点回归:入站用户消息的 from_user_id 就是扫码人自己(绑定流程返回的 ilink_user_id),
// 不能当成机器人回声过滤掉;机器人自己的消息用 message_type=2 区分。

import { afterEach, expect, test } from "bun:test";

import type { ImWechatSettings } from "../../foundation/types/settings/im-access";
import type { ImInbound, ImRuntime } from "../runtime";
import { createWechatAdapter, createWechatPort } from "./adapter";

const OWNER = "owner-1@im.wechat";
const BOT = "bot-1@im.bot";

type Sent = {
  msg: {
    to_user_id?: string;
    context_token?: string;
    item_list?: { text_item?: { text?: string } }[];
  };
};

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

test("扫码人自己发的消息能进来,回复带上下文 token", async () => {
  const inbounds: ImInbound[] = [];
  const sent: Sent[] = [];
  let updates = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ilink/bot/getupdates") {
        updates += 1;
        if (updates === 1) {
          return Response.json({
            ret: 0,
            msgs: [
              {
                seq: 1,
                message_id: 11,
                from_user_id: OWNER,
                to_user_id: BOT,
                create_time_ms: 1_700_000_000_000,
                message_type: 1,
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "帮助" } }],
              },
            ],
            get_updates_buf: "cursor-1",
          });
        }
        // 空轮询要挂一会儿再回,否则循环会空转发疯。
        await Bun.sleep(20);
        return Response.json({ ret: 0, msgs: [], get_updates_buf: "cursor-1" });
      }
      if (path === "/ilink/bot/sendmessage") {
        sent.push((await req.json()) as Sent);
        return Response.json({ ret: 0 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const config: ImWechatSettings = {
    enabled: true,
    botToken: "bot-token",
    accountId: BOT,
    baseUrl: server.url.origin,
    userId: OWNER,
    botName: "",
    assistantId: "",
    workspaceId: "",
    plainText: true,
    pairedUsers: [],
  };
  const runtime = {
    handleInbound: async (inbound: ImInbound) => {
      inbounds.push(inbound);
    },
  } as unknown as ImRuntime;
  const adapter = createWechatAdapter(config, runtime, () => undefined);
  cleanup = async () => {
    await adapter.stop();
    server.stop(true);
  };

  await adapter.start();
  await waitFor(() => inbounds.length > 0);
  expect(inbounds[0]?.chatId).toBe(OWNER);
  expect(inbounds[0]?.text).toBe("帮助");

  await createWechatPort().sendText(OWNER, "pong");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.msg.to_user_id).toBe(OWNER);
  expect(sent[0]?.msg.context_token).toBe("ctx-1");
  expect(sent[0]?.msg.item_list?.[0]?.text_item?.text).toBe("pong");
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await Bun.sleep(10);
  }
}
