// 上传文件的类型检测(纯逻辑,无 UI/store 依赖,可单测)。
// magic bytes 优先,识别不了退回扩展名;安全立场:二进制必须能证明身份才放行,
// 文本类(嗅探不出 magic bytes)一律按文本放行。
import { fileTypeFromBuffer } from "file-type";

// zip 容器类文档:magic bytes 只能证明"是 zip",具体格式由扩展名兜底判定。
const ZIP_CONTAINER_MIME_BY_EXTENSION: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".epub": "application/epub+zip",
};

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

// 专题4:与 DOCUMENT_UPLOAD_ACCEPT 同步收敛——只放行有后端解析器的文档格式。
const ALLOWED_DOCUMENT_MIMES = new Set([
  "application/pdf",
  ...Object.values(ZIP_CONTAINER_MIME_BY_EXTENSION),
]);

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}

export async function detectUploadFile(
  file: globalThis.File,
): Promise<{ allowed: boolean; mimeType: string }> {
  const extension = extensionOf(file.name);
  const buffer = await file.slice(0, 4100).arrayBuffer();
  const detected = await fileTypeFromBuffer(buffer);

  // 无法识别 magic bytes → 文本文件 → 允许，强制 text/plain 防止 OS MIME 映射污染（如 .ts → video/mp2t）
  if (!detected)
    return { allowed: true, mimeType: DOCUMENT_MIME_BY_EXTENSION[extension] ?? "text/plain" };

  // 识别为图片 / 视频 / 音频 → 允许，使用 magic bytes 检测到的 MIME
  if (
    detected.mime.startsWith("image/") ||
    detected.mime.startsWith("video/") ||
    detected.mime.startsWith("audio/")
  ) {
    return { allowed: true, mimeType: detected.mime };
  }

  if (ALLOWED_DOCUMENT_MIMES.has(detected.mime)) {
    return { allowed: true, mimeType: detected.mime };
  }
  // 专题4-issue修复:docx/pptx/epub 本质都是 zip 容器,file-type 只嗅探前 4100 字节。
  // 某些生成器(WPS、导出工具)把大条目(缩略图/自定义XML)排在包首,[Content_Types].xml
  // 被挤出嗅探窗,检测退化成 application/zip,曾被下面的白名单误拒("格式不支持已跳过")。
  // zip 家族 + 已知容器扩展名 → 信任扩展名放行;真伪由后端 zip 中央目录解析裁决
  // (伪造的解析结果为空,走降级占位文案,不会出错)。
  if (detected.mime === "application/zip" && ZIP_CONTAINER_MIME_BY_EXTENSION[extension]) {
    return { allowed: true, mimeType: ZIP_CONTAINER_MIME_BY_EXTENSION[extension] };
  }

  // 其他可识别的二进制格式（exe、zip 等）→ 拒绝
  return { allowed: false, mimeType: detected.mime };
}
