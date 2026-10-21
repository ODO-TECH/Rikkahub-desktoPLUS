// 专题2 H-c 回归测试:流式脏 flush 跳过 FTS 同步,流结束 persist 全量 reconcile。
// 契约:
// - upsertMessageNodeInto(..., syncFts=false) 只写节点行,绝不触碰 pc_message_fts;
// - 默认(syncFts 省略/true)行为与历史一致:删旧 FTS 行 + 插新行;
// - 模拟完整流式生命周期:N 次跳过 FTS 的 flush 后,一次带 FTS 的 upsert(对应流结束
//   persistConversation 内的逐节点重建)让索引恰好收敛到最终文本,无中间态残留。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, migrateConversationsIntoDb, upsertMessageNodeInto } from "./index";
import { ensureMessageFtsTable, replaceNodeFts, searchMessageFts } from "./fts";
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
  return { id: idValue, messages: [message("ASSISTANT", [{ type: "text", text }])], selectIndex: 0 };
}

function conv(idValue: string, nodes: MessageNode[]): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title: "会话",
    systemPrompt: null,
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
  };
}

function ftsTexts(db: Database, nodeId: string): string[] {
  return (db.prepare("SELECT text FROM pc_message_fts WHERE node_id = ?").all(nodeId) as { text: string }[]).map((r) => r.text);
}

describe("H-c: 流式 flush 跳过 FTS", () => {
  test("syncFts=false 只写节点行,不触碰 FTS", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "初始")])]);
    expect(ftsTexts(db, "n1")).toEqual(["初始"]);

    upsertMessageNodeInto(db, "c1", node("n1", "初始加了新内容"), 0, false);
    // 节点行已更新
    const row = db.prepare("SELECT messages FROM pc_message_node WHERE id = ?").get("n1") as { messages: string };
    expect(row.messages).toContain("初始加了新内容");
    // FTS 保持旧值(未被删也未被改)
    expect(ftsTexts(db, "n1")).toEqual(["初始"]);
  });

  test("默认 syncFts 行为不变:删旧行插新行", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "旧")])]);
    upsertMessageNodeInto(db, "c1", node("n1", "新文本"), 0);
    expect(ftsTexts(db, "n1")).toEqual(["新文本"]);
  });

  test("完整流式生命周期:多次跳过 FTS 的 flush → 流结束 reconcile 收敛,无中间态残留", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n0", "用户提问")])]);

    // 流式:节点 n1 逐帧增长,每次 flush 跳过 FTS(生产路径 flushConvDirty → syncFts=false)
    const growing = node("n1", "");
    for (const text of ["答", "答案是", "答案是四十二"]) {
      growing.messages[0].parts = [{ type: "text", text }];
      upsertMessageNodeInto(db, "c1", growing, 1, false);
      expect(ftsTexts(db, "n1")).toEqual([]); // 流式期间索引静默
    }

    // 流结束:persistConversation 内部对每个节点 replaceNodeFts(此处直接调同一原语)
    replaceNodeFts(db, "c1", growing);
    expect(ftsTexts(db, "n1")).toEqual(["答案是四十二"]);
    // 搜索命中最终文本,且中间态("答案是"前缀行)没有残留重复行
    const hits = searchMessageFts(db, "四十二");
    expect(hits.length).toBe(1);
    expect(hits[0]!.nodeId).toBe("n1");
  });
});
