// fork 主键抢夺缺陷的回归测试:历史 fork 沿用源节点 id,UPSERT 的 ON CONFLICT(id) 把源
// 会话的节点行改挂到分支名下(源会话重载后"暂无消息";删分支=级联销毁=数据永久丢失)。
// 本文件验证 repairForkNodeTheft 能在真实 schema 上把被抢前缀以新 id 还原回受害会话。
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ensureConversationTables, upsertConversationRowInto, upsertMessageNodeInto } from "./index";
import { ensureMessageFtsTable } from "./fts";
import { repairForkNodeTheft } from "./fork-repair";
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

function conv(idValue: string, title: string, createAt: number, updateAt: number): Conversation {
  return {
    id: idValue,
    assistantId: "a1",
    title,
    systemPrompt: null,
    messages: [],
    chatSuggestions: [],
    isPinned: false,
    createAt,
    updateAt,
  };
}

function seedNodes(db: Database, convId: string, nodes: MessageNode[]): void {
  nodes.forEach((n, i) => upsertMessageNodeInto(db, convId, n, i));
}

function nodeRows(db: Database, convId: string): Array<{ id: string; node_index: number; messages: string }> {
  return db
    .prepare("SELECT id, node_index, messages FROM pc_message_node WHERE conversation_id = ? ORDER BY node_index")
    .all(convId) as Array<{ id: string; node_index: number; messages: string }>;
}

/** 模拟旧缺陷:fork 沿用源节点 id 持久化,把源会话的行抢走。 */
function simulateBuggyFork(db: Database, source: Conversation, sourceNodes: MessageNode[], forkId: string, prefixLength: number, forkAt: number): void {
  const fork = conv(forkId, source.title ? `${source.title} Fork` : "Fork", forkAt, forkAt);
  upsertConversationRowInto(db, fork);
  seedNodes(db, forkId, sourceNodes.slice(0, prefixLength));
}

describe("fork 节点主键抢夺:缺陷复现", () => {
  test("旧 fork 沿用节点 id → 源会话在 DB 中被抢空", () => {
    const db = realSchemaDb();
    const source = conv("src", "老会话", 1000, 2000);
    const nodes = [node("n1", "第一"), node("n2", "第二"), node("n3", "第三")];
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", nodes);
    simulateBuggyFork(db, source, nodes, "fork", 3, 3000);
    expect(nodeRows(db, "src")).toHaveLength(0);
    expect(nodeRows(db, "fork")).toHaveLength(3);
  });
});

describe("repairForkNodeTheft", () => {
  test("空受害者(fork 自最后一条):前缀全量还原,新 id,分支不动", () => {
    const db = realSchemaDb();
    const source = conv("src", "老会话", 1000, 2000);
    const nodes = [node("n1", "第一"), node("n2", "第二"), node("n3", "第三")];
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", nodes);
    simulateBuggyFork(db, source, nodes, "fork", 3, 3000);

    const outcome = repairForkNodeTheft(db);
    expect(outcome).toEqual({ repaired: 1, skipped: 0 });
    const restored = nodeRows(db, "src");
    expect(restored.map((r) => r.node_index)).toEqual([0, 1, 2]);
    expect(restored.map((r) => JSON.parse(r.messages)[0].parts[0].text)).toEqual(["第一", "第二", "第三"]);
    // 新 id:不与分支持有的原始 id 冲突
    expect(restored.some((r) => ["n1", "n2", "n3"].includes(r.id))).toBe(false);
    expect(nodeRows(db, "fork")).toHaveLength(3);
    // FTS 已重建:能按会话检索到还原的文本
    const fts = db.prepare("SELECT COUNT(*) c FROM pc_message_fts WHERE conversation_id = 'src'").get() as { c: number };
    expect(fts.c).toBe(3);
  });

  test("缺前缀受害者(fork 自中间):只补被抢走的前缀", () => {
    const db = realSchemaDb();
    const source = conv("src", "老会话", 1000, 2000);
    const nodes = [node("n1", "第一"), node("n2", "第二"), node("n3", "第三"), node("n4", "第四")];
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", nodes);
    simulateBuggyFork(db, source, nodes, "fork", 2, 3000);
    expect(nodeRows(db, "src").map((r) => r.node_index)).toEqual([2, 3]);

    const outcome = repairForkNodeTheft(db);
    expect(outcome).toEqual({ repaired: 1, skipped: 0 });
    const restored = nodeRows(db, "src");
    expect(restored.map((r) => r.node_index)).toEqual([0, 1, 2, 3]);
    expect(restored.map((r) => JSON.parse(r.messages)[0].parts[0].text)).toEqual(["第一", "第二", "第三", "第四"]);
  });

  test("反向抢夺(源会话事后持久化抢回行):分支从源会话补回前缀", () => {
    const db = realSchemaDb();
    // 终态:源会话持有全部 4 个节点;分支只剩自己后来新增的节点(index 2..3),前缀 0..1 被抢回。
    const source = conv("src", "老会话", 1000, 5000);
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", [node("n1", "第一"), node("n2", "第二"), node("n3", "第三"), node("n4", "第四")]);
    const fork = conv("fork", "老会话 Fork", 3000, 4000);
    upsertConversationRowInto(db, fork);
    upsertMessageNodeInto(db, "fork", node("f3", "分支新增一"), 2);
    upsertMessageNodeInto(db, "fork", node("f4", "分支新增二"), 3);

    const outcome = repairForkNodeTheft(db);
    expect(outcome).toEqual({ repaired: 1, skipped: 0 });
    const restored = nodeRows(db, "fork");
    expect(restored.map((r) => r.node_index)).toEqual([0, 1, 2, 3]);
    expect(restored.map((r) => JSON.parse(r.messages)[0].parts[0].text)).toEqual(["第一", "第二", "分支新增一", "分支新增二"]);
    expect(nodeRows(db, "src")).toHaveLength(4);
  });

  test("合法空会话(fork 后用户删光消息)不被误修复", () => {
    const db = realSchemaDb();
    // update_at(6000) > 分支 create_at(3000):删光发生在 fork 之后,跳过
    const source = conv("src", "老会话", 1000, 6000);
    upsertConversationRowInto(db, source);
    const fork = conv("fork", "老会话 Fork", 3000, 3000);
    upsertConversationRowInto(db, fork);
    seedNodes(db, "fork", [node("f1", "第一")]);

    const outcome = repairForkNodeTheft(db);
    expect(outcome).toEqual({ repaired: 0, skipped: 1 });
    expect(nodeRows(db, "src")).toHaveLength(0);
  });

  test("找不到配对分支(已删除/改名)只跳过不乱猜;幂等:修复后重跑无动作", () => {
    const db = realSchemaDb();
    const orphan = conv("orphan", "无配对", 1000, 2000);
    upsertConversationRowInto(db, orphan);
    const source = conv("src", "老会话", 1000, 2000);
    const nodes = [node("n1", "第一"), node("n2", "第二")];
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", nodes);
    simulateBuggyFork(db, source, nodes, "fork", 2, 3000);

    expect(repairForkNodeTheft(db)).toEqual({ repaired: 1, skipped: 1 });
    expect(repairForkNodeTheft(db)).toEqual({ repaired: 0, skipped: 1 });
    expect(nodeRows(db, "orphan")).toHaveLength(0);
  });

  test("链式 fork(分支再分支):迭代到定点,逐层还原", () => {
    const db = realSchemaDb();
    // 终态:节点行全部被最深层分支持有,源会话与中间分支都被抢空
    const source = conv("src", "老会话", 1000, 2000);
    const nodes = [node("n1", "第一"), node("n2", "第二")];
    upsertConversationRowInto(db, source);
    seedNodes(db, "src", nodes);
    simulateBuggyFork(db, source, nodes, "fork1", 2, 3000);
    const fork1 = conv("fork1", "老会话 Fork", 3000, 3000);
    simulateBuggyFork(db, fork1, nodes, "fork2", 2, 4000);
    expect(nodeRows(db, "src")).toHaveLength(0);
    expect(nodeRows(db, "fork1")).toHaveLength(0);
    expect(nodeRows(db, "fork2")).toHaveLength(2);

    const outcome = repairForkNodeTheft(db);
    expect(outcome).toEqual({ repaired: 2, skipped: 0 });
    expect(nodeRows(db, "src")).toHaveLength(2);
    expect(nodeRows(db, "fork1")).toHaveLength(2);
    expect(nodeRows(db, "fork2")).toHaveLength(2);
  });
});
