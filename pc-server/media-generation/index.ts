// media-generation/index.ts — 特性 B 媒体生成模块的公开面
// 边界：本模块只负责「供应商协议 + 任务生命周期 + 落盘 + 恢复」。工具层、审批与 HTTP
// 端点在外部分别位于 tools/、api/handlers/。

export type {
  GenerateMediaOptions,
  MediaGenerationResult,
  MediaProgress,
  SavedMediaOutput,
} from "./service";
export {
  cancelMediaGeneration,
  generateMedia,
  isMediaRecordCancelled,
  resumeMediaGeneration,
  startMediaGeneration,
  withMediaConversationLock,
} from "./service";
export { resumePendingMediaTasks } from "./resume";
export { MEDIA_CAPABILITIES, mediaCapability, type MediaCapability, type MediaParam } from "./capabilities";
export {
  defaultMediaRefFor,
  findMediaTarget,
  listAllMediaModels,
  listConfiguredMediaModels,
  mediaProviderBaseUrl,
  mediaProviderReady,
  resolveMediaTarget,
  type ResolvedMediaTarget,
} from "./config";
export { publishInputToS3, uploadS3Config, uploadS3MissingMessage } from "./s3-upload";
export { fetchMediaProviderModels, inferMediaKind, parseMediaModelList } from "./model-list";
export { mediaFileUrl } from "./storage";
export type {
  MediaGenerationOutput,
  MediaGenerationRequest,
  MediaGenerationTask,
  MediaImageRole,
  MediaInput,
  MediaKind,
  MediaTaskStatus,
} from "./types";
export { MediaGenerationApiError, MediaGenerationCancelledError } from "./types";
