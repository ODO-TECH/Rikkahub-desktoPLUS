import type { S3Config } from "..";

/** 外挂媒体供应商类型。字段名与移动端 3.1.0 的媒体供应商设置保持一致，便于整包互通。 */
export type MediaGenerationProviderType =
  | "openai"
  | "aliyun"
  | "volcengine"
  | "minimax"
  | "openrouter";

export type MediaKind = "image" | "video";

export interface MediaGenerationModel {
  modelId: string;
  kind: MediaKind;
}

export interface MediaGenerationProviderConfig {
  id: string;
  type: MediaGenerationProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  /** 仅 aliyun：替换 baseUrl 里的 {WorkspaceId}。 */
  workspaceId?: string;
  models: MediaGenerationModel[];
}

/** 媒体模型引用（媒体工作台指向某供应商下的某模型）。 */
export interface MediaModelRef {
  providerId: string;
  modelId: string;
}

export interface MediaGenerationConfig {
  mediaGenerationProviders: MediaGenerationProviderConfig[];
  /** 媒体参考素材上传桶，与备份 s3Config 分离（对齐移动端）。 */
  uploadS3Config: S3Config | null;
  /** 新会话默认选择；桌面独有，移动端会忽略未知字段。 */
  defaultMediaImageModel?: MediaModelRef | null;
  defaultMediaVideoModel?: MediaModelRef | null;
  /** 媒体工作台「优化提示词」专用模型(PC 独有,APP 无此字段导出时被忽略)。
   *  指向 provider.models 里带视觉输入的 CHAT 模型;空串 = 未配置。 */
  mediaPromptRewriteModelId: string;
}
