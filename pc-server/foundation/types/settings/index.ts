import type { AppConfig } from "./app-config";
import type { ImAccessSlice } from "./im-access";
import type { MediaGenerationConfig } from "./media-generation-config";
import type { MemoryConfig } from "./memory-config";
import type { MemoryExperimentConfig } from "./memory-experiment-config";
import type { MemoryVectorConfig } from "./memory-vector-config";
import type { ModelConfig } from "./model-config";
import type { ModelLayerConfig } from "./model-layer";
import type { PromptConfig } from "./prompt-config";
import type { NetworkConfig } from "./proxy-config";
import type { SearchConfig } from "./search-config";
import type { SshConfig } from "./ssh-config";
import type { StorageConfig } from "./storage-config";
import type { SubagentConfig } from "./subagent-config";
import type { ToolConfig } from "./tool-config";
import type { VoiceConfig } from "./voice-config";

/** 聚合 Settings 接口。state.json 的序列化格式由它保证，新增/拆分 slice 时不可删除或重命名字段。 */
export interface Settings
  extends AppConfig,
    ModelConfig,
    PromptConfig,
    SearchConfig,
    VoiceConfig,
    ModelLayerConfig,
    ToolConfig,
    StorageConfig,
    NetworkConfig,
    MemoryConfig,
    MemoryVectorConfig,
    MemoryExperimentConfig,
    SshConfig,
    ImAccessSlice,
    MediaGenerationConfig {
  /** PC-only：子智能体派遣设置（见 subagent-config.ts）。导出安卓备份时剥离。 */
  subagent: SubagentConfig;
}

export type * from "./app-config";
export type * from "./im-access";
export type * from "./media-generation-config";
export type * from "./memory-config";
export type * from "./memory-experiment-config";
export type * from "./memory-vector-config";
export type * from "./model-config";
export type * from "./model-layer";
export type * from "./prompt-config";
export type * from "./proxy-config";
export type * from "./search-config";
export type * from "./ssh-config";
export type * from "./storage-config";
export type * from "./subagent-config";
export type * from "./tool-config";
export type * from "./voice-config";
