// 注意:xml 不映射到 html——XML 塞进 html iframe 只会渲染出标签被吞的文本浆糊。
// 代码块完成后会"自动切预览",错误的映射会直接把乱码怼到用户脸上,xml 只看源码。
const CODE_PREVIEW_LANGUAGE_ALIASES: Record<string, string> = {
  html: "html",
  htm: "html",
  svg: "svg",
  md: "markdown",
  markdown: "markdown",
  mermaid: "mermaid",
  mmd: "mermaid",
};

const SUPPORTED_CODE_PREVIEW_LANGUAGES = new Set(Object.keys(CODE_PREVIEW_LANGUAGE_ALIASES));

export function getCodePreviewLanguage(language: string): string | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized || !SUPPORTED_CODE_PREVIEW_LANGUAGES.has(normalized)) {
    return null;
  }

  return CODE_PREVIEW_LANGUAGE_ALIASES[normalized] ?? null;
}
