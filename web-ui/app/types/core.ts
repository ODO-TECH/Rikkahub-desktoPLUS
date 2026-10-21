/**
 * Message role enum (前端内部模型用小写;线上 DTO 的 role 是后端大写枚举)
 * @see ai/src/main/java/me/rerere/ai/core/MessageRole.kt
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

// FE-P1-2:TokenUsage 属线上契约,单源在后端 foundation/types/dto.ts(type-only re-export)。
export type { TokenUsage } from "@server/foundation/types/dto";
