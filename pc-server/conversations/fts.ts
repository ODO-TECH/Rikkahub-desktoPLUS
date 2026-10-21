// conversations/fts.ts — 消息全文搜索（FTS5 trigram，P1-2）
//
// 设计（方案见 项目重构方案.md「P1-2 方案」条目）：
// - pc_message_fts 与 pc_conversation/pc_message_node 同库；text 为纯文本
//   （textFromParts 提取），conversation_id/node_id/message_id 为 UNINDEXED 载荷列。
// - trigram tokenizer：中文/英文统一按 3-gram 子串索引，大小写不敏感，
//   与旧实现 toLowerCase().includes() 的子串语义对齐。
// - 查询策略：≥3 字符走 MATCH（双引号短语转义，防连字符等被解析为 FTS 语法）；
//   1-2 字符走 LIKE（trigram 表的 LIKE/GLOB 自动使用索引优化；中文 2 字词是高频查询）。
// - 所有函数收 db 参数（不依赖模块单例），便于用临时库单测。
// - 虚拟表没有外键，pc_conversation 的 ON DELETE CASCADE 不覆盖它——删除路径必须显式清理。
import type { Database } from "bun:sqlite";
import type { MessageNode } from "../foundation/types";
import { textFromParts } from "../foundation/utils";

export interface MessageFtsHit {
  conversationId: string;
  nodeId: string;
  messageId: string;
  snippet: string;
}

export function ensureMessageFtsTable(db: Database): void {
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS pc_message_fts USING fts5(text, conversation_id UNINDEXED, node_id UNINDEXED, message_id UNINDEXED, tokenize='trigram')",
  );
}

/** 重建单节点的 FTS 行：先删该 node 全部行，再逐消息插入非空文本。流式热路径复用（亚毫秒级）。 */
export function replaceNodeFts(db: Database, conversationId: string, node: MessageNode): void {
  db.prepare("DELETE FROM pc_message_fts WHERE node_id = ?").run(node.id);
  const insert = db.prepare(
    "INSERT INTO pc_message_fts (text, conversation_id, node_id, message_id) VALUES (?, ?, ?, ?)",
  );
  for (const message of node.messages ?? []) {
    if (!message?.id) continue;
    const text = textFromParts(message.parts ?? []);
    if (!text) continue;
    insert.run(text, conversationId, node.id, message.id);
  }
}

export function deleteConversationFts(db: Database, conversationIds: string[]): void {
  if (conversationIds.length === 0) return;
  const stmt = db.prepare("DELETE FROM pc_message_fts WHERE conversation_id = ?");
  for (const conversationId of conversationIds) stmt.run(conversationId);
}

export function clearAllFts(db: Database): void {
  db.exec("DELETE FROM pc_message_fts");
}

export function ftsRowCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM pc_message_fts").get() as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * 从 pc_message_node 表全量重建索引。老库首次升级（无 FTS 表数据）与索引意外丢失
 * 都走这条自愈路径；openConversationsDb 在行数=0 且节点表非空时调用。
 * 逐节点 JSON.parse，与启动全量加载同量级，可接受。
 */
export function rebuildFtsFromNodeTable(db: Database): number {
  const nodes = db.prepare("SELECT id, conversation_id, messages, select_index FROM pc_message_node").all() as Array<{
    id: string;
    conversation_id: string;
    messages: string;
    select_index: number;
  }>;
  let rebuilt = 0;
  const txn = db.transaction(() => {
    clearAllFts(db);
    for (const row of nodes) {
      let messages: MessageNode["messages"];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        continue; // 损坏节点跳过：搜索少一条命中优于重建失败
      }
      if (!Array.isArray(messages) || messages.length === 0) continue;
      replaceNodeFts(db, row.conversation_id, { id: row.id, messages, selectIndex: row.select_index });
      rebuilt += 1;
    }
  });
  txn();
  return rebuilt;
}

/** MATCH 查询串转义：整体作为双引号短语，内部双引号翻倍。子串语义与旧 includes 对齐。 */
function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** LIKE 模式转义（% _ \\）。 */
function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** 无标记高亮：LIKE 分支手动构造 [匹配] 片段，与 snippet() 输出形状一致（前端 SnippetText 契约）。 */
function manualSnippet(text: string, query: string, window = 24): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, window * 2);
  const start = Math.max(0, idx - window);
  const end = Math.min(text.length, idx + query.length + window);
  return `${start > 0 ? "…" : ""}${text.slice(start, idx)}[${text.slice(idx, idx + query.length)}]${text.slice(idx + query.length, end)}${end < text.length ? "…" : ""}`;
}

export function searchMessageFts(db: Database, rawQuery: string, limit = 200): MessageFtsHit[] {
  const query = rawQuery.trim();
  if (!query) return [];
  if (query.length >= 3) {
    const rows = db.prepare(
      "SELECT conversation_id, node_id, message_id, snippet(pc_message_fts, 0, '[', ']', '…', 16) AS snip FROM pc_message_fts WHERE pc_message_fts MATCH ? LIMIT ?",
    ).all(ftsPhrase(query), limit) as Array<{ conversation_id: string; node_id: string; message_id: string; snip: string }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      nodeId: row.node_id,
      messageId: row.message_id,
      snippet: row.snip,
    }));
  }
  // 1-2 字符：LIKE 兜底（trigram 表的 LIKE 有索引优化；ESCAPE 显式声明反斜杠）
  const rows = db.prepare(
    "SELECT text, conversation_id, node_id, message_id FROM pc_message_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?",
  ).all(likePattern(query), limit) as Array<{ text: string; conversation_id: string; node_id: string; message_id: string }>;
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    nodeId: row.node_id,
    messageId: row.message_id,
    snippet: manualSnippet(row.text, query),
  }));
}
