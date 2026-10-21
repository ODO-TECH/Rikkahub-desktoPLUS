// 活库读取原语单测：元数据装载 / 单会话节点读取 / 全量组合(迁移与导入合并路径的基础)。
// ensure/mark 状态机依赖 state 与 conversationsDb 单例，由 request-chain smoke 与真机端到端覆盖。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { loadAllConversationsFromDb, loadConversationMetasFromDb, loadConversationNodesFromDb } from "./index";
import { message } from "../foundation/utils";

function seededDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE pc_conversation (
      id TEXT PRIMARY KEY NOT NULL, assistant_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      suggestions TEXT NOT NULL DEFAULT '[]', is_pinned INTEGER NOT NULL DEFAULT 0,
      create_at INTEGER NOT NULL, update_at INTEGER NOT NULL
    );
    CREATE TABLE pc_message_node (
      id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, node_index INTEGER NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]', select_index INTEGER NOT NULL DEFAULT 0
    );
  `);
  const conv = db.prepare("INSERT INTO pc_conversation VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  conv.run("c-new", "a1", "较新会话", "", '["s1"]', 1, 2000, 2100);
  conv.run("c-old", "a1", "较旧会话", "sys", "[]", 0, 1000, 1100);
  const node = db.prepare("INSERT INTO pc_message_node VALUES (?, ?, ?, ?, ?)");
  const msgs = (texts: string[]) => JSON.stringify(texts.map((t) => message("USER", [{ type: "text", text: t }])));
  // 故意乱序插入，验证 node_index 排序
  node.run("n2", "c-old", 1, msgs(["第二节点"]), 0);
  node.run("n1", "c-old", 0, msgs(["第一节点"]), 2);
  node.run("n3", "c-new", 0, "{corrupt json", 0);
  return db;
}

describe("loadConversationMetasFromDb", () => {
  test("只装元数据：messages 为空、字段还原、create_at 倒序", () => {
    const metas = loadConversationMetasFromDb(seededDb());
    expect(metas.map((c) => c.id)).toEqual(["c-new", "c-old"]);
    expect(metas[0].messages).toEqual([]);
    expect(metas[0].isPinned).toBe(true);
    expect(metas[0].chatSuggestions).toEqual(["s1"]);
    expect(metas[1].systemPrompt).toBe("sys");
  });
});

describe("loadConversationNodesFromDb", () => {
  test("按 node_index 组装，selectIndex 还原", () => {
    const nodes = loadConversationNodesFromDb(seededDb(), "c-old");
    expect(nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(nodes[0].selectIndex).toBe(2);
    expect(nodes[0].messages[0].parts).toEqual([{ type: "text", text: "第一节点" }]);
  });

  test("损坏节点 JSON 得到空消息数组（不抛错）", () => {
    const nodes = loadConversationNodesFromDb(seededDb(), "c-new");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].messages).toEqual([]);
  });
});

describe("loadAllConversationsFromDb", () => {
  test("等价于元数据 + 各会话节点的组合", () => {
    const all = loadAllConversationsFromDb(seededDb());
    expect(all.map((c) => c.id)).toEqual(["c-new", "c-old"]);
    expect(all[1].messages.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});
