# 构建与排查（BUILD / TROUBLESHOOTING）

English summary: how to rebuild every artefact of this fork — vendored `pi`
engine, Bun backend, web UI, Tauri NSIS installer, portable layout, the native
WebView2 shell, Linux binaries and the Docker image — plus the two Windows
platform defects that dominated cold-start latency, and what to change before
publishing your own release feed.

本文假定你在 Windows 上开发。所有命令在仓库根目录（与 `README.md` 同级）执行。

## 0. 工具链

| 工具 | 版本要求 | 用途 |
|---|---|---|
| [Bun](https://bun.sh/) | **1.4.2**（与 CI/Dockerfile 钉死同版本） | 运行时、打包器、`--compile` 出单文件 exe |
| [Git for Windows](https://gitforwindows.org/) | 任意近期版本 | 前端依赖 + 内嵌 bash 运行时的抽取源 |
| Rust (rustup, MSVC target) | stable | 仅 Tauri 壳需要 |
| Visual Studio Build Tools 2022 +「使用 C++ 的桌面开发」| — | MSVC `link.exe` 与 Windows SDK |
| .NET Framework 4.8 + `csc.exe` | Windows 自带 | 仅 `desktop-shell` 原生壳需要（**不需要 Visual Studio**） |
| Python + Pillow | 3.x | 仅重生成 `desktop-shell/icon.ico` |
| `curl.exe` / `tar.exe` | Win10 1803+ 自带 | `desktop-shell/fetch-sdk.cmd` 拉 WebView2 SDK |

依赖版本为什么要钉：Bun 的 `--compile` 产物行为与运行时版本强相关，CI、Dockerfile、
本地三处不同版本会出现「本地能编、CI 红」。

## 1. 还原 pi vendor（必须先做）

后端的对话/工具编排引擎来自 [earendil-works/pi](https://github.com/earendil-works/pi)。
本仓库**不**跟踪 `pi/` 源码，只跟踪两件东西：

- `pi-patches/*.patch` —— 给上游打的受控补丁（带 `[RIKKAHUB PATCH: …]` 行内标记，方便 rebase 时 grep 定位）；
- `pi-model-data/` —— 模型目录快照（与下面的基线 commit 严格配对）。

```bash
git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi
cd pi
git checkout d981de1229ef899957bbe968bc8dcda02a21f477
git reset --hard
git apply ../pi-patches/*.patch
bun install                                  # pi 的 lockfile 是 v1，不要用 --frozen-lockfile
mkdir -p packages/ai/src/providers/data
cp ../pi-model-data/*.json ../pi-model-data/.manifest.json packages/ai/src/providers/data/
cd ..
```

`.gitignore` 已忽略 `/pi/`。**不要**在这一步改跑 `bun run generate-models`：
上游那个生成器是先删全部 `*.models.ts` 分片、再按 models.dev **当天**状态重建，
第三方数据一漂移（2026-09 就发生过 `kimi-for-coding` 被摘除）就会出现「分片被删、
无人重建」，`bun build` 全图解析直接崩。模型数据一律走 `pi-model-data/` 快照；
升级 pi 基线时，在本地 pi 里重跑一次 `generate-models`，然后把产出的 `data/` 刷进
`pi-model-data/`，与 patches 的刷新放在同一个时机。

## 2. 开发模式

```bash
# 终端 A：后端，http://localhost:17455
cd pc-server && bun install && bun run server.ts

# 终端 B：前端 Vite dev server，http://localhost:5173（/api 自动代理到 17455）
cd web-ui && bun install && bun run dev
```

只调 UI 时直接浏览器开 `http://localhost:5173`：自定义标题栏在非桌面壳环境下自动隐藏，
整套界面在浏览器里可用。

## 3. Windows：Tauri 安装包（上游形态）

```bash
cd pc-server
bun run compile            # bun install + 内嵌 bash bundle + bun build --compile → ../dist/rikkahub-pc.exe
bun run scripts/sync-dist-assets.ts

cd ../web-ui
bun install
bun run build              # 前端静态资源 → web-ui/build/client
./src-tauri/tauri-msvc.cmd build --bundles nsis
```

`compile` 脚本末尾会把 `dist/rikkahub-pc.exe` 复制成
`web-ui/src-tauri/binaries/rikkahub-server-x86_64-pc-windows-msvc.exe`（Tauri sidecar
按 target triple 命名）。这个 117 MB 的 exe 是构建产物，已 gitignore。

两个 `*-msvc.cmd` 包装脚本绕开 Windows 上两个经典坑：

1. Git Bash 的 PATH 里 `link.exe` 是 coreutils 的那个，会把 cargo 的链接器顶掉 →
   包装脚本先 `vcvars64.bat`；
2. 项目路径含非 ASCII 字符时部分 build script 会失败 → `CARGO_TARGET_DIR` 指到
   ASCII 路径（脚本里默认 `C:\rikkahub-build`，可自行改）。

### 内嵌 bash 运行时

`bun run build:bash-bundle` 会从本机 Git for Windows 的 `usr/bin` 抽取
「bash + coreutils 最小子集 + 完整 dll 闭包」打成 `pc-server/assets/bash-bundle.tar.gz`，
并附 GPL-2.0 许可证文本。脚本按 `%ProgramFiles%\Git`、`%ProgramFiles(x86)%\Git`、
PATH 上的 `git.exe` 依次自动推导安装根，推不出来时：

```bash
bun run scripts/build-bash-bundle.ts --src "D:\SoftWare\Git"
```

产物与 staging 目录（`assets/bash/`、`bash-bundle.tar.gz`，约 8.5 MB / 24 MB）都进
gitignore，只有版本戳 `assets/bash-bundle.version.json` 入库，runtime 据此判断是否需要
落地覆盖。Linux 上这一步会直接跳过（内嵌 bash 只给 Windows 用），CI 用一个 dummy
空文件让 import 能解析。

## 4. Windows：便携版 + 原生壳

```bash
# 后端
cd pc-server && bun run compile

# 前端
cd ../web-ui && bun install && bun run build

# 原生壳
cd ../desktop-shell
fetch-sdk.cmd        # 拉 WebView2 SDK 的 3 个引用 dll 到 sdk\lib（约 0.9 MB）
build.cmd            # csc.exe 单文件编译 → dist\RikkaHub.exe
```

把目录拼成便携版（壳在同目录找 `rikkahub-pc.exe`，数据落 `<根>\pc-data\`）：

```
RikkaHub_portable/
  RikkaHub.exe                                   <- desktop-shell\dist
  rikkahub-pc.exe                                <- dist
  web-ui/build/client/                            <- 前端产物
  fonts/  icons/                                  <- 直接拷目录
  Microsoft.Web.WebView2.Core.dll
  Microsoft.Web.WebView2.WinForms.dll
  WebView2Loader.dll                              <- 这三枚来自 desktop-shell\sdk\lib
  pc-data/                                        <- 运行时自动生成，属于用户，勿入库
```

`desktop-shell/build.cmd` 用系统 `csc.exe` 编译，语言级别是 C# 5（`csc.exe` 只认到它），
写 `Program.cs` 时别用插值字符串、`Math.Min` 与 ref out 参数组合这类较新语法。

## 5. Linux 二进制与 Docker

```bash
cd web-ui && bun install && bun run build
cd ../pc-server && bun run compile:linux       # → ../dist/rikkahub-pc
./dist/rikkahub-pc                              # 打开 http://localhost:17455，数据在 ./pc-data/
```

Linux 上按需安装的系统包：`espeak-ng`（系统 TTS）、`xclip`/`wl-clipboard`（剪贴板）、
`unzip` + `zip`（备份恢复、ZIP 导入 Skill —— 缺 `zip` 导出会直接崩）。缺失项在启动日志里
会以警告列出，服务照常起。

Docker 推荐用仓库根目录的 compose：`docker compose up -d --build`。等价的手工命令是
`docker build -t rikkahub-desktop-plus .` →
`docker run -d -p 11451:11451 -v ./pc-data:/app/pc-data rikkahub-desktop-plus`。
镜像基于 `debian:bookworm-slim`（不再是 distroless）：自带 `bash`、coreutils、`zip`/`unzip`
与 fontconfig，agent 的 bash 工具、备份导出与系统字体枚举都能用；默认关闭匿名统计
（`RIKKAHUB_ANALYTICS=0`），剪贴板与 TTS 不可用。
容器端口钉在 11451（`ENV PORT` + 服务端检测双保险）。114514 超出 TCP 端口上限，
不可用；改号须同步 `foundation/port-binding.ts`、`Dockerfile`、`docker-compose.yml` 与文档。
放反向代理时注意两件事：必须透传原始 `Host`（否则 Origin/Host 一致性校验会让所有
POST/DELETE 404/403），流式响应已带 `X-Accel-Buffering: no`。
目录树、环境变量与备份细节见 [DOCKER.md](DOCKER.md)。

**SSRF 注记**：`scrape_web` 工具会在容器内直接抓取模型给出的任意 URL。若网络环境在意，
请隔离容器网络或限制出站。

## 6. 版本号只有一个入口

```bash
cd pc-server && bun run version:bump 2.0.1
```

一次同步 `pc-server/updates/index.ts` 的 `APP_VERSION`、`web-ui/src-tauri/tauri.conf.json`、
`web-ui/src-tauri/Cargo.toml` 三处。手改单处会被 CI 的 `check-version-sync.ts` 拦成红灯。

## 7. 测试与已知噪音

```bash
cd pc-server && bun run typecheck && bun test        # 单元 + 集成，测试数据走沙箱目录
cd pc-server && bun run smoke:request-chain          # mock 供应商/MCP/WebDAV/S3 全链路
cd pc-server && bun run smoke:backup-roundtrip       # 备份导出→恢复往返
cd web-ui  && bun run test
```

`bunfig.toml` 的 `[test].preload` 指向 `pc-server/test-preload.ts`：所有测试的
`pc-data` 都被重定向到临时沙箱，**不会碰你真实的本地数据**。

Windows 上 `bun test` 有 3 个恒定失败，不是回归、不必 bisect：2 个需要管理员权限写
`C:\WINDOWS\Temp`，1 个是 e2e 清理时 `EBUSY`（文件被杀毒/索引占用）。Linux CI 上这三个都过。

## 8. 启动耗时：两个平台坑（别重复踩）

2026-10 用 CDP + 后端里程碑日志实测便携版冷启动，从 ~6.3 s 压到 ~1.9 s：

| 阶段 | 优化前 | 优化后 |
|---|---|---|
| 壳找后端 / 起后端 | ~1.91 s | **~0.18 s** |
| 后端 bootstrap | ~3.27 s | **~0.03 s** |
| 界面可用（总） | ~6.3 s | **~1.9 s** |

- **Bun 1.4.2 / Windows：进程内第一次 `Bun.spawn`（或 `spawnSync`，共用同一段 lazy init）
  会同步阻塞调用线程 3.06–3.29 s**，后续调用只要 12–25 ms；同一台机器上 Node 是 24 ms。
  这个开销可以被别的线程吸收：另一个线程正在跑一次「扔掉结果」的 spawn 时，主线程首次
  spawn 只要 20–25 ms。后端 bootstrap 第一步正好需要 spawn（附件/工作区相关），于是每次
  启动都恒定卡 3.3 s。修法是 `pc-server/foundation/spawn-warm.ts`：进程一起来就在独立
  Worker 里 spawn 一个 `cmd /c exit` 垫掉首次开销，15 s 兜底、失败静默、绝不影响启动。
  注意 **`bun --compile` 不会把按路径引用的 Worker 打进可执行文件**（三种写法都实测失败：
  `new Worker("./x.ts")`、`new URL(...)` 形式解析到 `B:\~BUN\root\…`、`?worker` 导入直接
  报错），所以 worker 源码必须走 `URL.createObjectURL(new Blob([…]))` 内联。
- **本机死端口的 TCP 连接不会快速失败**：这台机器上连一个没人监听的 loopback 端口要
  ~2 s 才报错，活端口 ~8 ms 就 accept。壳原本对最多 20 个端口并行探活，`Task.WaitAll(…, 2500)`
  直接打满。改成先用带 150 ms 预算的 `BeginConnect` 筛一遍、只有没被否掉的端口才走 HTTP
  `Probe`，同时 `ThreadPool.SetMinThreads(32, …)`（默认线程注入是 ~1 线程/500 ms，
  并行扇出会被饿死）。
- **别在这两处花力气**（都实测过、都不是瓶颈）：前端 JS 体积（2.34 MB `modulepreload`，
  localhost 上每个文件 1–2 ms）、`loadState()` 灌库（17 ms）、WebView2 初始化（~0.6 s）。

取证入口：`pc-data/logs/server.boot.pending.<pid>.log`（正常退出会自删）、同目录
`shell.log`（壳会把后端 stdout 每行加 `[server]` 前缀与毫秒时间戳转写进去）、
`desktop-shell/cdp-startup.js`。用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
=--remote-debugging-port=9333` 打开调试端口；测完请用应用内退出或
`POST /api/app/shutdown` 收尾，别 `taskkill`（会在壳日志留 `server exited unexpectedly`，
并可能触发「上次未正常退出」告警与崩溃存档）。

## 9. 发布你自己的版本前，必改的两处

1. **更新检查指向的仓库**：`pc-server/api/handlers/update.ts` 里的
   `const repo = "yuh-G/rikkahub-desktop"` 决定「检查更新」去哪个 GitHub Release 取版本。
   保持现状 = 你的构建会提示升级到上游的包（会覆盖你的版本）；改成你自己的仓库并
   自己发 Release 才符合分支语义。
2. **Windows 下载源**：`pc-server/updates/index.ts` 的 `UPDATE_R2_BASE` 指向上游维护者的
   公开 R2 桶。若你自建分发，换掉它；不换的话至少知道下载链接不来自你。

改 Tauri 打包身份时还有：`web-ui/src-tauri/tauri.conf.json` 的 `identifier` / `publisher` /
`copyright`，与 `Cargo.toml` 的 `authors`。另外「设置 → 关于」页里有三条硬编码链接
（`web-ui/app/components/settings/about.tsx`：官网 `rikkahub-desktop.pages.dev`、GitHub 仓库、
LICENSE 页）和 `web-ui/app/components/startup-gate.tsx` 的「反馈 issue」链接，全都指向上游；
本分支不发安装包，保留它们是为了让使用者能找到官方下载，你要自己发版就把这几处换成自己的地址。
`LICENSE` 里的商业授权联系方式属于上游维护者，
分发本分支时请连同它一起保留（AGPL v3 与上游双许可都要求保留声明）。

## 10. macOS

没有 mac 设备 → 不编译、不签名、不验证，因此不提供 mac 构建目标，也不接 mac 相关的
「已支持」预期。`web-ui/src-tauri` 里上游留下的 mac target 定义原样保留，能编算你运气好，
编不过属于已知范围外的支持请求，开 issue 时请附你的构建日志，并默认按「需社区共同验证」处理。
