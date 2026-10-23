import type { WebDavConfig, S3Config } from "..";

/** Kelivo 导入范围。与 backup/kelivo/options.ts 的同步范围一一对应；
 *  持久化在 Settings 里，云端恢复也按这份选择执行。 */
export interface KelivoSyncOptions {
  conversations: boolean;
  assistants: boolean;
  memories: boolean;
  models: boolean;
  worldBooks: boolean;
  promptInjections: boolean;
  quickMessages: boolean;
  searchServices: boolean;
}

/** RikkaHub 桌面端「同步选项」：一份选择同时决定本地备份、WebDAV / S3 云备份与
 *  Kelivo 兼容包里装什么。前 8 项与 Kelivo 的同步范围一一对应（实体级裁剪），后 4 项
 *  是桌面端独有的整组文件。恢复端把「缺席」当作「不改动」，少勾一项只会少恢复一类数据。 */
export interface BackupScope {
  /** pc_conversations.db + rikka_hub.db(及 -wal/-shm)：对话与消息 */
  conversations: boolean;
  /** settings.assistants(+ assistantTags)：助手 */
  assistants: boolean;
  /** pc-backup.json.state.memories 与安卓库 MemoryEntity：长期记忆 */
  memories: boolean;
  /** settings.providers：供应商与其模型 */
  models: boolean;
  /** settings.lorebooks：世界书 */
  worldBooks: boolean;
  /** settings.modeInjections：提示词注入 */
  promptInjections: boolean;
  /** settings.quickMessages：常用语 */
  quickMessages: boolean;
  /** settings.searchServices：搜索引擎配置 */
  searchServices: boolean;
  /** upload/：对话与头像引用的附件字节 */
  attachments: boolean;
  /** skills/：技能包文件 */
  skills: boolean;
  /** fonts/：自定义聊天字体 */
  fonts: boolean;
  /** AGENTS.md / CLAUDE.md：全局工作区指引 */
  globalAgents: boolean;
}

export interface StorageConfig {
  webDavConfig: WebDavConfig;
  s3Config: S3Config;
  /** 导出备份时同时生成一份 Kelivo 兼容备份（本地 + WebDAV/S3）。默认开。 */
  exportKelivoBackup: boolean;
  /** Kelivo 导入/云端恢复的同步范围。 */
  kelivoSyncOptions: KelivoSyncOptions;
  /** 「全部数据」备份模式：true = 与上游桌面端一致的完整备份，忽略 backupScope、
   *  把全部数据一次备齐；false = 按 backupScope 逐项备份。默认 true。 */
  backupAllData: boolean;
  /** 逐项备份的内容选择；只在 backupAllData=false 时生效（关闭后会保留上次选择）。 */
  backupScope: BackupScope;
}