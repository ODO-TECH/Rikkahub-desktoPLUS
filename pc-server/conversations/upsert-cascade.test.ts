// 全面审查 2-0(P0)回归测试:foreign_keys=ON + ON DELETE CASCADE 的真实 schema 下,
// 会话行 upsert 绝不能触发节点级联清空。历史缺陷:upsertConversationRow 用 INSERT OR
// REPLACE,REPLACE 的隐式 DELETE 级联删光该会话全部 pc_message_node——流式期间每次
// flush 都清一次表,进程中途死亡 = 会话历史永久丢失。
// 测试用生产同款 ensureConversationTables 建表,防止测试 schema 与真实库漂移。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  ensureConversationTables,
  migrateConversationsIntoDb,
  upsertConversationRowInto,
  upsertMessageNodeInto,
} from "./index";
import { ensureMessageFtsTable } from "./fts";
import { message } from "../foundation/utils";
import type { Conversation, MessageNode } from "../foundation/types";

function realSchemaDb(): Database {
  const db = new Database(":memory:");
  // 与 openConversationsDbUnsafe 一致:级联行为只有 foreign_keys=ON 才会出现
  db.exec("PRAGMA foreign_keys = ON");
  ensureConversationTables(db);
  ensureMessageFtsTable(db);
  return db;
}

function node(idValue: string, text: string): MessageNode {
  return { id: idValue, messages: [message("USER", [{ type: "text", text }])], selectIndex: 0 };
}

function conv(idValue: string, nodes: MessageNode[], title = "会话"): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title,
    systemPrompt: null,
    messages: nodes,
    chatSuggestions: [],
    isPinned: false,
    createAt: 1000,
    updateAt: 2000,
  };
}

function nodeCount(db: Database, convId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM pc_message_node WHERE conversation_id = ?").get(convId) as { n: number }).n;
}

describe("2-0 P0 缺陷复现:INSERT OR REPLACE 会话行会级联清空节点", () => {
  test("真实 schema 上 REPLACE 已存在的会话行 → 节点全灭(证明本测试环境能暴露原缺陷)", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "一"), node("n2", "二"), node("n3", "三")])]);
    expect(nodeCount(db, "c1")).toBe(3);
    // 原缺陷的 SQL 形态:对已存在主键 REPLACE = 隐式 DELETE(触发 CASCADE)+ INSERT
    db.prepare(
      "INSERT OR REPLACE INTO pc_conversation (id, assistant_id, title, system_prompt, suggestions, is_pinned, create_at, update_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", "a1", "标题更新", "", "[]", 0, 1000, 3000);
    expect(nodeCount(db, "c1")).toBe(0); // ← 这就是数据丢失的机制
  });
});

describe("upsertConversationRowInto(修复后)", () => {
  test("对已存在会话行 upsert:节点行原封不动,字段被更新", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "一"), node("n2", "二"), node("n3", "三")])]);
    expect(nodeCount(db, "c1")).toBe(3);

    upsertConversationRowInto(db, conv("c1", [], "流式中改标题"));
    expect(nodeCount(db, "c1")).toBe(3); // 修复核心:节点不再被级联清空
    const row = db.prepare("SELECT title, update_at FROM pc_conversation WHERE id = ?").get("c1") as { title: string; update_at: number };
    expect(row.title).toBe("流式中改标题");
    expect(row.update_at).toBe(2000);
  });

  test("流式 flush 序列模拟:反复 upsert 会话行 + 只补写脏节点,其余节点存活", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "历史一"), node("n2", "历史二")])]);
    // 模拟流式:第 3 个节点在长,每个 chunk flush 一次(会话行 + 脏节点)
    const growing = node("n3", "");
    for (const chunk of ["你", "你好", "你好世界"]) {
      growing.messages[0].parts = [{ type: "text", text: chunk }];
      upsertConversationRowInto(db, conv("c1", [], "会话"));
      upsertMessageNodeInto(db, "c1", growing, 2);
    }
    // 进程此刻死亡:历史节点必须还在盘上(原缺陷下这里只剩 n3)
    expect(nodeCount(db, "c1")).toBe(3);
    const texts = db.prepare("SELECT messages FROM pc_message_node WHERE conversation_id = ? ORDER BY node_index").all("c1") as { messages: string }[];
    expect(texts[0].messages).toContain("历史一");
    expect(texts[1].messages).toContain("历史二");
    expect(texts[2].messages).toContain("你好世界");
  });

  test("新会话行照常插入", () => {
    const db = realSchemaDb();
    upsertConversationRowInto(db, conv("c-new", []));
    expect((db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n).toBe(1);
  });
});

describe("upsertMessageNodeInto(修复后)", () => {
  test("对已存在节点 upsert:内容更新且不重复建行", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "旧文本")])]);
    upsertMessageNodeInto(db, "c1", node("n1", "新文本"), 0);
    expect(nodeCount(db, "c1")).toBe(1);
    const row = db.prepare("SELECT messages FROM pc_message_node WHERE id = ?").get("n1") as { messages: string };
    expect(row.messages).toContain("新文本");
  });
});

describe("migrateConversationsIntoDb 幂等(改为显式删节点后语义不回退)", () => {
  test("同一数据重跑:不重复、不冲突、节点数不变", () => {
    const db = realSchemaDb();
    const data = [conv("c1", [node("n1", "一"), node("n2", "二")])];
    migrateConversationsIntoDb(db, data);
    migrateConversationsIntoDb(db, data);
    expect(nodeCount(db, "c1")).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM pc_conversation").get() as { n: number }).n).toBe(1);
  });

  test("重灌节点数变少:陈旧节点被显式删除(不残留孤儿)", () => {
    const db = realSchemaDb();
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "一"), node("n2", "二"), node("n3", "三")])]);
    migrateConversationsIntoDb(db, [conv("c1", [node("n1", "仅剩")])]);
    expect(nodeCount(db, "c1")).toBe(1);
    const ids = db.prepare("SELECT id FROM pc_message_node WHERE conversation_id = ?").all("c1") as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(["n1"]);
  });
});
