// updates/index.ts — 应用更新检查与下载
// 纪律：负责版本检查、下载源、缓存扫描，不依赖业务状态。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fetchWithTimeout, type FetchWithTimeoutInit } from "../foundation/net";
import { fetchWithSystemRoots } from "../foundation/tls-trust";
import { join } from "node:path";
import { skipVersionPath, updatesCacheDir } from "../foundation/paths";
import type { GithubRelease } from "../foundation/types";

// 更新检查的发布通道。必须指向**本仓库**：上游 Releases 的包不含本分支任何改动，
// 一旦被当成「新版本」下载并覆盖安装，SQLite 活库 / stdio MCP / WebView2 壳会被整体
// 换回上游形态，这是本分支最容易自伤的地方。写成常量并由 update-channel.test.ts 钉死。
export const UPDATE_REPO = "ODO-TECH/Rikkahub-desktoPLUS";

// 可选的下载镜像（Cloudflare R2 公共桶）。留空 = 不使用镜像，一律走 GitHub Release
// 资产直链。上游的 R2 桶只能取到上游的安装包，绝不能指向它。
export const UPDATE_R2_BASE = "";

export function hasUpdateMirror(): boolean {
  return UPDATE_R2_BASE.trim() !== "";
}

export type UpdatePlatform = "win" | "mac" | "linux";
export type UpdateAsset = { name?: string; browser_download_url?: string; size?: number };

// 按运行平台挑资产。容器化部署没有可持久替换的二进制，直接不给资产（前端提示 docker pull）。
//
// Windows 只认 NSIS 安装器（*-setup.exe）：前端的 Windows 更新流程是把下载好的路径交给
// launch_installer 执行，而本分支发布的是 **便携 zip**（RikkaHub-Desktop-PLUS-<tag>-windows-x64-portable.zip），
// zip 既不可执行也不能就地替换二进制。挑不到安装器时返回 undefined，前端落到
// update-dialog 里已有的「打开 Release 页手动下载」分支——比丢给它一个 zip 让它失败要好。
export function pickUpdateAsset(
  assets: NonNullable<GithubRelease["assets"]>,
  platform: UpdatePlatform,
  containerized: boolean,
): UpdateAsset | undefined {
  if (containerized) return undefined;
  if (platform === "linux") {
    return assets.find((a) => /linux[-_]x64.*\.tar\.gz$/i.test(a.name ?? ""));
  }
  if (platform === "mac") {
    return assets.find((a) => /\.dmg$/i.test(a.name ?? ""))
      ?? assets.find((a) => /(?:macos|darwin|mac)[-_]x64/i.test(a.name ?? ""));
  }
  return assets.find((a) => /x64[-_]setup\.exe$/i.test(a.name ?? ""));
}

// GitHub API 被限流（未认证 60 req/hr/IP）时的兜底：按命名约定拼资产名。
// 只对 Linux 预测——产物是 tar.gz，download 端会解压后返回内部二进制路径。
// Windows 返回 null：本分支不发布 NSIS 安装器，预测一个 .exe 名字只会让用户点出 404。
export function predictUpdateAssetName(tag: string, platform: UpdatePlatform): string | null {
  if (platform === "linux") return `Rikkahub_${tag}_linux_x64.tar.gz`;
  return null;
}

export function readSkippedVersion(): string {
  try { return readFileSync(skipVersionPath, "utf-8").trim(); } catch { return ""; }
}
export function writeSkippedVersion(version: string) {
  try { writeFileSync(skipVersionPath, version.trim()); } catch { /* best-effort */ }
}

// 版本号唯一修改入口：`bun run version:bump <x.y.z>`（scripts/bump-version.ts），
// 一次同步本处 + tauri.conf.json + Cargo.toml 三处；请勿手改单处（CI 的
// check-version-sync.ts 会红灯）。更新检查用本值对比 GitHub release tag，
// 关于页也原样展示。
export const APP_VERSION = "0.1.0";

// GitHub 出站统一入口:证书校验失败(本机 HTTPS 被加速 / 代理工具接管)时改用系统根证书
// 重试一次。见 foundation/tls-trust.ts。
async function fetchGithub(url: string, init: FetchWithTimeoutInit): Promise<Response> {
  return fetchWithSystemRoots((tls) => fetchWithTimeout(url, tls ? { ...init, tls } : init));
}

export async function fetchGithubLatestRelease(repo: string): Promise<GithubRelease> {
  const res = await fetchGithub(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "RikkaHub-PC" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as GithubRelease;
}

// Anonymous fallback when api.github.com refuses. github.com/<repo>/releases/latest is a
// regular HTML page that 302-redirects to /releases/tag/v<latest>. We follow the redirect
// manually and pull the tag out of the Location header. No API, no rate limit, no token.
export async function fetchLatestReleaseFromHtmlRedirect(repo: string): Promise<{ tag: string; htmlUrl: string }> {
  const url = `https://github.com/${repo}/releases/latest`;
  const res = await fetchGithub(url, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "RikkaHub-PC" },
  });
  // GitHub returns 302 with Location: /<owner>/<repo>/releases/tag/v<tag> on success.
  const location = res.headers.get("location") ?? "";
  if (!location) {
    throw new Error(`No redirect from ${url} (status ${res.status})`);
  }
  const match = location.match(/\/releases\/tag\/v?([^/?#]+)/i);
  if (!match) {
    throw new Error(`Unrecognized release redirect target: ${location}`);
  }
  const tag = match[1].replace(/^v/i, "");
  const absoluteHtmlUrl = location.startsWith("http") ? location : `https://github.com${location}`;
  return { tag, htmlUrl: absoluteHtmlUrl };
}

// Look for a previously-downloaded installer for this exact version in the temp dir so the
// UI can offer "直接安装" without re-downloading. Matched first by canonical filename, then
// by any *.exe whose name embeds the version tag (tolerates users moving/renaming files).
// Returns null if isNewer is false (don't surface stale installers).
//
// 仅 Windows 调用(buildResponse 里按平台过滤):Linux 的更新是 tar.gz,需要解压后才能
// apply,缓存的 tar.gz 没法直接用,所以 Linux 走"每次重新下载解压"的路径,见 update/download。
export function probeCachedInstaller(fileName: string, tag: string, isNewer: boolean): string | null {
  if (!isNewer || !fileName) return null;
  try {
    const tmpDir = updatesCacheDir;
    if (!existsSync(tmpDir)) return null;
    const canonical = join(tmpDir, fileName);
    if (existsSync(canonical) && statSync(canonical).size > 0) {
      return canonical;
    }
    for (const entry of readdirSync(tmpDir)) {
      if (!/\.exe$/i.test(entry)) continue;
      if (tag && !entry.includes(tag)) continue;
      const candidate = join(tmpDir, entry);
      try {
        if (statSync(candidate).size > 0) return candidate;
      } catch { /* ignore */ }
    }
  } catch (cacheErr) {
    console.warn("[update/check] cache scan failed:", cacheErr);
  }
  return null;
}
