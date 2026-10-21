// scripts/memory-sql-migration-smoke.ts — 记忆 JSON → SQLite 迁移冒烟（由测试以独立子进程调用）
// 独立进程的意义：foundation/paths 在模块加载时读取 RIKKAHUB_PC_DATA_DIR，bun test 多文件
// 共享模块缓存时改 env 不生效；子进程能拿到干净的真实启动路径。
import { loadState } from "../persistence/state-load";
import { getConversationsDb } from "../conversations";
import { memorySqlReady, readMemorySql } from "../memory/sqlite";
import { memoryStore } from "../memory";

await loadState();
const firstDb = getConversationsDb();
if (!firstDb) throw new Error("conversations db not opened");
const firstSnapshot = readMemorySql(firstDb);
const first = {
  ready: memorySqlReady(firstDb),
  rows: firstSnapshot.memories.map((memory) => [memory.assistantId, memory.content, memory.source]),
  global: memoryStore.getGlobalMemories().map((memory) => memory.content),
  assistant: memoryStore.getAssistantMemories("a1").map((memory) => memory.content),
};

// 用户删空全部记忆并落库，再模拟重启：JSON 快照里残留的旧内容不得复活。
memoryStore.clearAll();
await memoryStore.persistAll();
await loadState();
const secondDb = getConversationsDb();
if (!secondDb) throw new Error("conversations db not re-opened");
const second = {
  rows: readMemorySql(secondDb).memories.length,
  global: memoryStore.getGlobalMemories().length,
  assistant: memoryStore.getAssistantMemories("a1").length,
};

console.log("SMOKE " + JSON.stringify({ first, second }));
process.exit(0);
