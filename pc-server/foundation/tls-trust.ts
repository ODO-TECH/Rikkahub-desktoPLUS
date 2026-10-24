// foundation/tls-trust.ts — 证书校验失败时用 Windows 证书库兜底
//
// 为什么需要:Bun 的 TLS 只认内置根证书,不读 Windows 根存储。桌面用户装了 HTTPS
// 拦截类工具后(Steam++ / Watt Toolkit 的「GitHub 加速」、企业代理、杀软的 SSL 扫描),
// 被接管域名的证书由工具的根 CA 签发:Chrome / Edge / curl.exe 走 Schannel 与系统证书库
// 一切正常,只有 Bun 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE——用户看到「检查更新失败:无法
// 连接 GitHub」,而同一台机器上浏览器能打开同一个地址。
//
// 处理:默认仍按 Bun 内置根证书校验;只有请求确实因证书校验失败时,才导出一次系统根证书
// 并重试。信任范围与 Windows 原生应用一致,没有整体关闭校验,也没有信任内置根之外的东西。

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";
import { RUNTIME_PLATFORM } from "./platform";

/** 导出结果的缓存。24h 过期:新装/卸载拦截工具能在一轮内被发现,又不必每次失败都起 PowerShell。 */
const CACHE_PATH = join(dataDir, "certificates", "windows-roots.pem");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CERT_ERROR_PATTERN =
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|unable to verify|self[- ]signed|certificate/i;

/** 只认"证书链/信任"类失败。网络不可达、超时、HTTP 4xx 一律不算——重试也换不来结果。 */
export function isCertificateError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CERT_ERROR_PATTERN.test(`${code} ${message}`);
}

function readCachedBundle(maxAgeMs: number): string | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    if (maxAgeMs > 0 && Date.now() - statSync(CACHE_PATH).mtimeMs >= maxAgeMs) return null;
    const text = readFileSync(CACHE_PATH, "utf8");
    return text.includes("BEGIN CERTIFICATE") ? text : null;
  } catch {
    return null;
  }
}

// PowerShell 5.1 在受支持的 Windows 上都在;-NoProfile/-NonInteractive 避免启动脚本与交互
// 提示拖慢或卡住。导出失败(PowerShell 被策略禁用等)只是拿不到兜底,不影响主流程。
async function exportWindowsRootStore(): Promise<string | null> {
  const target = CACHE_PATH.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sb=New-Object System.Text.StringBuilder",
    "Get-ChildItem Cert:\\LocalMachine\\Root | ForEach-Object {",
    "[void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')",
    "[void]$sb.AppendLine([Convert]::ToBase64String($_.RawData,'InsertLineBreaks'))",
    "[void]$sb.AppendLine('-----END CERTIFICATE-----')}",
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${target}') | Out-Null`,
    `[IO.File]::WriteAllText('${target}',$sb.ToString())`,
  ].join("; ");
  try {
    const proc = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await proc.exited) !== 0) return null;
  } catch {
    return null;
  }
  return readCachedBundle(0);
}

/**
 * 先按 Bun 内置根证书请求；仅当失败属于证书链/信任问题时，改用系统根证书重试一次。
 * fetchOnce 接收可选的 tls 选项，其余参数(超时、signal、头)由调用方闭包决定——
 * 更新检查和更新包下载的超时策略不同，不能共用同一个 fetch 包装。
 */
export async function fetchWithSystemRoots(
  fetchOnce: (tls?: { ca: string }) => Promise<Response>,
): Promise<Response> {
  try {
    return await fetchOnce();
  } catch (err) {
    if (!isCertificateError(err)) throw err;
    const ca = await getWindowsRootCaBundle();
    if (!ca) throw err;
    console.warn("[tls] 证书校验失败，改用系统证书库重试");
    return await fetchOnce({ ca });
  }
}

let cachedBundle: { text: string; at: number } | null = null;

/** 系统根证书 PEM;非 Windows 或导出失败返回 null。调用方应只在证书校验失败后才调。 */
export async function getWindowsRootCaBundle(): Promise<string | null> {
  if (RUNTIME_PLATFORM !== "win") return null;
  if (cachedBundle && Date.now() - cachedBundle.at < CACHE_TTL_MS) return cachedBundle.text;

  const fresh = readCachedBundle(CACHE_TTL_MS);
  if (fresh) {
    cachedBundle = { text: fresh, at: Date.now() };
    return fresh;
  }

  const exported = await exportWindowsRootStore();
  if (exported) {
    cachedBundle = { text: exported, at: Date.now() };
    return exported;
  }

  // 导出失败时宁可退回过期缓存:证书旧一点也比完全没有强。
  const stale = readCachedBundle(0);
  if (stale) {
    cachedBundle = { text: stale, at: Date.now() };
    return stale;
  }
  return null;
}
