// media-generation/capabilities.ts — B3.2 能力矩阵（唯一事实源）
// 描述「适配器能接受什么」，不是「某个模型一定支持」。UI 只展示矩阵内参数；
// 提交前按矩阵裁剪，必填缺失直接报错。

import type { MediaGenerationProviderType } from "../foundation/types/settings";
import type { MediaImageRole, MediaKind } from "./types";

export type MediaParam =
  | "count"
  | "resolution"
  | "aspectRatio"
  | "durationSeconds"
  | "generateAudio"
  | "watermark"
  | "seed"
  | "promptEnhancement";

export interface MediaCapability {
  params: MediaParam[];
  required: MediaParam[];
  imageRoles: MediaImageRole[];
  videoInput: boolean;
  audioInput: boolean;
  /** 首尾帧与参考图互斥（多数视频接口）。 */
  framesExcludeReferences: boolean;
  requiresPrompt: boolean;
  /** 本地素材必须有公网地址（视频类接口普遍如此），需要 uploadS3Config。 */
  requiresRemoteInputs: boolean;
}

const IMAGE_REFERENCE_ONLY: MediaImageRole[] = ["reference"];
const IMAGE_ALL_ROLES: MediaImageRole[] = ["reference", "first_frame", "last_frame"];

const OPENAI_IMAGE: MediaCapability = {
  params: ["count", "resolution"],
  required: [],
  imageRoles: IMAGE_REFERENCE_ONLY,
  videoInput: false,
  audioInput: false,
  framesExcludeReferences: false,
  requiresPrompt: true,
  requiresRemoteInputs: false,
};

const ALIYUN_IMAGE: MediaCapability = {
  params: ["count", "resolution", "watermark", "seed", "promptEnhancement"],
  required: [],
  imageRoles: IMAGE_REFERENCE_ONLY,
  videoInput: false,
  audioInput: false,
  framesExcludeReferences: false,
  requiresPrompt: true,
  requiresRemoteInputs: false,
};

const ALIYUN_VIDEO: MediaCapability = {
  params: ["resolution", "aspectRatio", "durationSeconds", "generateAudio", "watermark", "seed", "promptEnhancement"],
  required: [],
  imageRoles: IMAGE_ALL_ROLES,
  videoInput: true,
  audioInput: true,
  framesExcludeReferences: true,
  requiresPrompt: false,
  requiresRemoteInputs: true,
};

const VOLCENGINE_IMAGE: MediaCapability = {
  params: ["resolution", "watermark"],
  required: [],
  imageRoles: IMAGE_REFERENCE_ONLY,
  videoInput: false,
  audioInput: false,
  framesExcludeReferences: false,
  requiresPrompt: true,
  requiresRemoteInputs: false,
};

const VOLCENGINE_VIDEO: MediaCapability = {
  params: ["resolution", "aspectRatio", "durationSeconds", "generateAudio", "watermark", "seed"],
  required: [],
  imageRoles: IMAGE_ALL_ROLES,
  videoInput: true,
  audioInput: true,
  framesExcludeReferences: true,
  requiresPrompt: false,
  requiresRemoteInputs: true,
};

const MINIMAX_VIDEO: MediaCapability = {
  params: ["resolution", "aspectRatio", "durationSeconds", "watermark"],
  required: ["resolution", "aspectRatio", "durationSeconds"],
  imageRoles: IMAGE_ALL_ROLES,
  videoInput: true,
  audioInput: true,
  framesExcludeReferences: true,
  requiresPrompt: true,
  requiresRemoteInputs: true,
};

const OPENROUTER_IMAGE: MediaCapability = {
  params: ["count", "resolution", "aspectRatio", "seed"],
  required: [],
  imageRoles: IMAGE_REFERENCE_ONLY,
  videoInput: false,
  audioInput: false,
  framesExcludeReferences: false,
  requiresPrompt: true,
  requiresRemoteInputs: false,
};

const OPENROUTER_VIDEO: MediaCapability = {
  params: ["resolution", "aspectRatio", "durationSeconds", "generateAudio", "seed"],
  required: [],
  imageRoles: IMAGE_ALL_ROLES,
  videoInput: true,
  audioInput: true,
  framesExcludeReferences: true,
  requiresPrompt: false,
  requiresRemoteInputs: true,
};

export const MEDIA_CAPABILITIES: Record<MediaGenerationProviderType, Partial<Record<MediaKind, MediaCapability>>> = {
  openai: { image: OPENAI_IMAGE },
  aliyun: { image: ALIYUN_IMAGE, video: ALIYUN_VIDEO },
  volcengine: { image: VOLCENGINE_IMAGE, video: VOLCENGINE_VIDEO },
  minimax: { video: MINIMAX_VIDEO },
  openrouter: { image: OPENROUTER_IMAGE, video: OPENROUTER_VIDEO },
};

export function mediaCapability(type: MediaGenerationProviderType, kind: MediaKind): MediaCapability | null {
  return MEDIA_CAPABILITIES[type][kind] ?? null;
}

export function supportsMediaKind(type: MediaGenerationProviderType, kind: MediaKind): boolean {
  return mediaCapability(type, kind) !== null;
}
