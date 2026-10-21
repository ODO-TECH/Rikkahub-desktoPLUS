// 全面审查 R1-1 ③ 回归测试:启动迁移分批灌库。
// 旧的单事务整库灌在巨量会话下占死事件循环且中途断电全部重来;分批版必须:
// ① 全量数据完整落库;② 进度回调按批推进到总数;③ 重复执行幂等(崩溃重启从头重灌不脏)。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, migrateConversationsIntoDbBatched } from "./index";
import { ensureMessageFtsTable } from "./fts";
import { message } from "../foundation/utils";
import type { Conversation, MessageNode } from "../foundation/types";

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function node(idValue: string, text: string): MessageNode {
  return { id: idValue, messages: [message("USER", [{ type: "text", text }])], selectIndex: 0 };
}

function conv(idValue: string): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title: `会话 ${idValue}`,
    systemPrompt: null,
    messages: [node(`${idValue}-n1`, `内容 ${idValue}`)],
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
  };
}

describe("migrateConversationsIntoDbBatched(R1-1 分批灌库)", () => {
  test("分批提交:数据完整 + 进度回调推进到总数", async () => {
    const db = realSchemaDb();
    const convs = ["c1", "c2", "c3", "c4", "c5"].map(conv);
    const progress: [number, number][] = [];
    await migrateConversationsIntoDbBatched(db, convs, 2, (done, total) => progress.push([done, total]));

    expect(progress).toEqual([[2, 5], [4, 5], [5, 5]]);
    const convCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n;
    const nodeCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_message_node").get() as { n: number }).n;
    expect(convCount).toBe(5);
    expect(nodeCount).toBe(5);
  });

  test("重复执行幂等:重灌不产生重复行(崩溃重启场景)", async () => {
    const db = realSchemaDb();
    const convs = ["c1", "c2", "c3"].map(conv);
    // 模拟第一次迁移中途断电:只灌了前两条
    await migrateConversationsIntoDbBatched(db, convs.slice(0, 2), 1);
    // 重启后从头重灌全量
    await migrateConversationsIntoDbBatched(db, convs, 2);

    const convCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n;
    const nodeCount = (db.prepare("SELECT COUNT(*) AS n FROM pc_message_node").get() as { n: number }).n;
    expect(convCount).toBe(3);
    expect(nodeCount).toBe(3);
  });
});
