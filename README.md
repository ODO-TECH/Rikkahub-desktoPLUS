<div align="center">
  <img src="docs/icon.png" alt="RikkaHub 图标" width="100" />
  <h1>RikkaHub Desktop · 社区分支</h1>

  原生 Windows 桌面 LLM 聊天客户端，多供应商切换、本地数据优先、无遥测、无云端账号。<br/>
  也能在 Linux / Docker 上跑。macOS 不做（见下文）。

  Community fork of **RikkaHub Desktop** — 一个基于 Android 版 RikkaHub 移植到桌面的项目。
</div>

---

## 这是什么，和谁是什么关系

三层关系，从上到下：

1. [RikkaHub](https://github.com/rikkahub/rikkahub) —— [@re-ovo](https://github.com/re-ovo) 的 Android 原生
   LLM 客户端。产品设计、品牌与理念的全部来源。
2. [RikkaHub Desktop](https://github.com/yuh-G/rikkahub-desktop) —— 上面那个产品的 PC 移植版
   （Tauri + Bun 后端），本分支的**直接上游**。
3. **本仓库** —— RikkaHub Desktop 的**社区分支**：把 PC 版继续朝「本地数据结构化 + Windows
   桌面体验 + 本地/远程工具链」方向打磨。功能取舍按我自己日常使用的判断来，不追求和上游一致。

现成安装包请用上源的 Releases；**本分支只发布源码**，不提供二进制下载（原因见
[docs/BUILD.md](docs/BUILD.md)：Windows 安装包需要本机 MSVC/Rust 工具链，我没有把它做成 CI 流水线）。

## 更新节奏：缓慢但长期

一句实话：**我是业余时间维护，更新很慢，但不会弃更。**

- 没有 roadmap，没有 SLA，不承诺任何功能的时间点；提交间隔可能几周也可能几个月。
- 每个进来的改动都在自己机器上真跑过（typecheck + 单元测试 + 便携版实测），
  所以宁可慢也不想推半成品。
- Issue 会看，PR 欢迎，但不保证合并；改动要能过我这边的实测。
- 数据格式变更一律带一次性迁移与回退路径，不会出现「升级后老备份打不开」。

如果你需要一个稳定可用的安装包，上游更合适；如果你想找一个把桌面端细节（本地 MCP、
结构化数据、备份粒度、原生壳启动速度）持续往前推的分支，可以看这里。

## 本分支相对上游做了什么

### 1. MiMo 语音识别（听写）

新增 [MiMo](https://github.com/XiaomiMiMo) 的 ASR 支持：走 HTTP 分段转写
（`mimo-v2.5-asr`，约 30 秒一段），配合前端的录音与自动分段。
**边界说清楚**：MiMo 没有 realtime / VAD 端点，所以它只有「按住说话 → 出文字」的听写，
没有和其他供应商那样的实时语音通话模式；选中 MiMo 时通话入口会自动隐藏，添加供应商时
也会弹窗告知，不做「点了没反应」的假支持。

### 2. 本地 MCP（stdio），并去掉了 SSE

- **stdio 传输**：MCP server 可以是本机一条命令拉起的子进程（`command` + `args` +
  `env`），与 Streamable HTTP 远程 server 同级，不再要求必须先有个 HTTP 端口。
- 支持从 **JSON 配置整体导入**（Claude / Cursor 那类 `mcpServers` 格式），导入的 server
  默认**停用**状态，避免一条没审过的命令直接在本机执行。
- **移除 SSE 传输**：上游的 `sse` 类型已废弃，读老配置时统一归一成 `streamable_http`
  （老数据不会坏），代码里不再保留两条 HTTP 分支。
- stdio 不参与 OAuth 流程（本地子进程场景没有回调端口意义），导出给 Android 端时
  会剥离 stdio 条目——手机起不了你电脑上的进程。

### 3. 本地数据的结构化管理

上游大量状态落在单个 `state.json`。本分支把结构化数据真正放进 SQLite：

| 内容 | 位置 |
|---|---|
| 会话元数据 / 消息节点（分支树） | `pc_conversation`、`pc_message_node` |
| 全文搜索 | `pc_message_fts`（FTS5，标题/内容搜索走它） |
| 助手记忆 | `pc_memory` 表（原先在 JSON 里） |
| 待确认的记忆提案 | `pc_memory_pending` 表 |
| 工作区 | `pc_workspace` |
| 设置、恢复链 | 仍在 `state.json`（改表收益低、风险高，刻意保留） |

列表分页/排序下推到 SQL（复合索引），不再把整库读进内存；设置页新增**数据存储概览**卡片，
能看到各类条目数量与库体积。所有迁移都带一次性脚本 + 回退路径。

### 4. Windows 桌面壳（`desktop-shell/`，不是 Electron）

一个 ~200 KB 的原生壳：**WinForms + 系统 Edge WebView2**。这里要纠正一句常见的说法——
它**不是 Electron**，也不打包 Chromium：

- 复用 Windows 10 1809+ / Windows 11 自带的常青 WebView2 运行时，安装包不必多塞 100 MB+，
  也不必跟着 Chromium 的 CVE 一起加班。
- 壳负责：隐藏拉起/接管后端、启动屏、托盘常驻或直接退出、Job Object 防孤儿子进程、
  `rikkahub://restart` 自定义协议重启、给页面注入 `window.__RIKKAHUB_SHELL__`。
- 用系统自带的 `csc.exe`（.NET Framework 4.8）单文件编译，不需要 Visual Studio。
- 冷启动从约 **6.3 s 压到约 1.9 s**。两处瓶颈都是平台坑，写在
  [docs/BUILD.md](docs/BUILD.md) 里：Bun 1.4.2/Windows 一个进程内的**首次** `Bun.spawn`
  会同步阻塞 3.1 s（用一个 Blob Worker 提前垫掉），以及本机死端口 TCP 连接要 0.6–2 s
  才失败（壳侧改成带预算的探活）。

Tauri 壳仍然保留着（上游形态、Linux 打包和 NSIS 安装包都依赖它），两个壳可以共存。

### 5. SSH 连接远程设备

设置里可登记多台 SSH 设备（主机/端口/用户名/密码或私钥或 agent），支持连通性测试、
排序，以及在远端执行一次性命令并把结果交回给对话/工具链。

**当前边界**（是取舍，不是遗漏）：只做「一条命令进、结果出」，没有持久交互终端、
没有端口转发、没有 SFTP 文件浏览。凭据保存在本地 `settings.sshDevices`（即 `state.json`），
**不随导出进 Android 备份**，也不会写进日志。

### 6. 与 Kelivo 的可选同步 / 数据互传

[Kelivo](https://github.com/Chevey339/kelivo) 是另一套移动端角色卡/会话格式。本分支把它做成
**可选**的双向通道：

- 导入：按 8 个类别**多选**（会话、角色卡、世界书、提示词注入、快捷消息、模型、
  助手、记忆），要哪类拿哪类。
- 导出：按 Kelivo 的 schema v3 生成它认得的双 zip 包；本地备份 / WebDAV / S3 三种落点
  默认**附带** Kelivo 包，可以在设置里关掉。
- 附件（图片/文件）不参与互传，避免两个项目的媒体目录语义互相踩。

### 7. 多选项的详细数据备份

一个 `backupScope`（12 项）统管所有同步通道 —— 会话、助手、记忆、模型、世界书、
提示词注入、快捷消息、搜索服务，加附件、Skills、字体、全局 Agent。本地快照、WebDAV、
S3、Kelivo 导出都读同一份勾选，不用在各处分别配一遍；恢复前能看到包里到底有什么。
同步相关的端口设置也做了统一（纯文本直输、区分「保存」与「保存并重启」、8080 冲突提醒）。

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows 10 / 11 | 主战场。Tauri 安装包 / 便携版 zip，或自己编 `desktop-shell` 的原生壳。 |
| Linux | 上游支持，本分支同样跑通：便携 `.tar.gz`、`.deb`、`.pkg.tar.zst`、多架构 Docker（amd64/arm64）。 |
| Docker | `docker build -t rikkahub-pc .`，镜像基于 distroless，见下节。 |
| **macOS** | **不做。** 我手上没有 Mac 设备 —— 没法编译、没法签名、没法验证任何一个像素。仓库里的 `web-ui/src-tauri` 保留了上游的 mac 目标定义，但**不承诺它能构建成功**，也不接受 mac 相关的 bug 报告当作已支持功能。真有 Mac 环境愿意一起验证的，开 issue 说，我们把验证成本摊平。 |

## 快速开始

只需要 [Bun](https://bun.sh/) 1.4.2 和一个能跑 `bash` 的 Git（Windows 上即 Git for Windows）：

```bash
# 0) 还原 pi vendor（本仓库只跟踪补丁与模型数据快照，源码按固定基线拉取）
git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi
cd pi && git checkout d981de1229ef899957bbe968bc8dcda02a21f477 && git reset --hard
git apply ../pi-patches/*.patch && bun install
mkdir -p packages/ai/src/providers/data && cp ../pi-model-data/*.json ../pi-model-data/.manifest.json packages/ai/src/providers/data/
cd ..

# 1) 后端（http://localhost:17455）
cd pc-server && bun install && bun run server.ts

# 2) 另开一个终端：前端 dev server（http://localhost:5173，/api 自动代理）
cd web-ui && bun install && bun run dev
```

构建安装包、便携版、原生壳、Linux 二进制与 Docker 镜像的完整步骤，以及「发布前必须改的
两处」，都在 **[docs/BUILD.md](docs/BUILD.md)**。要把这个目录推上 GitHub（包括提交身份
怎么设才不暴露个人邮箱），看 **[docs/PUBLISH.md](docs/PUBLISH.md)**。

```bash
# Docker（端口固定在 8080，数据挂出来）
docker build -t rikkahub-pc .
docker run -d -p 8080:8080 -v ./pc-data:/app/pc-data rikkahub-pc
```

只要服务可能被本机之外访问，请务必设置 `RIKKAHUB_PASSWORD`。

## 目录结构

```
pc-server/        Bun 后端：会话/推理引擎/MCP/备份/SSH/工作区（SQLite 落盘）
web-ui/           React 19 + React Router 7 前端 SPA（Tailwind v4 + shadcn/ui）
web-ui/src-tauri/ 上游 Tauri v2 壳（Windows 安装包 / Linux 打包用）
desktop-shell/    本分支的 Windows 原生壳（WinForms + 系统 WebView2）
pi-patches/       给上游 pi 推理库的受控补丁（本仓库跟踪）
pi-model-data/    模型目录快照，与 pi 基线严格配对（本仓库跟踪）
fonts/ icons/     内置字体与供应商/品牌图标
functions/        上游 Cloudflare Pages 遥测端点（桌面端不联网上报，源码保留）
docs/             构建（BUILD.md）、发布（PUBLISH.md）与排查文档、logo
.github/          CI（typecheck + 单元测试 + 冒烟）、Linux 产物、Docker 发布
```

## 隐私

无遥测、无账号、无管理员权限要求。数据默认全在 `<安装目录或便携根>\pc-data\`，
`pc-data/` 与 `state.json` 都在 `.gitignore` 里 —— 本仓库不含任何用户数据、密钥或本机路径，
提交历史也是从一个干净的初始提交开始的。日志里的 Authorization 头会先脱敏再落盘。

## 许可

上游采用**分段双许可**（详见 [LICENSE](LICENSE)）：非商业 / 个人 / 教育 / 研究用途，
或总用户数不超过 50 人的组织，可在 **GNU AGPL v3** 下免费使用（含开源义务）；
商业用途或超过 50 人需按 `LICENSE` 里留下的联系方式取得商业授权。

**本分支不改变上述条款**，以同样的双许可结构开源；衍生分发需遵守 AGPL v3
（包括公开修改后的源码）。`LICENSE` 中的商业授权联系方式属于上游维护者，
本分支作者不提供任何形式的商业授权或承诺。

## 致谢

- [@re-ovo](https://github.com/re-ovo) 与 [RikkaHub](https://github.com/rikkahub/rikkahub) —— 产品与品牌本身。
- [yuh-G/rikkahub-desktop](https://github.com/yuh-G/rikkahub-desktop) —— 本分支的上游桌面版。
- [@Noah0932](https://github.com/Noah0932)（Debian/Ubuntu、Arch 原生包）、
  [@AstralFlare-owo](https://github.com/AstralFlare-owo)（Nix / NUR）—— Linux 侧打包。
- [earendil-works/pi](https://github.com/earendil-works/pi) —— 对话与工具编排引擎。
- [Chevey339/kelivo](https://github.com/Chevey339/kelivo) —— 互传对端格式。

## License / 说明（English summary）

Community fork of **RikkaHub Desktop** (which is itself a desktop port of
[@re-ovo's RikkaHub](https://github.com/rikkahub/rikkahub)). This branch adds:
MiMo speech-to-text (dictation only — MiMo has no realtime/VAD endpoint), local
**stdio** MCP servers with JSON import and the SSE transport removed, a
SQLite-backed structured local data layer (conversations, message nodes, FTS5,
assistant memory, pending memory, workspaces) with a storage-overview panel, a
native Windows shell built on **WinForms + the system Edge WebView2 runtime
(not Electron, no bundled Chromium)** that cut cold start from ~6.3 s to ~1.9 s,
SSH remote-device support (CRUD / test / one-shot exec — no interactive shell,
tunnelling or SFTP yet), optional two-way [Kelivo](https://github.com/Chevey339/kelivo)
sync (8 import categories, schema-v3 export), and a 12-item `backupScope` that
governs local / WebDAV / S3 / Kelivo backups consistently.

Maintained in spare time — updates are **slow but long-term**, with no roadmap or
SLA; every change is type-checked, unit-tested and run on a real machine before it lands.
Source is released under the same **segmented dual licensing** as upstream
(AGPLv3 for non-commercial / personal / educational / research use or ≤ 50 users;
see [LICENSE](LICENSE) — the commercial-contact details there belong to the
upstream maintainer). This branch publishes source only, no binaries.
**No macOS development:** I own no Mac, so I cannot build, sign or verify a Mac
target; the Tauri mac definitions are kept from upstream but are explicitly unsupported.
Linux remains supported via upstream packaging and multi-arch Docker.
