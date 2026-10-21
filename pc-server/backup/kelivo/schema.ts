// Kelivo 备份库 schema v3 —— 从真实 Kelivo 1.3.x 归档库导出（PRAGMA user_version=3）。
// 这是双向同步的“外挂解码器”契约：Kelivo 恢复端会逐表校验列顺序/索引/FK，
// 因此这份 DDL 必须与 Kelivo 的 AppDatabase.currentSchemaVersion=3 逐字同构，
// 不得按 RikkaHub 习惯改写。新增表/列只能在 Kelivo 升 schema 后整体替换。

export const KELIVO_SCHEMA_VERSION = 3;

export const KELIVO_SCHEMA_SQL = `
-- table asset_gc_rows
CREATE TABLE "asset_gc_rows" ("asset_id" TEXT NOT NULL REFERENCES asset_rows (id) ON DELETE CASCADE, "not_before" INTEGER NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0 CHECK("attempts" >= 0), "generation" INTEGER NOT NULL DEFAULT 0 CHECK("generation" >= 0), PRIMARY KEY ("asset_id"));
-- table asset_reference_dirty_rows
CREATE TABLE "asset_reference_dirty_rows" ("revision_id" TEXT NOT NULL REFERENCES message_rows (id) ON DELETE CASCADE, PRIMARY KEY ("revision_id"));
-- table asset_rows
CREATE TABLE "asset_rows" ("id" TEXT NOT NULL, "content_hash" TEXT NOT NULL UNIQUE, "path" TEXT NOT NULL, "byte_size" INTEGER NOT NULL CHECK("byte_size" >= 0), "width" INTEGER NULL CHECK("width" > 0), "height" INTEGER NULL CHECK("height" > 0), "thumbnail_path" TEXT NULL, "created_at" INTEGER NOT NULL, "last_referenced_at" INTEGER NOT NULL, "extras_json" TEXT NOT NULL DEFAULT '{}', PRIMARY KEY ("id"));
-- table assistant_memory_rows
CREATE TABLE "assistant_memory_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "assistant_id" TEXT NOT NULL, "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table assistant_rows
CREATE TABLE "assistant_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table assistant_tag_rows
CREATE TABLE "assistant_tag_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table chat_storage_meta_rows
CREATE TABLE "chat_storage_meta_rows" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, PRIMARY KEY ("key"));
-- table conversation_mcp_server_rows
CREATE TABLE "conversation_mcp_server_rows" ("conversation_id" TEXT NOT NULL REFERENCES conversation_rows (id) ON DELETE CASCADE, "server_id" TEXT NOT NULL, "ordinal" INTEGER NOT NULL CHECK("ordinal" >= 0), PRIMARY KEY ("conversation_id", "server_id"), UNIQUE ("conversation_id", "ordinal"));
-- table conversation_rows
CREATE TABLE "conversation_rows" ("id" TEXT NOT NULL, "title" TEXT NOT NULL, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, "is_pinned" INTEGER NOT NULL DEFAULT 0 CHECK ("is_pinned" IN (0, 1)), "assistant_id" TEXT NULL, "truncate_index" INTEGER NOT NULL DEFAULT -1 CHECK("truncate_index" >= -1), "version_selections_json" TEXT NOT NULL DEFAULT '{}', "summary" TEXT NULL, "last_summarized_message_count" INTEGER NOT NULL DEFAULT 0 CHECK("last_summarized_message_count" >= 0), "chat_suggestions_json" TEXT NOT NULL DEFAULT '[]', "injected_memory_hash" TEXT NULL, "last_memory_extracted_order" INTEGER NOT NULL DEFAULT -1 CHECK("last_memory_extracted_order" >= -1), "chat_model_provider" TEXT NULL, "chat_model_id" TEXT NULL, "extras_json" TEXT NOT NULL DEFAULT '{}', PRIMARY KEY ("id"));
-- table extension_entity_rows
CREATE TABLE "extension_entity_rows" ("kind" TEXT NOT NULL CHECK (kind IS NOT ''), "id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK (sort_order >= 0), "owner_id" TEXT NULL, "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY(kind, id));
-- table gc_audit_rows
CREATE TABLE "gc_audit_rows" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "kind" TEXT NOT NULL, "entity_id" TEXT NOT NULL, "completed_at" INTEGER NOT NULL);
-- table generation_run_rows
CREATE TABLE "generation_run_rows" ("id" TEXT NOT NULL, "conversation_id" TEXT NOT NULL REFERENCES conversation_rows (id) ON DELETE CASCADE, "target_revision_id" TEXT NOT NULL, "state" TEXT NOT NULL CHECK("state" IN ('preparing', 'requesting', 'streaming', 'waiting_tool', 'completed', 'failed', 'cancelled', 'interrupted')), "state_revision" INTEGER NOT NULL DEFAULT 0 CHECK("state_revision" >= 0), "checkpoint_seq" INTEGER NOT NULL DEFAULT 0 CHECK("checkpoint_seq" >= 0), "error_code" TEXT NULL, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, "terminal_at" INTEGER NULL, PRIMARY KEY ("id"), FOREIGN KEY (target_revision_id) REFERENCES message_rows (id) DEFERRABLE INITIALLY DEFERRED, CHECK (updated_at >= created_at), CHECK (terminal_at IS NULL OR terminal_at >= created_at), CHECK ((state IN ('preparing', 'requesting', 'streaming', 'waiting_tool') AND terminal_at IS NULL) OR (state IN ('completed', 'failed', 'cancelled', 'interrupted') AND terminal_at IS NOT NULL)), CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 128 AND state IN ('failed', 'cancelled', 'interrupted'))));
-- table instruction_injection_rows
CREATE TABLE "instruction_injection_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table mcp_server_rows
CREATE TABLE "mcp_server_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table memory_entry_rows
CREATE TABLE "memory_entry_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "scope" TEXT NOT NULL CHECK("scope" IN ('global', 'assistant')), "assistant_id" TEXT NULL, "type" TEXT NOT NULL CHECK("type" IN ('identity', 'workflow', 'voice', 'instruction')), "status" TEXT NOT NULL CHECK("status" IN ('active', 'archived')), "content" TEXT NOT NULL, "content_normalized" TEXT NOT NULL, "entry_created_at" INTEGER NOT NULL, "entry_updated_at" INTEGER NOT NULL, "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"), CHECK ((scope = 'global' AND assistant_id IS NULL) OR (scope = 'assistant' AND assistant_id IS NOT NULL)), CHECK (entry_updated_at >= entry_created_at));
-- table message_asset_rows
CREATE TABLE "message_asset_rows" ("conversation_id" TEXT NOT NULL, "revision_id" TEXT NOT NULL REFERENCES message_rows (id) ON DELETE CASCADE, "asset_id" TEXT NOT NULL REFERENCES asset_rows (id) ON DELETE CASCADE, "kind" TEXT NOT NULL CHECK("kind" IS NOT ''), PRIMARY KEY ("revision_id", "asset_id", "kind"));
-- table message_part_rows
CREATE TABLE "message_part_rows" ("part_id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "conversation_id" TEXT NOT NULL, "revision_id" TEXT NOT NULL, "ordinal" INTEGER NOT NULL CHECK("ordinal" >= 0), "kind" TEXT NOT NULL CHECK("kind" IS NOT ''), "payload" TEXT NOT NULL, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, UNIQUE ("revision_id", "ordinal"), FOREIGN KEY (revision_id) REFERENCES message_rows (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, CHECK (updated_at >= created_at));
-- table message_prompt_rows
CREATE TABLE "message_prompt_rows" ("revision_id" TEXT NOT NULL, "conversation_id" TEXT NOT NULL, "payload" TEXT NOT NULL, "carries_memory_snapshot" INTEGER NOT NULL DEFAULT 0 CHECK ("carries_memory_snapshot" IN (0, 1)), "created_at" INTEGER NOT NULL, PRIMARY KEY ("revision_id"), FOREIGN KEY (revision_id) REFERENCES message_rows (id) ON DELETE CASCADE);
-- table message_rows
CREATE TABLE "message_rows" ("id" TEXT NOT NULL, "conversation_id" TEXT NOT NULL REFERENCES conversation_rows (id) ON DELETE CASCADE, "role" TEXT NOT NULL CHECK("role" IS NOT ''), "timestamp" INTEGER NOT NULL, "model_id" TEXT NULL, "provider_id" TEXT NULL, "total_tokens" INTEGER NULL CHECK("total_tokens" >= 0), "is_streaming" INTEGER NOT NULL DEFAULT 0 CHECK ("is_streaming" IN (0, 1)), "reasoning_start_at" INTEGER NULL, "reasoning_finished_at" INTEGER NULL, "translation" TEXT NULL, "reasoning_segments_json" TEXT NULL, "group_id" TEXT NULL, "version" INTEGER NOT NULL DEFAULT 0 CHECK("version" >= 0), "prompt_tokens" INTEGER NULL CHECK("prompt_tokens" >= 0), "completion_tokens" INTEGER NULL CHECK("completion_tokens" >= 0), "cached_tokens" INTEGER NULL CHECK("cached_tokens" >= 0), "duration_ms" INTEGER NULL CHECK("duration_ms" >= 0), "message_order" INTEGER NOT NULL CHECK("message_order" >= 0), "updated_at" INTEGER NULL, "sender_id" TEXT NULL, "extras_json" TEXT NOT NULL DEFAULT '{}', PRIMARY KEY ("id"), UNIQUE ("conversation_id", "message_order"), UNIQUE ("conversation_id", "group_id", "version"));
-- table preference_rows
CREATE TABLE "preference_rows" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("key"));
-- table provider_artifact_rows
CREATE TABLE "provider_artifact_rows" ("conversation_id" TEXT NOT NULL, "revision_id" TEXT NOT NULL, "kind" TEXT NOT NULL CHECK("kind" IS NOT ''), "payload" TEXT NOT NULL, "created_at" INTEGER NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("revision_id", "kind"), FOREIGN KEY (revision_id) REFERENCES message_rows (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, CHECK (updated_at >= created_at));
-- table provider_group_rows
CREATE TABLE "provider_group_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table provider_rows
CREATE TABLE "provider_rows" ("provider_key" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("provider_key"));
-- table quick_phrase_rows
CREATE TABLE "quick_phrase_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table search_service_rows
CREATE TABLE "search_service_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table tombstone_rows
CREATE TABLE "tombstone_rows" ("scope" TEXT NOT NULL CHECK (scope IS NOT ''), "entity_id" TEXT NOT NULL CHECK (entity_id IS NOT ''), "deleted_at" INTEGER NOT NULL, "payload" TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(scope, entity_id));
-- table tts_service_rows
CREATE TABLE "tts_service_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table user_profile_field_rows
CREATE TABLE "user_profile_field_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- table world_book_rows
CREATE TABLE "world_book_rows" ("id" TEXT NOT NULL, "sort_order" INTEGER NOT NULL CHECK("sort_order" >= 0), "payload" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"));
-- index idx_assistant_memories_assistant
CREATE INDEX idx_assistant_memories_assistant ON assistant_memory_rows (assistant_id, id);
-- index idx_conversations_assistant
CREATE INDEX idx_conversations_assistant ON conversation_rows (assistant_id);
-- index idx_conversations_updated_at
CREATE INDEX idx_conversations_updated_at ON conversation_rows (updated_at DESC, id ASC);
-- index idx_extension_entities_kind_order
CREATE INDEX idx_extension_entities_kind_order ON extension_entity_rows (kind, sort_order);
-- index idx_generation_runs_active_target
CREATE UNIQUE INDEX idx_generation_runs_active_target ON generation_run_rows (conversation_id, target_revision_id) WHERE state IN ('preparing', 'requesting', 'streaming', 'waiting_tool');
-- index idx_generation_runs_state_updated
CREATE INDEX idx_generation_runs_state_updated ON generation_run_rows (state, updated_at, id);
-- index idx_memory_entries_dedupe
CREATE INDEX idx_memory_entries_dedupe ON memory_entry_rows (scope, assistant_id, type, content_normalized);
-- index idx_memory_entries_recent
CREATE INDEX idx_memory_entries_recent ON memory_entry_rows (status, type, entry_updated_at, id);
-- index idx_memory_entries_visible
CREATE INDEX idx_memory_entries_visible ON memory_entry_rows (status, type, scope, assistant_id);
-- index idx_message_assets_asset
CREATE INDEX idx_message_assets_asset ON message_asset_rows (asset_id, revision_id);
-- index idx_message_parts_revision_ordinal
CREATE INDEX idx_message_parts_revision_ordinal ON message_part_rows (conversation_id, revision_id, ordinal);
-- index idx_message_prompts_conversation_snapshot
CREATE INDEX idx_message_prompts_conversation_snapshot ON message_prompt_rows (conversation_id, carries_memory_snapshot);
-- index idx_message_rows_streaming
CREATE INDEX idx_message_rows_streaming ON message_rows (id) WHERE is_streaming = 1;
-- index idx_messages_conversation_order
CREATE INDEX idx_messages_conversation_order ON message_rows (conversation_id, message_order, id);
-- index idx_messages_conversation_timestamp
CREATE INDEX idx_messages_conversation_timestamp ON message_rows (conversation_id, timestamp, id);
-- index idx_messages_group
CREATE INDEX idx_messages_group ON message_rows (conversation_id, group_id, version, id);
-- index idx_provider_artifacts_revision_kind
CREATE INDEX idx_provider_artifacts_revision_kind ON provider_artifact_rows (conversation_id, revision_id, kind);
`;
