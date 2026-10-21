<div align="center">
  <img src="docs/icon.png" alt="RikkaHub Desktop PLUS" width="96" />

  <h1>RikkaHub Desktop PLUS</h1>

  <p>Windows、Linux 与 Docker 自托管的 LLM 桌面客户端 · 多供应商 · 本地数据优先</p>

  <p>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0%20%7C%20Commercial-2f81f7"></a>
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Docker-3fb950">
    <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun%201.4.2-f472b6">
    <img alt="Windows shell" src="https://img.shields.io/badge/Windows%20shell-WinForms%20%2B%20WebView2-0078d4">
    <img alt="Maintenance" src="https://img.shields.io/badge/maintenance-low%20frequency-orange">
  </p>
</div>

---

**RikkaHub Desktop PLUS** 是 [RikkaHub Desktop](https://github.com/yuh-G/rikkahub-desktop) 的社区增强分支，由 [@ODO-TECH](https://github.com/ODO-TECH) 维护。在保留上游全部能力的前提下，本分支集中改进四个方面：Windows 原生桌面体验、本地数据的结构化存储与备份粒度、本地与远程工具链（stdio MCP、SSH），以及面向 Linux NAS 的容器化部署。

Windows 便携版安装包在本仓库的 [Releases](https://github.com/ODO-TECH/Rikkahub-desktoPLUS/releases) 提供，与仓库源码同版本；除此之外没有自动构建通道，应用内的更新检查仍指向上游仓库。项目名中的 PLUS 只代表本分支的增量，不属于上游品牌；数据目录、环境变量前缀与技术标识符保持不变，可与上游版本共用同一份 `pc-data/`。

## 目录

- [与上游的关系](#与上游的关系)
- [相对上游的变更](#相对上游的变更)
- [冷启动优化](#冷启动优化)
- [平台支持](#平台支持)
- [快速开始](#快速开始)
- [构建](#构建)
- [容器部署（Docker / 飞牛 OS）](#容器部署docker--飞牛-os)
- [仓库结构](#仓库结构)
- [数据目录与备份](#数据目录与备份)
- [配置参考](#配置参考)
- [已知限制](#已知限制)
- [隐私与网络行为](#隐私与网络行为)
- [维护状态](#维护状态)
- [参与贡献](#参与贡献)
- [许可](#许可)
- [致谢](#致谢)
- [English summary](#english-summary)

## 与上游的关系

| 层级 | 项目 | 关系 |
| --- | --- | --- |
| 1 | [RikkaHub](https://github.com/rikkahub/rikkahub)（[@re-ovo](https://github.com/re-ovo)，Android） | 产品设计、品牌与理念的来源 |
| 2 | [RikkaHub Desktop](https://github.com/yuh-G/rikkahub-desktop)（Tauri + Bun） | 本分支的直接上游 |
| 3 | 本仓库（RikkaHub Desktop PLUS） | 基于上游源码的社区增强分支，由 ODO-TECH 维护 |

本分支与上游没有隶属关系，也不代表上游发布任何内容。版本号基线为 `2.0.0-preview-v5`，与上游同版本号；功能取舍以本分支的维护方向为准，不保证与上游逐项一致。

需要现成安装包时，请使用上游 Releases。上游安装包不包含本分支的任何改动。

## 相对上游的变更

| # | 方向 | 变更摘要 |
| --- | --- | --- |
| 1 | 语音输入 | 新增 MiMo ASR（HTTP 分段转写），仅支持听写 |
| 2 | MCP | 新增本地 stdio 传输与 JSON 导入；移除 SSE |
| 3 | 本地数据 | 会话、消息、记忆迁入 SQLite，提供存储概览 |
| 4 | Windows 桌面 | 新增 WebView2 原生壳（非 Electron），冷启动约 6.3 s → 1.9 s |
| 5 | SSH | 新增远程设备管理、连接测试与单次命令执行 |
| 6 | Kelivo | 支持 8 类数据导入与 schema v3 格式导出 |
| 7 | 备份 | 12 项 `backupScope` 统一管理本地 / WebDAV / S3 / Kelivo |
| 8 | 网络 | 端口设置移入数据管理，支持保存并重启 |
| 9 | 部署 | Docker 镜像改为可用的 Debian slim 运行时，新增飞牛 OS compose 与 NAS 目录挂载（见[容器部署](#容器部署docker--飞牛-os)） |

### 1. MiMo 语音识别

- 走 HTTP 分段转写（模型 `mimo-v2.5-asr`，约 30 秒一段），前端负责录音与自动分段。
- **仅支持听写。** MiMo 未提供 realtime 或 VAD 端点，因此没有实时语音通话模式；选中 MiMo 时通话入口自动隐藏，添加供应商时会明确提示，避免出现入口可见但不可用的状态。

### 2. 本地 MCP

- 传输类型收敛为 `streamable_http` 与 `stdio` 两种（`pc-server/tools/mcp-import.ts`）。
- stdio server 以子进程方式启动，支持 `command`、`args`、`env`、`cwd`。
- 支持导入 Claude Desktop / Cursor / VS Code / Cline 风格的 `mcpServers` JSON，导入项默认**停用**，需手动启用。
- 已移除 SSE 传输：读取历史配置时统一归一为 `streamable_http`；导出到 Android 时剥离 stdio 条目。
- stdio 不参与 OAuth 流程（本地子进程没有回调端口语义）。

### 3. 本地数据

- 会话活库为 SQLite（`pc-data/rikka_hub.db`，WAL），表结构：

  | 表 | 内容 |
  | --- | --- |
  | `pc_conversation` | 会话 |
  | `pc_message_node` | 消息节点（流式写入只 upsert 当前节点） |
  | `pc_message_fts` | FTS5 全文索引 |
  | `pc_workspace` | 工作区 |
  | `pc_memory` | 助手记忆 |
  | `pc_memory_pending` | 待确认记忆 |
  | `pc_meta` | 元数据 |

- 助手记忆、待确认记忆与工作区由同一存储层管理；`settings` 仍为 JSON（`pc-data/state.json`）。
- 从旧格式升级时执行一次性迁移，保留回退路径。
- 列表分页与排序下推到 SQL，不再整库读入内存。
- 设置页新增存储概览，按数据类型展示条目数量与占用体积。

### 4. Windows 桌面壳

- `desktop-shell/` 为 WinForms + 系统 Edge WebView2 实现，**不是 Electron**，不捆绑 Chromium。
- 复用系统的 Edge WebView2 运行时（Windows 10 / 11 随 Edge 提供）；检测不到时会提示并打开微软官方下载页，不会静默失败。安装体积不随 Chromium 增长。
- 壳负责：隐藏拉起后端、启动屏、托盘常驻或直接退出、Job Object 防止孤儿子进程、`rikkahub://restart` 自定义协议重启，并向页面注入 `window.__RIKKAHUB_SHELL__`。
- 使用系统自带的 `csc.exe`（.NET Framework 4.8）单文件编译，不需要 Visual Studio。
- Tauri 壳保留（上游形态；Linux 打包与 NSIS 安装包依赖它），两种壳可共存。

### 5. SSH 远程设备

- 接口：设备增删改、排序、连接测试、单次命令执行（`ssh/device`、`ssh/reorder`、`ssh/test`、`ssh/exec`）。
- 支持密码与私钥（可带 passphrase）两种认证方式；基于 `ssh2`。
- 凭据保存在本地设置 `settings.sshDevices`（`state.json`），不随 Android 备份导出。
- 当前不提供交互式 shell、SFTP 与端口转发。

### 6. Kelivo 同步与数据互传

- 导入：支持 8 类数据（对话、助手、记忆、模型设置、世界书、提示词注入、快捷消息、搜索引擎），可按类多选。
- 导出：Kelivo schema v3，双 zip 结构；本地备份、WebDAV、S3 默认附带该包，可在设置中关闭。
- 附件不参与 Kelivo 导出，避免两端媒体目录语义冲突。

### 7. 多选项数据备份

`backupScope` 共 12 项，统一控制本地备份、WebDAV、S3 与 Kelivo 的内容：

| 项 | 内容 |
| --- | --- |
| `conversations` | 对话与消息 |
| `assistants` | 助手与标签 |
| `memories` | 长期记忆 |
| `models` | 供应商与模型 |
| `worldBooks` | 世界书 |
| `promptInjections` | 提示词注入 |
| `quickMessages` | 常用语 |
| `searchServices` | 搜索引擎配置 |
| `attachments` | 附件 |
| `skills` | 技能 |
| `fonts` | 自定义字体 |
| `globalAgents` | 全局工作区指引 |

Kelivo 的 8 类选项由同一份 `backupScope` 派生，避免两套开关各自为政。恢复前可查看包内实际内容。

### 8. 网络与端口

- 端口设置位于「设置 → 数据管理 → Web 服务」，直接输入端口号，提供「保存」与「保存并重启」。
- 桌面默认端口 `17455`；容器内固定 `11451`（镜像契约；114514 超出 TCP 端口上限 65535）。
- 默认只监听回环地址（`127.0.0.1` 与 `::1`）；需要局域网或反向代理访问时，用 `--host 0.0.0.0` 或 `RIKKAHUB_HOST` 显式开放，并同时设置访问密码。

## 冷启动优化

便携版冷启动由约 6.3 s 降至约 1.9 s（单机实测，Windows x64）。两个平台层缺陷被定位并规避：

| 阶段 | 优化前 | 优化后 | 手段 |
| --- | --- | --- | --- |
| 定位后端 | 1.91 s | 0.18 s | 壳侧 150 ms 预算的 `BeginConnect` 探活，跳过不可用端口 |
| 后端 bootstrap | 3.27 s | 0.03 s | 用 Blob Worker 预热 Bun/Windows 首次 `spawn` |
| 合计 | 6.3 s | 1.9 s | — |

根因：Bun 在 Windows 上首次 `Bun.spawn` / `spawnSync` 会同步阻塞约 3.1 s；对不可用回环端口的连接尝试需 0.6–2 s 才失败。实现细节与「不要优化这些」清单见 [docs/BUILD.md](docs/BUILD.md)。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10 / 11 x64 | 主要目标 | 便携版 + WebView2 壳；Tauri NSIS 安装包需要 MSVC 与 Rust |
| Linux x64 | 构建链保留 | 上游打包方式与 Dockerfile 可用；本分支未在真实 Linux 主机上验证 |
| Docker（amd64 / arm64） | 支持 | Debian slim 运行时，自带 bash、zip/unzip 与字体注册；面向飞牛 OS 等 Linux NAS 提供 compose 编排 |
| macOS | 不支持 | 维护者没有 Mac 设备，无法构建、签名与验证；上游 Tauri 的 mac 配置保留但明确不受支持 |
| Android | 不适用 | 见上游 RikkaHub |

## 快速开始

### 前置要求

- [Bun](https://bun.sh/) **1.4.2**（与 CI、Dockerfile 保持同一版本）
- Git；Windows 上建议安装 Git for Windows（内嵌 bash 运行时从其安装目录抽取）

### 还原 pi 引擎（首次必须）

对话与工具编排引擎来自 [earendil-works/pi](https://github.com/earendil-works/pi)，源码不随本仓库分发，只跟踪补丁与模型数据快照：

```bash
git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi
cd pi
git checkout d981de1229ef899957bbe968bc8dcda02a21f477
git reset --hard
git apply ../pi-patches/*.patch
bun install
mkdir -p packages/ai/src/providers/data
cp ../pi-model-data/*.json ../pi-model-data/.manifest.json packages/ai/src/providers/data/
cd ..
```

### 源码运行

```bash
# 终端 A：后端，http://localhost:17455
cd pc-server && bun install && bun run server.ts

# 终端 B：前端，http://localhost:5173（/api 代理到 17455）
cd web-ui && bun install && bun run dev
```

仅调试界面时可直接在浏览器打开 `http://localhost:5173`，自定义标题栏会自动隐藏。

## 构建

### Windows 便携版

```bash
cd pc-server
bun run compile        # → ../dist/rikkahub-pc.exe（单文件，约 117 MB）
```

### Windows 桌面壳

```bash
cd desktop-shell
fetch-sdk.cmd          # 下载并解压固定版本的 WebView2 SDK
build.cmd              # → dist\RikkaHub.exe
```

### Tauri 安装包与内嵌 bash 运行时

Tauri NSIS 流程、内嵌 bash bundle 的生成与便携版目录布局见 [docs/BUILD.md](docs/BUILD.md)。

## 容器部署（Docker / 飞牛 OS）

镜像与 compose 文件在仓库根目录，面向飞牛 OS 与其他 Linux NAS：浏览器访问界面，后端与数据都在容器里。
完整的构建参数、反向代理与排障细节见 [docs/DOCKER.md](docs/DOCKER.md)。

### 端口

容器内固定 **11451**。TCP 端口合法范围是 1–65535，`114514` 超出上限会被内核与 `docker -p` 拒绝，所以取同一串数字的有效前缀。
宿主机端口可用 `RIKKAHUB_HTTP_PORT` 覆盖；容器内不做端口顺延，端口冲突会直接启动失败。桌面版默认端口仍是 `17455`，两者互不影响。

### 快速启动

把仓库放到 NAS 上（例如 `/vol1/1000/docker/rikkahub-desktop-plus`），在仓库根目录执行：

```bash
docker compose up -d --build
docker compose logs -f
```

首次构建要在容器内克隆 pi 引擎、编译前后端，耗时数分钟到十几分钟；之后复用构建缓存，`docker compose up -d` 几秒即可。
构建阶段能访问 GitHub 时无需额外配置；NAS 出网受限时，取消 `docker-compose.yml` 里 `build.args` 的注释并填入代理。

启动完成后打开 `http://<NAS 地址>:11451`，在「设置 → 数据管理 → Web 服务」里设置访问密码。
不设密码时，同一网段内任何人都能读写会话与 API Key。

不用 compose 时：

```bash
docker build -t rikkahub-desktop-plus:2.0.0-preview-v5 .
docker run -d --name rikkahub-plus --restart unless-stopped \
  -p 11451:11451 \
  -e RIKKAHUB_PASSWORD='换成你的密码' \
  -v "$PWD/pc-data:/app/pc-data" \
  rikkahub-desktop-plus:2.0.0-preview-v5
```

### 容器内目录

```text
/app/
├── rikkahub-pc                 # Bun 单文件后端（linux/amd64、linux/arm64）
├── web-ui/build/client/        # 前端 SPA 静态资源
├── icons/                      # 供应商与品牌图标
├── fonts/                      # 内置字体，已注册给 fontconfig
└── pc-data/                    # 唯一需要持久化的目录（VOLUME）

/workspace/<名字>/              # 可选：宿主目录的挂载点，镜像内不预建
```

只有 `/app/pc-data` 必须挂载，里面是设置、SQLite 会话库、附件、技能、字体、工作区与记忆快照。
**不要**把宿主目录挂到 `/app` 或 `/app/web-ui`，那会覆盖镜像内的程序文件。

| `pc-data` 路径 | 内容 |
| --- | --- |
| `state.json` | 全部设置：供应商与 API Key、WebDAV / S3 凭据、SSH 私钥、备份开关 |
| `rikka_hub.db`（含 `-wal` / `-shm`） | 会话、消息、全文索引、工作区、记忆 |
| `files/` | 附件 |
| `skills/`、`fonts/` | 技能与自定义字体 |
| `workspaces/` | 托管型工作区 |
| `memory/`、`AGENTS.md` | 记忆快照与全局工作区指引 |
| `logs/`、`tmp/`、`updates/`、`pi-agent/` | 取证日志、暂存区、更新缓存、引擎工作目录 |

### 挂载 NAS 目录作为工作区

需要让 agent 读写 NAS 上的真实目录时，把宿主目录挂到容器内的 `/workspace/<名字>`：

```yaml
    volumes:
      - ./pc-data:/app/pc-data
      - /vol1/1000/documents:/workspace/docs
```

`docker compose up -d` 后，用 `docker exec rikkahub-plus ls -la /workspace/docs` 确认能看到文件。
然后在应用里新建**文件夹型工作区**，路径填 **容器内路径** `/workspace/docs`，而不是 NAS 上的宿主路径；创建后会弹出信任授权窗口。

- 多目录就加多行，容器内路径不要重名；只读挂载加 `:ro`。
- 路径含空格或中文时整行加引号。
- 容器默认以 root 运行，挂载目录里新建的文件在 NAS 上归 root。要归属飞牛普通用户，用 compose 里的 `user: "1000:1000"`，先 `chown` 宿主目录，并同时设置 `HOME: "/tmp"`。
- 备份与迁移只覆盖 `pc-data/`，挂载目录不在备份范围内，需要 NAS 侧自行快照。
- 「完全访问」档位下写入不逐条审批，只挂载确实需要的目录。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RIKKAHUB_PASSWORD` | 空 | Web 访问密码；留空 = 不鉴权 |
| `RIKKAHUB_HTTP_PORT` | `11451` | 仅 compose：宿主机映射端口 |
| `PORT` | `11451` | 容器内监听端口；改动需同步端口映射 |
| `RIKKAHUB_ANALYTICS` | `0` | 镜像默认关闭匿名统计；设 `1` 会向**上游**端点上报 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 空 | 容器内代理模式固定为 `env`，应用内自动检测不生效 |
| `RIKKAHUB_PC_DATA_DIR` | `/app/pc-data` | 数据目录；改动时挂载点要跟着改 |

容器检测（`/.dockerenv` 或 `RIKKAHUB_CONTAINER=1`）成立时，服务监听 `0.0.0.0`、锁定端口、禁用原地更新与端口设置，因此 `RIKKAHUB_HOST` 不需要设置。

### Linux 适配点

- 运行时为 `debian:bookworm-slim`，agent 的 bash 工具走 `/bin/bash`，不再因 distroless 缺 shell 而停用。
- `zip` / `unzip` 在 `PATH` 上，备份导出与 ZIP 导入可用；`curl` 支撑健康检查。
- 内置字体通过 fontconfig 注册，`fc-list` 能枚举 HarmonyOS Sans、Noto Serif SC 等。
- 健康检查每 30 秒请求 `/api/health`；该端点不含用户数据，设置密码后仍可探测，容器不会假死。
- 升级走 `git pull` + `docker compose up -d --build`，容器内不下载更新包；`pc-data/` 不受影响。

容器里不可用的 Windows 专有能力、语音输入的安全上下文限制、stdio MCP 缺少 Node/npm 等已知限制，见 [docs/DOCKER.md](docs/DOCKER.md) 第 8 节。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `pc-server/` | Bun 后端：会话、推理引擎、MCP、备份、SSH、工作区 |
| `web-ui/` | React 19 + React Router 7 前端 SPA（Tailwind v4、shadcn/ui） |
| `web-ui/src-tauri/` | 上游 Tauri v2 壳（Windows 安装包、Linux 打包） |
| `desktop-shell/` | 本分支的 Windows 原生壳（WinForms + WebView2） |
| `pi-patches/` | 给 pi 引擎的受控补丁 |
| `pi-model-data/` | 与 pi 基线严格配对的模型目录快照 |
| `fonts/`、`icons/` | 内置字体与供应商图标 |
| `functions/` | 上游的 Cloudflare Pages 统计端点源码 |
| `Dockerfile`、`docker-compose.yml` | 容器镜像与飞牛 OS / Linux NAS 部署编排；运行时 `debian:bookworm-slim` |
| `docs/` | 构建、发布、容器部署与排查文档 |
| `LICENSE`、`LICENSE-AGPL-3.0.txt` | 分段双许可的条款声明，与其中引用的 AGPL v3 协议全文 |
| `.github/` | CI、Linux 产物与 Docker 发布工作流 |

## 数据目录与备份

所有运行时数据位于 `pc-data/`（可用 `RIKKAHUB_PC_DATA_DIR` 指向其他目录），已被 `.gitignore` 排除：

```text
pc-data/
├── state.json              # 设置
├── rikka_hub.db            # 会话、消息、工作区（SQLite，WAL）
├── files/                  # 附件
├── skills/                 # 技能
├── fonts/                  # 自定义字体
├── workspaces/             # 工作区托管目录
├── memory/                 # 记忆相关文件
├── AGENTS.md               # 全局工作区指引
├── updates/                # 已下载的更新包缓存
└── logs/                   # 仅在上次异常退出时保留取证日志
```

备份导出时另生成 Android 兼容的会话库，与活库在表名和 schema 上分离。导出内容由 `backupScope` 的 12 项决定，可分别写入本地 zip、WebDAV、S3 与 Kelivo；导出不含 SSH 凭据、界面 origin 记录与设备 ID。

## 配置参考

### 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--port <n>` / `--port=<n>` | 监听端口；优先于 `PORT` 与设置项 |
| `--host <addr>` | 监听地址，默认回环 |
| `--no-open` | 不自动打开浏览器（容器与桌面壳使用） |
| `--dev` | 开发模式 |
| `--password <pw>` | 设置 Web 访问密码 |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口 |
| `RIKKAHUB_HOST` | 监听地址 |
| `RIKKAHUB_PC_DATA_DIR` | 数据目录，默认为应用目录（源码运行时为仓库根，便携版为 exe 所在目录）下的 `pc-data` |
| `RIKKAHUB_PASSWORD` | Web 访问密码 |
| `RIKKAHUB_ANALYTICS` | `1` / `0` 强制开启或关闭匿名统计（见下节） |
| `HTTP_PROXY` / `HTTPS_PROXY` | 出站代理 |

端口被占用时会按顺序尝试后续端口；容器内不重试，端口由镜像与 `-p` 映射决定。

## 已知限制

- **macOS 不受支持。** 没有 Mac 设备，无法构建、签名或验证产物，相关定义仅为上游遗留。
- **SSH 能力有限。** 仅支持设备管理与单次命令执行，没有交互式 shell、SFTP、端口转发。
- **MiMo 没有实时语音。** 仅听写，无实时通话模式。
- **SSE 已移除。** 依赖 SSE 语义的第三方配置需改为 Streamable HTTP。
- **Kelivo 导出不含附件。**

## 隐私与网络行为

- 无账号体系，数据默认全部保存在本机 `pc-data/`；API 密钥保存在本地设置中。
- 不采集对话内容、模型名、文件名或查询词。
- **编译版（单文件 exe）默认发送匿名启动统计**：设备 UUID、日期、版本、操作系统，以及当日计数（消息数、活跃分钟、供应商失败数、搜索 / TTS / MCP / 图像生成次数）。启动时与每 10 分钟各发送一次，发往上游域名。设置 `RIKKAHUB_ANALYTICS=0` 可完全关闭；源码运行（`bun run server.ts`）默认不上报。
- 编译版启动时会向上游 GitHub Releases 静默检查一次更新，仅在存在新版本时弹出提示；可跳过指定版本，网络错误静默处理。
- 提交 Issue 前请先脱敏：日志正文、截图与配置中可能包含 API 密钥、WebDAV / S3 凭据或 SSH 主机信息。

## 维护状态

本分支为**低频、长期维护**：

- 没有路线图与 SLA，不承诺功能时间点；提交间隔从数周到数月不等。
- 合并前要求：`bun run typecheck` 通过、`bun test` 通过、便携版实机冒烟通过。
- 数据格式变更必须附带一次性迁移与回退路径。
- 不接受改变上游许可条款的改动。

## 参与贡献

- Bug 与功能建议请开 Issue，并使用仓库内的 Issue 模板填写环境与复现步骤。
- 欢迎 PR，但不保证合并；改动需通过上述验证要求。
- 提交前请确认没有引入个人数据、本机路径或凭据。

发布流程见 [docs/PUBLISH.md](docs/PUBLISH.md)，构建细节见 [docs/BUILD.md](docs/BUILD.md)。

## 许可

本分支沿用上游的分段双许可（Segmented Dual Licensing），**不改变条款**：

- 个人、教育、研究与非商业用途，或用户数不超过 50 的组织：**GNU AGPL v3**（全文见 [LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)，逐字取自 [gnu.org](https://www.gnu.org/licenses/agpl-3.0.txt)）。
- 商业用途或超过 50 人：需按 [LICENSE](LICENSE) 中的联系方式取得商业授权。

`LICENSE` 是条款声明（不改动上游原文），`LICENSE-AGPL-3.0.txt` 是它所引用的协议全文，两者互为补充，不构成额外的许可授予。`LICENSE` 内的商业授权联系方式属于上游维护者，本分支作者不提供商业授权或相关承诺。衍生分发需遵守 AGPL v3，包括公开修改后的源码。

## 致谢

- [@re-ovo](https://github.com/re-ovo) 与 [RikkaHub](https://github.com/rikkahub/rikkahub)
- [yuh-G/rikkahub-desktop](https://github.com/yuh-G/rikkahub-desktop)
- [@Noah0932](https://github.com/Noah0932)（Debian / Ubuntu、Arch 打包）、[@AstralFlare-owo](https://github.com/AstralFlare-owo)（Nix / NUR）
- [earendil-works/pi](https://github.com/earendil-works/pi)（对话与工具编排引擎）
- [Chevey339/kelivo](https://github.com/Chevey339/kelivo)（互传对端格式）

## English summary

**RikkaHub Desktop PLUS** is an enhanced community fork of **RikkaHub Desktop**, maintained by [@ODO-TECH](https://github.com/ODO-TECH). It focuses on four areas: native Windows desktop experience, structured local storage with finer backup granularity, local/remote tooling, and container deployment for Linux NAS.

Included in this branch:

- **MiMo speech-to-text** — chunked HTTP transcription, dictation only (MiMo exposes no realtime/VAD endpoint).
- **Local MCP over stdio** — subprocess servers with `command` / `args` / `env` / `cwd`, and JSON import from Claude Desktop / Cursor / VS Code / Cline (imports disabled by default). The SSE transport has been removed; legacy configs are normalized to Streamable HTTP.
- **SQLite-backed local data** — conversations, message nodes, FTS5 index, assistant memory, pending memory and workspaces, with a one-time migration that keeps a rollback path, plus a storage-overview panel.
- **Native Windows shell** — WinForms + the system Edge WebView2 runtime (not Electron, no bundled Chromium), cutting cold start from ~6.3 s to ~1.9 s.
- **SSH remote devices** — create/update/reorder/test and one-shot command execution; no interactive shell, SFTP or tunnelling.
- **Optional Kelivo sync** — 8 import categories, schema-v3 export, attachments excluded.
- **12-item `backupScope`** — a single set of switches governing local, WebDAV, S3 and Kelivo backups.
- **Docker / Linux NAS deployment** — a `debian:bookworm-slim` runtime with bash, zip/unzip and fontconfig, a `docker-compose.yml` tuned for fnOS, a fixed container port of 11451, and `/workspace/<name>` mounts for NAS folders used as agent workspaces.

Platforms: Windows 10/11 x64 is the primary target. Linux binaries and the multi-arch container image are built by the included workflows; the container path is verified in container mode but not on physical Linux hardware. **macOS is not supported** — no Mac hardware is available to build, sign or verify it.

Maintenance is low-frequency but long-term, with no roadmap or SLA. Every change is type-checked, unit-tested and smoke-tested on a portable build before it lands. Source only: no binaries, installers or update channel are published here. Licensed under the same segmented dual licensing as upstream (AGPLv3 for non-commercial, personal, educational or research use, or organizations with at most 50 users; the terms are stated in [LICENSE](LICENSE) and its referenced full text is [LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt) — the commercial contact details belong to the upstream maintainer).

Compiled builds send an anonymous startup counter (device UUID, date, version, OS and daily counters — no message content, IP, model names, file names or queries); set `RIKKAHUB_ANALYTICS=0` to disable it.
