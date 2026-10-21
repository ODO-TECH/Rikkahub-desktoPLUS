import { appendWebAuthQuery } from "~/services/api";

/**
 * Convert file URL to a loadable form.
 * - data: / http(s) URLs are returned as-is
 * - /api/... URLs get the web-auth query appended
 * - Anything else is returned as-is. 后端不存在按路径取文件的端点——历史版本曾把安卓
 *   file:///…/upload/<name> 引用映射到虚构的 /api/files/path/,注定 404;这类引用现已
 *   由服务端在导入与加载时改写为 /api/files/<id>/content(专题3 H-1),前端无需兜底。
 */
export function resolveFileUrl(url: string): string {
  if (url.startsWith("/api/")) {
    return appendWebAuthQuery(url);
  }
  if (url.startsWith("api/")) {
    return appendWebAuthQuery(`/${url}`);
  }
  return url;
}
