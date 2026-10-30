// api/handlers/update.ts — 应用更新路由（update/check|download|apply|skip）
// 纪律：纯搬迁自 server.ts routeApi()；GitHub Releases 检查/下载/覆盖安装流程原样保留。

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GithubRelease } from "../../foundation/types";
import { updatesCacheDir } from "../../foundation/paths";
import { readWithIdleTimeout } from "../../foundation/net";
import { fetchWithSystemRoots, isCertificateError } from "../../foundation/tls-trust";
import { RUNNING_IN_CONTAINER, RUNTIME_PLATFORM } from "../../foundation/platform";
import { compareSemver } from "../../foundation/utils";
import {
  APP_VERSION,
  fetchGithubLatestRelease,
  fetchLatestReleaseFromHtmlRedirect,
  hasUpdateMirror,
  pickUpdateAsset,
  predictUpdateAssetName,
  probeCachedInstaller,
  readSkippedVersion,
  UPDATE_R2_BASE,
  UPDATE_REPO,
  writeSkippedVersion,
} from "../../updates/index";
import { error, json, readJson, sseHeaders } from "../request";

const CERT_INTERCEPT_HINT =
  "本机有程序替换了 GitHub 的 HTTPS 证书，无法校验连接安全。常见于 Steam++ / Watt Toolkit 等加速工具，请在它的加速列表中关闭 GitHub 后重试。";

export async function handleUpdateRoutes(request: Request, url: URL, path: string): Promise<Response | null> {
  // -- Update check / download ---------------------------------------------------
  // Queries GitHub Releases for the latest published release of the PC repo, compares its
  // tag (e.g. "v1.0.1") to APP_VERSION, and returns the diff so the About page can decide
  // whether to prompt the user. Unauthenticated GitHub API is capped at 60 req/hr/IP and
  // can 403 when the user's IP (or anyone behind the same NAT) has been hammering GitHub;
  // when that happens we fall back to scraping the public `github.com/<repo>/releases/latest`
  // redirect, which doesn't hit the API and isn't rate-limited.
  if (path === "update/check" && request.method === "GET") {
    // 发布通道是本仓库(UPDATE_REPO)，不是上游：上游 Releases 的包不含本分支改动，
    // 装上会把 SQLite 活库/stdio MCP/WebView2 壳覆盖回上游形态。资产选择与命名预测
    // 的规则见 updates/index.ts 的 pickUpdateAsset / predictUpdateAssetName。
    const repo = UPDATE_REPO;

    // 容器化部署(Docker 等)无法通过替换二进制持久更新,直接返回 undefined,
    // 前端会提示用 docker pull 升级镜像。
    const pickAsset = (assets: NonNullable<GithubRelease["assets"]>) =>
      pickUpdateAsset(assets, RUNTIME_PLATFORM, RUNNING_IN_CONTAINER);

    // 界面侧版本(web-ui/app/lib/app-version.ts，经 ?current= 带上来)。前端静态文件每次
    // 请求按磁盘重读、后端进程只在重启时换代码——桌面壳 attach 到的旧后端会让
    // APP_VERSION 落后于用户实际装好的工件，单按后端版本比较就会把 0.1.2 的用户
    // 反复提示"更新到 0.1.2"。取两者较高者作为「当前版本」。
    const clientVersion = (() => {
      const raw = (url.searchParams.get("current") ?? "").trim().replace(/^v/i, "");
      return /^\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?$/.test(raw) ? raw : "";
    })();
    const effectiveCurrent =
      clientVersion && compareSemver(clientVersion, APP_VERSION) > 0 ? clientVersion : APP_VERSION;

    // Helper: build the JSON response for a given release tag + metadata, apply skip logic.
    const buildResponse = (fields: Record<string, unknown>) => {
      const latest = String(fields.latest ?? "");
      const isNewer = compareSemver(latest, effectiveCurrent) > 0;
      const skipped = readSkippedVersion();
      fields.current = effectiveCurrent;
      fields.backendVersion = APP_VERSION;
      fields.isNewer = isNewer;
      fields.isSkipped = isNewer && latest === skipped;
      fields.platform = RUNTIME_PLATFORM;
      fields.containerized = RUNNING_IN_CONTAINER;
      // 缓存探测只对 Windows 有意义(.exe 安装器可直接启动)。Linux 下 download 需要先解压
      // tar.gz 才能得到 apply 用的二进制路径,缓存的 tar.gz 不能直接 apply,所以跳过。
      if (!RUNNING_IN_CONTAINER && RUNTIME_PLATFORM === "win") {
        fields.cachedInstallerPath = probeCachedInstaller(String(fields.fileName ?? ""), latest, isNewer && !fields.isSkipped);
      }
      // 可选镜像(默认未配置)：只有显式设了 UPDATE_R2_BASE 且该桶里确实镜像了本仓库的
      // 资产时才改走它；否则一律用 GitHub Release 直链。绝不能指向上游的 R2 桶。
      if (hasUpdateMirror() && !RUNNING_IN_CONTAINER && String(fields.fileName ?? "")) {
        fields.downloadUrl = `${UPDATE_R2_BASE}/${fields.fileName}`;
      }
      return json(fields);
    };

    // Step 1: Use the rate-limit-free HTML redirect (HEAD to github.com/releases/latest)
    // to discover the latest version tag. This never hits api.github.com so it never
    // 403s — even when the user's IP has exhausted the 60 req/hr unauthenticated quota.
    try {
      const redirect = await fetchLatestReleaseFromHtmlRedirect(repo);
      const isNewer = compareSemver(redirect.tag, effectiveCurrent) > 0;

      // If no update available, return immediately — zero API calls.
      if (!isNewer) {
        return buildResponse({
          latest: redirect.tag,
          title: "",
          notes: "",
          htmlUrl: redirect.htmlUrl,
          downloadUrl: "",
          fileName: "",
          size: 0,
          source: "redirect",
        });
      }

      // Step 2: There IS a newer version. Try the GitHub API for full release details
      // (release notes, asset URLs, etc.). If the API is rate-limited, fall back to
      // predicting the asset URL from the naming convention.
      try {
        const release = await fetchGithubLatestRelease(repo);
        const tag = (release.tag_name ?? "").replace(/^v/i, "");
        const assets = release.assets ?? [];
        const installer = pickAsset(assets);
        return buildResponse({
          latest: tag,
          title: release.name ?? release.tag_name ?? "",
          notes: release.body ?? "",
          htmlUrl: release.html_url ?? redirect.htmlUrl,
          downloadUrl: installer?.browser_download_url ?? "",
          fileName: installer?.name ?? "",
          size: installer?.size ?? 0,
          source: "api",
        });
      } catch {
        // API failed (rate limit etc.) — 用 redirect 拿到的版本号，资产名按约定预测。
        // predictUpdateAssetName 对 Windows/macOS 返回 null：本分支不发布可被
        // launch_installer 消费的安装器，猜一个名字只会让用户点到 404。没有资产名时
        // 返回空 downloadUrl，前端落到「打开 Release 页手动下载」分支。
        const predicted = predictUpdateAssetName(redirect.tag, RUNTIME_PLATFORM);
        if (!predicted) {
          return buildResponse({
            latest: redirect.tag,
            title: `v${redirect.tag}`,
            notes: "",
            htmlUrl: redirect.htmlUrl,
            downloadUrl: "",
            fileName: "",
            size: 0,
            source: "redirect",
          });
        }
        return buildResponse({
          latest: redirect.tag,
          title: `v${redirect.tag}`,
          notes: "",
          htmlUrl: redirect.htmlUrl,
          downloadUrl: `https://github.com/${repo}/releases/download/v${redirect.tag}/${predicted}`,
          fileName: predicted,
          size: 0,
          source: "redirect",
        });
      }
    } catch (err) {
      // Both redirect and API failed — very rare (network down, DNS failure, etc.)
      // 证书类失败单独说明:本机有 HTTPS 拦截工具时 Bun 不认它的根证书,用户需要知道该关谁,
      // 而不是去排查网络。
      if (isCertificateError(err)) {
        return error(`检查更新失败：${CERT_INTERCEPT_HINT}`, 502);
      }
      return error("检查更新失败：无法连接 GitHub，请检查网络连接", 502);
    }
  }
  // Downloads a release asset to the temp dir's rikkahub-updates subfolder and returns the
  // local path. Windows: the UI then asks the Tauri shell to launch the .exe installer.
  // Linux: the UI calls update/apply to swap the running binary. The user explicitly confirms
  // the restart so we don't race a process that's about to be replaced.
  if (path === "update/download" && request.method === "POST") {
    // 流式下载:响应是 text/event-stream,边下载边写盘边推 progress 事件,完成推 done(含
    // 本地路径)/error。前端用 fetch + ReadableStream 解析——之前用 arrayBuffer 一次性下完
    // 才返回,前端 XHR onprogress 下载期间收不到任何字节,进度条纹丝不动。
    let body: { url?: string; fileName?: string };
    try {
      body = await readJson<{ url?: string; fileName?: string }>(request);
    } catch {
      return error("Invalid request body", 400);
    }
    const url = String(body.url ?? "").trim();
    if (!/^https:\/\//i.test(url)) return error("Invalid download URL", 400);
    // 只放行 GitHub 与自建 R2 镜像,缩小 URL 被篡改时的攻击面。
    // 批次二 R5-5:R2 侧此前用 pub-[a-f0-9]+\.r2\.dev 泛匹配,等于放行【任何人】的 R2
    // 公共桶——配合 probeCachedInstaller"文件名含版本号的 .exe 即缓存安装器",已授权
    // 客户端可诱导下载任意 exe 并在下次检查更新时被当作"直接安装"候选。收紧为
    // UPDATE_R2_BASE 的精确 host。
    const host = (() => {
      try {
        return new URL(url).host.toLowerCase();
      } catch {
        return "";
      }
    })();
    const r2Host = hasUpdateMirror() ? new URL(UPDATE_R2_BASE).host.toLowerCase() : "";
    const trustedHost =
      host === "github.com"
      || (r2Host !== "" && host === r2Host)
      || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.githubusercontent\.com$/.test(host);
    if (!trustedHost) {
      return error(`Refusing to download from untrusted host: ${host}`, 400);
    }
    const sanitized = String(body.fileName ?? "").replace(/[^A-Za-z0-9._\-]/g, "") || "rikkahub-update";
    // Windows: launch_installer 只认 .exe(lib.rs 路径检查);Linux: asset 是 tar.gz,保留原名。
    const fileName = RUNTIME_PLATFORM === "win"
      ? (/\.exe$/i.test(sanitized) ? sanitized : `${sanitized}.exe`)
      : sanitized;
    mkdirSync(updatesCacheDir, { recursive: true });
    const targetPath = join(updatesCacheDir, fileName);

    // 批次二 R5-5:下载流补 cancel 处理。此前客户端断开后 fetch/写盘循环只能靠 enqueue
    // 抛错间接终止,Bun 的 file writer 不走 end(),半截文件+句柄一直留到 GC。现在:
    //   cancel → abort 上游 fetch → 读循环立刻抛 AbortError → finally 统一收尾。
    // 半截文件必须删:probeCachedInstaller 把"文件名含版本号且 size>0 的 .exe"当作可
    // 直接安装的缓存安装器,残留的半截安装包会在下次检查更新时被当成完整品提供给用户。
    const abort = new AbortController();
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: Record<string, unknown>) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch { /* 客户端已断开(cancel 已触发),丢弃事件 */ }
        };
        let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
        let downloadComplete = false;
        try {
          // 专题7:下载流空闲看门狗。CDN 静默挂死(TCP 通但不回字节)时,若无上限,
          // 响应头等待或 reader.read() 永久悬挂,前端进度条永久卡住且无错误提示。
          // 超时抛错后走下方 catch:推 error 事件、abort 掉底层连接、finally 删半截文件。
          // 与更新检查同源的证书兜底:下载域名同样会被 HTTPS 加速工具接管。
          const fetchAsset = (tls?: { ca: string }) =>
            fetch(url, {
              redirect: "follow",
              headers: { "User-Agent": "RikkaHub-PC" },
              signal: abort.signal,
              ...(tls ? { tls } : {}),
            });
          const res = await readWithIdleTimeout(
            () => fetchWithSystemRoots(fetchAsset),
            30_000,
            "下载连接超时：30s 内未收到服务器响应",
          );
          if (!res.ok || !res.body) {
            // D2(复查):错误分支的正文读取同样要看门狗——非 2xx 头到达后服务器悬挂不回
            // 正文时 res.text() 会永久挂起,进度条卡死且无报错。超时/失败都按空文案处理。
            const text = res.ok
              ? "no response body"
              : await readWithIdleTimeout(() => res.text(), 10_000, "error body timeout").catch(() => "");
            send({ type: "error", message: `Download failed: ${res.status} ${String(text).slice(0, 200)}` });
            return;
          }
          const total = Number(res.headers.get("content-length") || 0);
          const reader = res.body.getReader();
          writer = Bun.file(targetPath).writer();
          let received = 0;
          while (true) {
            const { done, value } = await readWithIdleTimeout(
              () => reader.read(),
              60_000,
              "下载停滞：60s 未收到任何数据，已中断（网络或下载源异常，请重试）",
            );
            if (done) break;
            await writer.write(value);
            received += value.length;
            const percent = total > 0 ? Math.round((received / total) * 100) : 0;
            send({ type: "progress", loaded: received, total, percent });
          }
          await writer.end();
          writer = null;
          downloadComplete = true;

          if (RUNTIME_PLATFORM === "win") {
            // targetPath 指向 .exe 安装器,前端交给 Tauri launch_installer。
            send({ type: "done", path: targetPath, size: received });
            return;
          }
          // Linux: 下载的是 tar.gz(二进制 + 前端资源),解压后返回内部二进制路径,
          // update/apply 据此连同同目录的 web-ui 一起替换。
          const extractBase = fileName.replace(/\.tar\.gz$/i, "") || "rikkahub-pc";
          const extractDir = join(updatesCacheDir, `extracted-${extractBase}`);
          try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* 清理上一次解压残留 */ }
          mkdirSync(extractDir, { recursive: true });
          const tar = Bun.spawnSync(["tar", "xzf", targetPath, "-C", extractDir]);
          if (tar.exitCode !== 0) {
            send({ type: "error", message: `解压更新包失败：${tar.stderr?.toString().trim() || `tar exited ${tar.exitCode}`}` });
            return;
          }
          // 解压后约定结构:extractDir/rikkahub-pc/rikkahub-pc (+ extractDir/rikkahub-pc/web-ui/)
          const innerExe = join(extractDir, "rikkahub-pc", "rikkahub-pc");
          if (!existsSync(innerExe) || statSync(innerExe).size === 0) {
            send({ type: "error", message: "解压后未找到可执行文件（更新包结构异常）" });
            return;
          }
          try { chmodSync(innerExe, 0o755); } catch { /* best-effort */ }
          send({ type: "done", path: innerExe, size: received });
        } catch (err) {
          // 看门狗超时后底层 fetch 仍挂着(race 无法取消 promise),显式 abort 释放连接。
          try { abort.abort(); } catch { /* 已 abort 或未发起 */ }
          send({
            type: "error",
            message: isCertificateError(err)
              ? `下载失败：${CERT_INTERCEPT_HINT}`
              : err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (writer) {
            try { await writer.end(); } catch { /* 尽力关句柄 */ }
          }
          if (!downloadComplete) {
            try { unlinkSync(targetPath); } catch { /* 可能尚未创建 */ }
          }
          try { controller.close(); } catch { /* cancel 后流已关闭 */ }
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, { headers: sseHeaders({ "Cache-Control": "no-store" }) });
  }
  // Linux only: 把刚下载并解压的新版本(二进制 + 前端资源)原地替换到当前应用目录。
  // download 已把 tar.gz 解压到 <tmp>/rikkahub-updates/extracted-*/rikkahub-pc/,其中含新
  // 二进制和 web-ui。这里:
  //   1. 用 staging + rename 原子替换 web-ui 目录(routeStatic 每次请求重读,换完立即生效)
  //   2. rename 新二进制覆盖正在运行的二进制(Linux 允许,旧进程继续用旧 inode 直到退出)
  // 替换成功后前端提示用户重启;systemd 配 Restart=always 的会自动拉起新版本。
  //
  // Windows 走 Tauri NSIS 安装器,macOS 暂不支持原地更新 —— 都在此拒绝。Docker 也不行
  // (容器重建即丢失替换),应 docker pull。
  if (path === "update/apply" && request.method === "POST") {
    if (RUNTIME_PLATFORM !== "linux") return error("仅 Linux 支持原地更新", 400);
    if (RUNNING_IN_CONTAINER) return error("容器化部署无法原地更新，请通过 docker pull 升级镜像", 400);
    try {
      const body = await readJson<{ path?: string }>(request);
      const srcExe = String(body.path ?? "").trim();
      if (!srcExe) return error("缺少更新文件路径", 400);
      const resolvedSrcExe = resolve(srcExe);
      if (!existsSync(resolvedSrcExe)) return error("更新文件不存在", 404);
      if (statSync(resolvedSrcExe).size === 0) return error("更新文件为空", 400);

      // Security: srcExe 必须在我们的受信任更新目录树内(download 解压到这里),否则一个构造
      // 的请求可能让我们把任意文件拷到可执行路径上。
      const updatesDir = resolve(updatesCacheDir);
      const rel = relative(updatesDir, resolvedSrcExe);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return error("更新文件路径不在受信任目录内", 400);
      }

      const currentExe = resolve(process.execPath);
      const currentAppDir = dirname(currentExe);
      if (!existsSync(currentExe)) return error(`当前可执行文件路径无效：${currentExe}`, 500);

      // 新应用目录 = 解压出的 rikkahub-pc/(新二进制的同级目录,含新 web-ui)。
      const newAppDir = dirname(resolvedSrcExe);

      // ── 1. 替换随包资源目录 (web-ui / icons / fonts) ────────────────────
      // 拷到 .<name>.new 再原子 rename 覆盖。cp 失败不致命(新版本可能没改该目录):记
      // warning 后继续 —— 避免资源替换的小问题阻塞整个更新;但 rename 交换半途失败意味着
      // 旧目录已被挪走、状态不确定,必须回滚。返回值区分这两种失败,由调用侧决定后果:
      // web-ui 交换失败要中止更新(二进制换了前端没换,重启后前后端版本错位);
      // icons/fonts 是 8-5 起随包分发的品牌图标/内置字体,失败只降级显示,不阻塞。
      const swapAppResourceDir = (name: string): "ok" | "copy_failed" | "swap_failed" => {
        const currentDir = join(currentAppDir, name);
        const newDir = join(newAppDir, name);
        if (!existsSync(newDir)) return "ok"; // 更新包不带该目录(老包):跳过
        const staging = join(currentAppDir, `.${name}.new`);
        const bak = join(currentAppDir, `.${name}.bak`);
        try {
          if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
          const cp = Bun.spawnSync(["cp", "-r", newDir, staging]);
          if (cp.exitCode !== 0) {
            console.warn(`[update/apply] cp ${name} to staging failed:`, cp.stderr?.toString().trim());
            return "copy_failed";
          }
          if (existsSync(currentDir)) {
            if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
            try { renameSync(currentDir, bak); } catch { /* 首次安装可能没有旧目录 */ }
            try {
              renameSync(staging, currentDir);
              try { rmSync(bak, { recursive: true, force: true }); } catch { /* */ }
            } catch (swapErr) {
              console.warn(`[update/apply] ${name} swap failed, rolling back:`, swapErr);
              try { if (existsSync(bak)) renameSync(bak, currentDir); } catch { /* */ }
              return "swap_failed";
            }
          } else {
            // 当前没有该目录(异常状态或老部署),直接把 staging 就位。
            renameSync(staging, currentDir);
          }
          return "ok";
        } catch (err) {
          console.warn(`[update/apply] ${name} update skipped:`, err);
          return "copy_failed";
        }
      };

      if (swapAppResourceDir("web-ui") === "swap_failed") {
        return error("替换前端资源失败，更新未完成", 500);
      }
      swapAppResourceDir("icons");
      swapAppResourceDir("fonts");

      // ── 2. 备份 + 原子替换二进制 ───────────────────────────────────────
      // 必须同时绕开两个 Linux 约束:
      //   (a) currentExe 正在运行:Linux 禁止 write/open 它(ETXTBSY),但同文件系统内的
      //       rename(2) 可以覆盖它——rename 只改目录项,旧 inode 留给运行中的进程直到退出,
      //       下次启动即用新版本。这是 Linux 自更新二进制的标准机制。
      //   (b) 下载的新二进制在 /tmp,常与安装目录(/home/...)不在同一文件系统,跨设备
      //       rename 直接 EXDEV。
      // 旧逻辑"rename(源→目标),失败 fallback copy"两头堵死:跨设备 rename→EXDEV,
      // fallback 直接 copy 目标→ETXTBSY(运行中)。正解:先 copy 到安装目录下的临时文件
      // (跨设备 copy 合法,目标是新文件不触发 ETXTBSY),再在同文件系统内 rename 覆盖当前
      // 二进制(同设备不 EXDEV,且能覆盖运行中的二进制)。与上面 web-ui 的 staging+rename
      // 同构。
      const backupPath = `${currentExe}.bak`;
      try {
        if (existsSync(backupPath)) unlinkSync(backupPath);
        copyFileSync(currentExe, backupPath);
      } catch (backupErr) {
        console.warn("[update/apply] binary backup skipped:", backupErr);
      }
      const stagingExe = `${currentExe}.new`;
      try {
        copyFileSync(resolvedSrcExe, stagingExe);
        try { chmodSync(stagingExe, 0o755); } catch { /* */ }
        renameSync(stagingExe, currentExe);
      } catch (swapErr) {
        try { if (existsSync(stagingExe)) unlinkSync(stagingExe); } catch { /* */ }
        console.warn("[update/apply] binary swap failed:", swapErr);
        return error(`替换二进制失败：${swapErr instanceof Error ? swapErr.message : String(swapErr)}`, 500);
      }

      return json({ status: "ok", exePath: currentExe, backupPath: existsSync(backupPath) ? backupPath : null, needRestart: true });
    } catch (err) {
      return error(`应用更新失败：${err instanceof Error ? err.message : String(err)}`, 500);
    }
  }
  if (path === "update/skip" && request.method === "POST") {
    const body = await readJson<{ version?: string }>(request);
    const version = String(body.version ?? "").trim().replace(/^v/i, "");
    if (!version) return error("Missing version", 400);
    writeSkippedVersion(version);
    return json({ status: "ok", skipped: version });
  }
  return null;
}
