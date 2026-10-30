// tools/mcp-builtin-fetch.ts — 内置 @rikkahub/fetch 工具的执行体
//
// 定位：与 search_web / scrape_web 互补的「按 URL 取原文」。scrape_web 依赖已配置的搜索
// 服务、且把正文一刀切到 12000 字符；本工具不依赖任何供应商，默认把 HTML 收敛成正文
// Markdown，超长内容用 start_index 续读（对齐 Kelivo 的 @kelivo/fetch 契约）。
//
// 纪律：不读写 state，不依赖 api 层；日志由调用方（mcp.ts 的内置分支）统一记录。
//
// 安全边界：RDP 自己的 API 监听 127.0.0.1 且默认无需鉴权，而本工具允许 POST ——「让模型
// 抓一个链接」因此可以是「让模型改写本机设置、再经 stdio MCP 落地成命令执行」。所以出站
// 前拒绝回环/链路本地/云元数据地址，并对每一跳重定向重新校验。
// 已知残余风险：不做 DNS 固定（域名解析到 127.0.0.1 的 rebinding 仍可能绕过字面判定）。

import type { JsonValue } from "../foundation/types";
import { fetchWithTimeout } from "../foundation/net";
import { htmlToReadable } from "../foundation/html-to-markdown";
import { formatKeyLocal, isRecord } from "../foundation/utils";

/** 模型侧看到的工具名（mcp.ts 会加 `mcp__` 前缀），续读提示要引用它，改名必须同步。 */
export const BUILTIN_FETCH_TOOL_NAME = "fetch";

const DEFAULT_MAX_LENGTH = 5_000;
const MAX_LENGTH_LIMIT = 20_000;
/** 下载字节上限：模型要 2 万字，页面可能几兆；读满即断，避免拖垮内存与超时预算。 */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const SUPPORTED_METHODS = ["GET", "POST"] as const;

/** 工具内部的「可解释失败」：转成 isError 的 MCP 结果回灌模型，而不是 JSON-RPC 层报错。 */
class FetchRefused extends Error {}

export function builtinFetchToolDefinition(): Record<string, JsonValue> {
  return {
    name: BUILTIN_FETCH_TOOL_NAME,
    description: `Fetch the content of one web page or API endpoint.
Only fetch a URL that already appears in the conversation: given by the user or returned by a previous search/fetch. This tool cannot reach anything behind a login wall.
HTML is converted to readable Markdown of the main content by default; JSON responses are re-serialised compactly. Set raw=true only when the exact source is required.
Output is bounded by max_length. When it is truncated, continue with start_index (GET only) or raise max_length.
method=POST calls an API endpoint the user asked for; a POST response cannot be continued with start_index, so raise max_length if it was truncated.
Local addresses (localhost, 127.x, 169.254.x, cloud metadata) are refused.
Today is ${formatKeyLocal(new Date())}.`.trim(),
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL including the scheme, exactly as given: https://example.com is valid, example.com is not.",
        },
        method: {
          type: "string",
          enum: [...SUPPORTED_METHODS],
          default: "GET",
          description: "GET to read a page; POST only to an API endpoint the user explicitly asked you to call.",
        },
        headers: {
          type: "object",
          description: "Optional extra request headers.",
        },
        body: {
          type: "string",
          description: "Request body for POST, sent as UTF-8. A JSON object is accepted and encoded for you; Content-Type defaults to application/json.",
        },
        max_length: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LENGTH_LIMIT,
          default: DEFAULT_MAX_LENGTH,
          description: "Maximum characters of content to return.",
        },
        start_index: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Character offset used to continue truncated content; GET only.",
        },
        raw: {
          type: "boolean",
          default: false,
          description: "Return the raw source instead of compact Markdown.",
        },
      },
      required: ["url"],
    },
  };
}

interface FetchRequest {
  readonly url: URL;
  method: (typeof SUPPORTED_METHODS)[number];
  body: string | null;
  headers: Record<string, string>;
  maxLength: number;
  startIndex: number;
  raw: boolean;
}

function integerArg(value: JsonValue | undefined, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  throw new FetchRefused(`Invalid ${name}: expected an integer`);
}

function charsetOf(contentType: string): string {
  return contentType.match(/charset\s*=\s*"?([\w-]+)/i)?.[1]?.toLowerCase() ?? "";
}

/** 参数解析逐条对齐 Kelivo 的 KelivoFetchRequestPayload.parse：拒绝而不是静默纠正，
 *  让模型在 tool_result 里看到自己写错的那一项。 */
function parseFetchRequest(args: Record<string, JsonValue>): FetchRequest {
  const rawUrl = String(args.url ?? "").trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchRefused(`Invalid url: ${rawUrl || "(empty)"} — include http:// or https://`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused(`Invalid url scheme: ${url.protocol}`);

  const methodRaw = args.method === undefined || args.method === null ? "GET" : String(args.method).trim().toUpperCase();
  if (!SUPPORTED_METHODS.includes(methodRaw as (typeof SUPPORTED_METHODS)[number])) {
    throw new FetchRefused(`Invalid method: ${methodRaw || "(empty)"} is not supported; expected GET or POST`);
  }
  const method = methodRaw as (typeof SUPPORTED_METHODS)[number];

  const headers: Record<string, string> = {};
  if (isRecord(args.headers)) {
    for (const [key, value] of Object.entries(args.headers)) {
      const name = key.trim();
      if (name) headers[name] = String(value ?? "");
    }
  }

  let body: string | null = null;
  if (args.body !== undefined && args.body !== null) {
    if (typeof args.body === "string") body = args.body;
    else if (Array.isArray(args.body) || isRecord(args.body)) body = JSON.stringify(args.body);
    // 数字/布尔同样是「一个 JSON 值」：API 接收裸 true / 42 合法，原样转字符串送出去。
    else if (typeof args.body === "number" || typeof args.body === "boolean") body = String(args.body);
    else throw new FetchRefused("Invalid body: expected a string or a JSON value");
  }
  if (body !== null && method !== "POST") throw new FetchRefused("Invalid body: only POST requests can carry a body");
  if (body !== null) {
    const contentTypeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
    if (!contentTypeKey) headers["Content-Type"] = "application/json; charset=utf-8";
    else {
      // 请求体按 UTF-8 编码发出，声明别的字符集等于悄悄撒谎而不是转码。
      const declared = charsetOf(headers[contentTypeKey]);
      if (declared && declared !== "utf-8" && declared !== "utf8") {
        throw new FetchRefused(`Invalid headers: request bodies are sent as UTF-8, so Content-Type cannot declare charset=${declared}`);
      }
    }
  }

  const maxLength = integerArg(args.max_length, "max_length", DEFAULT_MAX_LENGTH);
  if (maxLength < 1 || maxLength > MAX_LENGTH_LIMIT) {
    throw new FetchRefused(`Invalid max_length: expected a value from 1 to ${MAX_LENGTH_LIMIT}`);
  }
  const startIndex = integerArg(args.start_index, "start_index", 0);
  if (startIndex < 0) throw new FetchRefused("Invalid start_index: expected a non-negative value");
  if (startIndex > 0 && method !== "GET") {
    // 续读要重放整个请求，而 POST 可能再建一次资源或再扣一次费。
    throw new FetchRefused(`Invalid start_index: a ${method} response cannot be continued because that would repeat the request; raise max_length instead`);
  }
  if (args.raw !== undefined && args.raw !== null && typeof args.raw !== "boolean") {
    throw new FetchRefused("Invalid raw: expected a boolean");
  }
  return { url, method, body, headers, maxLength, startIndex, raw: args.raw === true };
}

// ── 出站目的地守卫 ────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata", "169.254.169.254", "100.100.100.200"]);

function isBlockedAddress(address: string): boolean {
  // URL 解析会把 2130706433 / 0x7f000001 / 127.1 这类写法统一成点分十进制，
  // 所以这里只需覆盖规范形态。
  const host = address.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host.startsWith("127.")) return true; // 127.0.0.0/8 整段回环
  if (host.startsWith("169.254.")) return true; // 链路本地 + 各家云元数据
  if (host === "0.0.0.0" || host === "::" || host === "") return true;
  const ipv6 = host.includes(":");
  if (ipv6) {
    // ::ffff:127.0.0.1 这类 IPv4 映射形态按末段 IPv4 判定。
    const mapped = host.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1];
    if (mapped) return isBlockedAddress(mapped);
    if (/^::1$/.test(host)) return true;
    if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true; // fe80::/10 链路本地、fc00::/7 唯一本地
  }
  return false;
}

/** 域名形态额外解析一次，任一记录落在被拒段就整体拒绝。异步查找只用于「拦」：
 *  解析失败一律放行，交由 fetch 自己报错——离线/内网 DNS 环境不能因为探针失败误伤正常站点。 */
async function assertPublicDestination(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || isBlockedAddress(hostname)) {
    throw new FetchRefused(`Refused to fetch ${url.origin}: this tool cannot reach local or link-local addresses (the app's own API listens on this machine)`);
  }
  if (/^\d+(\.\d+){3}$/.test(hostname) || hostname.includes(":")) return;
  let records: Array<Bun.DNSLookup>;
  try {
    records = await Bun.dns.lookup(hostname);
  } catch {
    return;
  }
  const hit = records.find((record) => isBlockedAddress(record.address));
  if (hit) throw new FetchRefused(`Refused to fetch ${url.origin}: '${hostname}' resolves to ${hit.address}, a local or link-local address`);
}

// ── 取回与解码 ────────────────────────────────────────────────

interface FetchedResponse {
  status: number;
  contentType: string;
  finalUrl: string;
  text: string;
}

/** 手动跟随重定向：默认 follow 会让 302 → http://127.0.0.1:17455 绕过入口校验。 */
async function fetchFollowed(request: FetchRequest): Promise<FetchedResponse> {
  let target = request.url;
  for (let hop = 0; ; hop++) {
    await assertPublicDestination(target);
    const response = await fetchWithTimeout(target.href, {
      method: request.method,
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en",
        ...request.headers,
      },
      ...(request.body !== null ? { body: request.body } : {}),
      redirect: "manual",
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new FetchRefused(`Too many redirects (>${MAX_REDIRECTS}) at ${target.origin}`);
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new FetchRefused(`Invalid redirect Location '${location}' from ${target.origin}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new FetchRefused(`Redirect targets unsupported scheme: ${next.protocol}`);
      // 301/302/303 按惯例把 POST 降级为 GET（与浏览器一致），307/308 保留方法与请求体。
      if (next.hostname !== target.hostname) stripSensitiveHeaders(request);
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        request.method = "GET";
        request.body = null;
      }
      target = next;
      continue;
    }
    const bytes = await readCappedBytes(response);
    const contentType = response.headers.get("content-type") ?? "";
    return {
      status: response.status,
      contentType: contentType.toLowerCase(),
      finalUrl: target.href,
      text: decodeBody(bytes, contentType),
    };
  }
}

/** 重定向跨站时丢掉 Authorization/Cookie，避免凭据被第三方收割（fetch 默认也会丢，
 *  但这里是 manual 重定向，得自己处理）。 */
function stripSensitiveHeaders(request: FetchRequest): void {
  for (const key of Object.keys(request.headers)) {
    if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete request.headers[key];
  }
}

async function readCappedBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const room = MAX_DOWNLOAD_BYTES - kept;
    if (value.length > room) {
      // 超限不再等待：按剩余额度收下这一片就断开，留下正文给截断提示兜底。
      if (room > 0) {
        chunks.push(value.slice(0, room));
        kept += room;
      }
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    kept += value.length;
  }
  const merged = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** 无声明字符集时按 UTF-8 严格解码，失败再用 <meta charset> 嗅探——多数页面把字符集
 *  写在 meta 而非响应头，直接 latin1 会把中文变成乱码。 */
function decodeBody(bytes: Uint8Array, declaredContentType: string): string {
  const headerCharset = charsetOf(declaredContentType);
  if (headerCharset) return tryDecode(headerCharset, bytes) ?? lossyUtf8(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const sniffed = sniffMetaCharset(bytes);
    return (sniffed ? tryDecode(sniffed, bytes) : null) ?? lossyUtf8(bytes);
  }
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

function lossyUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function sniffMetaCharset(bytes: Uint8Array): string {
  // 前 2KB 用 latin1 取回字节形态即可匹配 ASCII 的 charset 声明。
  const head = new TextDecoder("windows-1252").decode(bytes.slice(0, 2048));
  return head.match(/<meta[^>]+charset\s*=\s*"?([\w-]+)/i)?.[1]?.toLowerCase() ?? "";
}

/** 抓取网页要能过 Cloudflare 之类的 UA 白名单，品牌 UA（RikkaHub-Desktop/x）会被拒。
 *  与 search/index.ts 的爬取同理，这里用 Chrome 桌面串；用户自配的 UA 不归本工具管。 */
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── 正文加工 ──────────────────────────────────────────────────

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) return true;
  if (contentType) return false;
  return /<\s*(?:!doctype\s+html|html)\b/i.test(text.slice(0, 256));
}

const TEXTUAL_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/xhtml", "application/javascript", "application/x-javascript", "image/svg+xml"];

function isProbablyBinary(contentType: string, text: string): boolean {
  if (!contentType) return false;
  if (TEXTUAL_MIME_PREFIXES.some((prefix) => contentType.includes(prefix))) return false;
  // 未列出的类型仍给一次机会：控制字符比例过高才判成二进制。
  const head = text.slice(0, 512);
  if (!head) return true;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) control++;
  }
  return control / head.length > 0.1;
}

/** 页内相对链接按最终地址绝对化，模型据此能直接 fetch 下一跳；重定向后以落地 URL 为准。 */
function toModelText(text: string, contentType: string, baseUrl: string, raw: boolean): string {
  if (raw) return text;
  if (looksLikeHtml(text, contentType)) {
    const readable = htmlToReadable(text, baseUrl);
    const markdown = readable.markdown.trim();
    if (markdown) return readable.title ? `Title: ${readable.title}\n\n${markdown}` : markdown;
    return text.trim();
  }
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      // 畸形/类 JSON 响应原样保留，不把 fetch 整体判失败。
    }
  }
  return text.trim();
}

/** 代理式切片：断点绝不能落在代理对中间，否则模型看到的是半个 emoji。 */
function boundText(text: string, request: FetchRequest): string {
  if (request.startIndex >= text.length) return "No more content available.";
  let start = request.startIndex;
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  let end = Math.min(start + request.maxLength, text.length);
  if (end < text.length && end > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end = end - start === 1 ? end + 1 : end - 1;
  }
  const content = text.slice(start, end);
  if (end >= text.length) return content;
  const shown = `[Content truncated: showing characters ${start}-${end - 1} of ${text.length}.`;
  if (request.method !== "GET") {
    return `${content}\n\n${shown} Raise max_length to see more; a ${request.method} cannot be continued with start_index.]`;
  }
  return `${content}\n\n${shown} Call ${BUILTIN_FETCH_TOOL_NAME} with start_index=${end} to continue.]`;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function toolResult(text: string, isError: boolean): Record<string, JsonValue> {
  return { content: [{ type: "text", text }], isStreaming: false, isError };
}

/** 工具调用总入口：所有失败都以 isError 的 MCP 结果返回，与真实 MCP 服务器的语义一致
 *  （mcp.ts 的失败诊断层只在抛异常时介入，这里刻意不抛）。 */
export async function runBuiltinFetchTool(args: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
  let request: FetchRequest;
  try {
    request = parseFetchRequest(args);
  } catch (err) {
    return toolResult(err instanceof Error ? err.message : String(err), true);
  }
  try {
    const response = await fetchFollowed(request);
    if (isProbablyBinary(response.contentType, response.text)) {
      return toolResult(`Cannot read this response as text (${response.contentType || "unknown type"}). This tool returns text only.`, true);
    }
    const text = toModelText(response.text, response.contentType, response.finalUrl, request.raw);
    if (response.status < 200 || response.status >= 300) {
      // 自定义 API 把错误详情放在 4xx/5xx 的响应体里，状态和正文要一起回传。
      const detail = boundText(text, request).trim();
      return toolResult(detail ? `HTTP ${response.status}\n\n${detail}` : `HTTP ${response.status}`, true);
    }
    return toolResult(boundText(text, request), false);
  } catch (err) {
    return toolResult(err instanceof Error ? err.message : String(err), true);
  }
}
