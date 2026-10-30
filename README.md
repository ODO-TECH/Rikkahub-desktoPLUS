<div align="center">
  <img src="docs/icon.png" alt="RikkaHub Desktop PLUS" width="96" />

  <h1>RikkaHub Desktop PLUS</h1>

  <p>Windows、Linux 与 Docker 自托管的 LLM 桌面客户端 · 多供应商 · 本地数据优先</p>

  <p>
    <a href="LICENSE"><img alt="Version" src="https://img.shields.io/badge/version-0.1.3-2f81f7"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0%20%7C%20Commercial-2f81f7"></a>
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20Docker-3fb950">
    <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun%201.4.2-f472b6">
    <img alt="Shell" src="https://img.shields.io/badge/shell-WinForms%20%2B%20WebView2-0078d4">
    <img alt="Storage" src="https://img.shields.io/badge/storage-SQLite%20%2B%20FTS5%20%2B%20vector-ffa657">
  </p>
</div>

---

**RikkaHub Desktop PLUS** 是 [RikkaHub Desktop](https://github.com/yuh-G/rikkahub-desktop) 的社区增强分支，由 [@ODO-TECH](https://github.com/ODO-TECH) 维护。上游已经提供了完整的客户端基础，包括多供应商接入、助手与提示词体系、MCP、联网搜索以及安卓端的数据格式。本分支在这个基础上主要做了四件事：

- **Windows 桌面形态。** 新增 WinForms + 系统 Edge WebView2 的原生壳，不额外打包浏览器内核，冷启动从 6.3 秒降到 1.9 秒。
- **本地数据。** 会话、消息、工作区与记忆迁入 SQLite（含 FTS5 全文索引），备份粒度细化到 12 个可选项，统一作用于本地、WebDAV、S3 与 Kelivo。
- **工作区与工具链。** 会话可以绑定真实文件夹或 SSH 远程目录，模型获得读写文件、shell、grep 等工具；新增 Skills、stdio MCP、并行子智能体和内置终端。
- **部署。** 容器运行时使用 Debian slim，自带 bash、zip/unzip 与字体注册；加入面向飞牛 OS 等 Linux NAS 的编排，并提供 Windows 本地与容器两种系统级写入边界。

版本目前是 0.1.3。从 0.0.2 算起，累计变更 393 个文件、新增约 5.6 万行。下面的功能清单按模块整理，构建与部署细节在后面的章节和 `docs/` 里。

Windows 便携版在本仓库的 [Releases](https://github.com/ODO-TECH/Rikkahub-desktoPLUS/releases) 提供，应用内的更新检查也指向本仓库。项目名里的 PLUS 只代表本分支的增量，不属于上游品牌；数据目录、环境变量前缀与技术标识符与上游保持一致，可以和上游版本共用同一份 `pc-data/`。

## 目录

- [功能概览](#功能概览)
- [安全与权限模型](#安全与权限模型)
- [冷启动优化](#冷启动优化)
- [平台支持](#平台支持)
- [快速开始](#快速开始)
- [构建](#构建)
- [容器部署（Docker / 飞牛 OS）](#容器部署docker--飞牛-os)
- [数据目录与备份](#数据目录与备份)
- [配置参考](#配置参考)
- [版本记录](#版本记录)
- [开发与测试](#开发与测试)
- [与上游的关系](#与上游的关系)
- [许可](#许可)
- [隐私与网络行为](#隐私与网络行为)
- [使用说明](#使用说明)
- [维护与贡献](#维护与贡献)
- [致谢](#致谢)
- [English summary](#english-summary)

## 功能概览

### 对话与消息

会话以消息树组织，因此分支、编辑、重新生成都是常规操作：任意一条消息编辑后会另起分支，可以在分支间前后切换，也可以手动把整段对话 fork 出去。消息卡片上还有重新生成（可选择从某条用户消息起重做）、删除、钉住、导出 Markdown、生成长图（带水印）。每条助手消息记录输入（含缓存命中部分）、输出、tok/s 和耗时，顶栏显示整体缓存命中率。

长对话需要的细节也都做了：消息排队（可以暂停、编辑、撤回）、思考与工具步骤整体折叠、增量语法高亮、代码块行号与换行开关、表格与 Mermaid 渲染。译文挂在消息下方，不会写回上下文。等待审批时会发系统通知。输入区支持图片、视频、音频和文档，文档带逐页解析进度；超过阈值的长文本自动转成 txt 附件。斜杠指令由服务端下发，`/compact` 可以直接触发压缩；提示词优化支持撤销。

会话侧栏负责日常调度：按日期分组、置顶、批量多选删除、跨会话全文搜索并跳到具体某条消息、切换助手与标签，语言、深浅色和主题色也能就地切换。

### 智能体工作区

工作区是这一版里投入最多的模块。顶部是两级页签：一级是容器，可以是聊天模式，也可以是某个具体工作区；每个容器再切成最多三栏，可以左右分屏。工作区有四种来源：托管目录、打开现有文件夹（首次进入需要信任授权）、纯对话，以及 SSH 远程目录。

右侧工作台按「本次改动 / 工作区 / 附件 / 产出」四个页签组织会话涉及的文件。代码用 Shiki 高亮，PDF 内联渲染（上限 50 MB），HTML/SVG 走空 sandbox 的 srcDoc，音视频直接播放。文件可以在应用内编辑并按 Ctrl+S 落盘；磁盘上的版本被改动过时会提示 409，由你选择重载或覆盖。此外支持上传下载，AGENTS.md 也可以就地编辑。`Ctrl/Cmd+Shift+E` 可以从任意附件或工具调用把对应文件唤到侧栏。

模型拿到的工作区工具是 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 七个，与安卓端的能力面一致。除此之外还有网页搜索与抓取、剪贴板、时间、TTS、加载技能、保存记忆，以及 `ask_user` 交互式提问卡（多选加自由文本）。`subagent_dispatch` 把并行子任务当作一个普通工具接入，走同一套审批，卡片上实时显示子任务的 token 消耗和预算；该功能默认关闭，深度固定为 1，并发 1 到 8 可调。

### SSH 远程工作区

在「设置 › 拓展 › SSH」里管理设备（密码或带 passphrase 的私钥）和每台设备上被授权访问的目录。首次连接要求确认主机密钥，密钥变化时直接拒连。创建工作区时选择某台设备的某个授权目录，工作区记录里只保存设备 id 和目录 id，不复制凭据。

界面上可以浏览、预览、编辑、上传、下载远程文件（SFTP），也能开一条内置终端。给模型的能力收窄为 `read` 与 `bash` 两项，改文件通过 shell 完成，与移动端的语义一致。连接按设备进池复用，空闲 5 分钟后回收；单次列目录 500 条，读文件 512 KiB，写 2 MiB，下载 64 MiB，命令超时上限 600 秒。

### 记忆

记忆分全局和助手两级，另有待确认队列（上限 100 条，可以批量存为全局、存为助手或丢弃）。写入策略下沉到单个助手，共五档：总是全局、总是助手、工具默认全局、工具默认助手、只读。只读档会把 `save_memory` 从工具表里摘掉。另设「记忆模型」场景档，让记忆抽取使用单独指定的模型。

默认召回基于词法匹配（CJK 按 2-gram 切分）。开启向量后改为混合召回，词法占 0.45、余弦占 0.55，并做邻居扩展（5 个种子、余弦不低于 0.78），最近 3 条和未索引的 3 条始终入选，可选再走一轮重排。嵌入和重排是 PC 独有的模型类型（`EMBEDDING` / `RERANK`），必须显式配置场景档，不会回落到聊天模型。

有两个设计值得说明。召回结果按会话冻结，首次编码后逐字复用，避免同一会话里前缀缓存反复失效；任一环节失败都退回全量注入，向量库异常不会让记忆功能失效。写入去重沿用 Kelivo 的 Smart Add（NEW / MERGE / SKIP），自动整理按每 N 轮触发（默认 5 轮，开关默认关，也可以手动执行）。设置页能看到索引维度、条数、陈旧度，可以重建、取消、预览；预览会同时给出词法分和余弦分。

再往上一层是实验档的记忆失真与遗忘：分类、合并、晋升、维护（保真 / 粗化 / 主题阶梯）和清除都以提案形式出现，带墓碑审计记录，原文有宽限期，期内可以撤销。这组功能默认全关、默认只试运行；从试运行切到真实改写需要显式确认，并且要先跑一遍扫描。关掉主开关后，行为与上线前逐字节一致。

### 上下文压缩

压缩采用非破坏式切点：只追加一条记录（切点、摘要、压缩前 token）和一个锚点标注，原文一条不删，时间线和全文索引照常可以翻到最早的消息。流程分四段：只重压上次切点之后的消息；递归二分分块，单块不超过 256 条；新摘要与旧摘要合并去重，超出预算时再做一轮收束；被钉住的消息不进摘要，以 `<pinned_messages>` 原样回到上下文。

自动压缩在估算 token 超过「窗口减 16384」时触发，默认关闭（它会消耗一次模型调用）。手动压缩走同一个接口，界面上是一根保留比例滑杆，范围 20 到 100，默认 40，超过 65 时会提示幻觉风险并要求确认。摘要卡写明压缩前后 token 和候选记忆条数，可以展开原文或查看详情；中途中止不会写入任何内容。

### 模型与供应商

内置 21 个供应商预设（OpenAI、ChatGPT、Anthropic、Claude、Gemini、xAI、Grok、DeepSeek、智谱、月之暗面、Kimi Code、阿里云百炼、火山引擎、腾讯混元、MiniMax、MIMO、阶跃星辰、OpenRouter、Vercel、Copilot、钠API），也支持任意 OpenAI / Anthropic / Google 兼容端点。三种协议族可以互相切换，各厂商的端点路径有实测表；单个模型还能通过 `providerOverwrite` 单独指定网关、base 和 key。

场景模型共 9 个位置：聊天、快速、翻译、OCR、压缩、提示词优化、嵌入、重排、记忆。压缩提示词对「对话引擎」和「工作区引擎」分别可编辑。订阅制账号走 OAuth，提供浏览器回调和设备码两种方式，凭据不会下发到浏览器。测试面板覆盖 non-stream、stream、tools、embeddings、rerank 和图像输出，配额与余额可以直接查询。推理强度支持到 `xhigh` 和 `max`（给 pi 引擎打了补丁），历史思考可以回灌，提示词缓存带 TTL 和 `prompt_cache_key`。

### 语音与媒体生成

TTS 有 11 类（含系统语音），带音色、情绪、语速、稳定性预设，以及朗读过滤规则（只读引号台词、跳过括号）。ASR 走 WebSocket 实时通道，免提模式分聆听、转写、播报三种状态。MiMo 没有 realtime 和 VAD 端点，所以只提供分段听写，选中它时通话入口会隐藏，避免出现入口可见但用不了的情况。

媒体生成是独立的工作台（`/images`），分图片和视频两类任务，支持 OpenAI、阿里云、火山、MiniMax、OpenRouter 五类供应商。最多 16 张参考图，数量、分辨率、比例、时长、是否生成音频、seed、提示词增强逐项可控，提示词可以交给聊天模型或指定模型改写。任务有排队、进行、失败三种状态，可以取消；产物支持批量下载，也能一键插回当前对话。需要外链素材的供应商会自动走 S3 上传存储。

### 联网检索

默认提供 18 个搜索引擎和服务：Bing、RikkaHub 中继（可自建实例）、智谱、豆包、Tavily、Exa、SearXNG、LinkUp、Brave、秘塔、Ollama、Perplexity、Firecrawl、Jina、博查、Grok、Tinyfish、Serper。另有 Custom JS，可以写脚本接入自己的服务。深度档位、结果数、API Key 健康检查（配额、密钥、网络分别报错）和多 Key 故障转移都已具备。模型侧可以选择用模型自带的搜索，也可以用应用内配置的引擎。

### 工具与扩展

MCP 支持两种传输：Streamable HTTP 和本地 stdio（子进程，支持 `command`、`args`、`env`、`cwd`），并实现了 OAuth 2.1（RFC 9728 + 8414/OIDC 发现 + 7591 动态注册 + PKCE S256 + 8707 资源指示 + 刷新 + 回环回调）。可以从 Claude Desktop、Cursor、VS Code、Cline 风格的 `mcpServers` JSON 一键导入，导入项默认停用。健康监督会在启动时探测所有服务器并广播状态；工具可以按服务器逐个启用，也可以按助手单独设置是否需要审批。失败原因分为授权过期、配置错误、服务不可用、网络四类。

技能（SKILL.md）支持应用内编辑、GitHub 导入和批量文件导入，可以全局生效或绑定到单个助手。世界书与模式注入按关键词或正则触发，大小写、扫描深度、注入位置、角色、注入层数、常驻都可调。快捷消息模板、代理模式（自动 / 手动 / 直连 / 环境变量，带 PAC 与系统代理探测和绕过规则）也都齐备。

### 外部接入

QQ 机器人与微信（iLink）扫码绑定后，可以把某个聊天绑定到某个助手和工作区，在手机上直接使用桌面或 NAS 上的助手。配对使用 6 位一次性码（字符集去掉了 0/O/1/I/L），1 小时有效、单次使用，重新生成会作废旧码；同一用户连续猜错 5 次锁定 5 分钟。没有配对的用户只会收到「请发送配对码」，不会触发模型。总开关关闭时会同时作废所有存量配对码。

入站只接受文本和语音转写结果（QQ 用服务端的 `asr_refer_text`，微信用 iLink 的预转写文本）。出站可以按平台选择去掉 Markdown 标记，代码块保留，链接退化为「文本 (URL)」。会话内支持 `/help`、`/status`、`/new`、`/stop` 四个指令，超长回复自动分段。

### 界面与个性化

内置 9 套主题，支持深浅色跟随系统和自定义 CSS 变量主题（可以导入 tweakcn 预设）。界面字体和聊天气泡字体分开设置，中西文可以分别指定，并通过 `@font-face` 注入 unicode-range，也支持上传字体。设置页每一项都能搜索，命中后展开所在分区并滚动高亮，`?section=&sub=` 深链可以直接定位到某一行。9 个快捷键动作带实时冲突检测。

统计页给出消息数、输入输出 token、缓存命中率、启动次数、活跃度热力图，以及按模型和供应商分组的成功/失败情况。日志页可以按状态码、时长、供应商、类型过滤，请求体里的敏感值默认打码，需要时可以手动展开。

## 安全与权限模型

模型能写到哪里，由三层机制共同决定。

**审批档位**有三档：逐条确认（写入和 shell 都会询问）、默认（工作区内写入放行，危险命令和区外写入仍然询问）、完全访问（不再逐条询问）。只读工具（`read`、`grep`、`find`、`ls`）在任何档位都不会弹窗。审批是两阶段的：卡片创建时先给出不带参数的下限判断，参数到位后再定最终结论，且状态单调，已进入待审批就不会回退成自动放行。危险命令清单覆盖 `rm -rf` 根路径与家目录、`del /s`、`rd /s`、`mkfs`、`format`、`diskpart`、写块设备、`chmod` 系统根、`reg delete HKLM` 和 fork 炸弹。

**路径边界**用 `resolve` 加 `realpath` 做前缀比较，带分隔符，Windows 下大小写不敏感；写入目标不存在时，回溯到最深的已存在父目录再判断；符号链接逃逸直接拒绝。读上限 512 KB，写上限 2 MB。

**系统边界**是真正的强制层，分两种部署：

- Windows 上打开「设置 › 网络 › Web 服务 › 受限沙盒」并重启后，后端会把工作区和 `pc-data` 标为低完整性可写区，再用低完整性令牌（`S-1-16-4096`）通过 `CreateProcessAsUserW` 自重启。此后区外写入被内核拒绝（no-write-up），与审批无关。整个过程不需要提权，也没有 UAC 弹窗；关闭开关并重启即可还原标签。失败时会退回不受限状态并记录日志。子进程的 `TEMP`、`TMP`、`HOME`、`USERPROFILE` 都固定在数据目录内。
- 容器里边界就是挂载表。`:rw` 可写，`:ro` 只读，没挂载就看不见。镜像默认以 uid 1000 非 root 运行，根文件系统只读，capability 全部移除，并启用 `no-new-privileges`，运行期唯一的写入点是你挂进去的 `pc-data`。

边界是否真的生效，由启动探针实测后如实上报，不做配置位的推测。Windows 探针往 `%LOCALAPPDATA%\Temp` 写文件（刻意不用被重定向的 `os.tmpdir()`）；Linux 读 `/proc/self/mounts` 的根挂载标志，普通的目录权限报错不算沙盒生效。结果通过 `GET /api/app/sandbox` 和工作区权限下拉显示为「已生效 / 未生效 / 无法判定」。边界确实生效时，审批卡会改为提示「由系统沙盒边界阻止」，不再提供一个注定失败的「允许」按钮。

Web 暴露面的处理：默认只监听 `127.0.0.1` 和 `::1`（双栈成组绑定）。要局域网或反向代理访问，需要显式指定 `--host 0.0.0.0` 或 `RIKKAHUB_HOST`，并同时设置访问密码；只对外暴露而没有密码时，启动会单独告警。访问令牌是 HMAC-SHA256 无状态签名，有效期 30 天，改密码会让全部旧令牌失效。暴力破解走全局限流（60 秒内 5 次失败）加恒定 250 ms 延时，比较全部使用 timing-safe 实现。跨源请求不使用 `Access-Control-Allow-Origin`，而是 Origin 白名单：没有 Origin 放行，`null` 拒绝，非本站 Host 返回 403。HTML 带 CSP。`POST /api/app/shutdown` 与 `export/to-path` 只接受回环请求，并拒绝任何带代理转发头的调用。设置读取接口会统一剥离 web 密码哈希和供应商 OAuth 刷新令牌。

## 冷启动优化

便携版冷启动实测从约 6.3 秒降到约 1.9 秒（Windows x64，单机）。两个瓶颈都在平台层：

| 阶段 | 优化前 | 优化后 | 手段 |
| --- | --- | --- | --- |
| 定位后端 | 1.91 s | 0.18 s | 壳侧用 150 ms 预算的 `BeginConnect` 探活，跳过不可用端口 |
| 后端 bootstrap | 3.27 s | 0.03 s | 用 Blob Worker 预热 Bun 在 Windows 上首次 `spawn` 的阻塞 |

原因是 Bun 在 Windows 上首次调用 `Bun.spawn` / `spawnSync` 会同步阻塞约 3.1 秒，而连接不可用的回环端口需要 0.6 到 2 秒才失败。同一条链路上也量出了不需要再优化的部分：前端 JS 体积、`loadState()`（17 ms）、WebView2 初始化（约 0.6 秒）都不是瓶颈。细节和「不要优化这些」的清单写在 [docs/BUILD.md](docs/BUILD.md)。

桌面壳还负责这些事：隐藏拉起后端、启动屏、托盘常驻或直接退出、用 Job Object 防止孤儿子进程、`rikkahub://restart` 协议自重启，以及向页面注入 `window.__RIKKAHUB_SHELL__`。壳用系统自带的 `csc.exe` 单文件编译，不需要 Visual Studio。上游的 Tauri 壳保留着（Linux 打包和 NSIS 安装包依赖它），两种壳可以共存。

## 平台支持

| 平台 / 形态 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10 / 11 x64 便携版 | 主要目标，Release 提供成品 | `RikkaHub.exe` 加内嵌单文件后端，解压即用，`pc-data/` 就在旁边 |
| Docker（amd64 / arm64） | 支持 | `debian:bookworm-slim` 运行时，自带 bash、zip/unzip 和 fontconfig，非 root 加只读根，compose 面向飞牛 OS 等 Linux NAS |
| Linux x64 | 构建链完整 | CI 产出 `Rikkahub_<ver>_linux_x64.tar.gz`，多架构镜像由 CI 构建并签名 |
| Windows Tauri NSIS 安装包 | 保留 | 需要 MSVC 和 Rust 工具链 |
| macOS | 不发布 | 没有设备可以构建与签名，上游的 mac 配置原样保留 |
| Android | 使用上游 RikkaHub | 本项目专注桌面与 NAS，数据与安卓端双向兼容 |

## 快速开始

### 前置要求

- [Bun](https://bun.sh/) **1.4.2**（与 CI、Dockerfile 保持同一版本）
- Git；Windows 上建议安装 Git for Windows（内嵌 bash 运行时从它的安装目录抽取）
- Windows 桌面壳需要系统 Edge WebView2 运行时（Windows 10 / 11 随 Edge 提供）。检测不到时会提示并打开微软官方下载页。

### 还原 pi 引擎（源码运行首次必须）

对话与工具编排引擎来自 [earendil-works/pi](https://github.com/earendil-works/pi)，源码不随本仓库分发，只跟踪补丁和模型数据快照：

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

`pi/` 和 `node_modules/` 是源码运行依赖，便携版 exe 不需要。

### 源码运行

```bash
# 终端 A：后端 → http://localhost:17455
cd pc-server && bun install && bun run server.ts

# 终端 B：前端 → http://localhost:5173（/api 代理到 17455）
cd web-ui && bun install && bun run dev
```

只调界面的话，可以直接用浏览器打开 `http://localhost:5173`，自定义标题栏会自动隐藏。

## 构建

```bash
cd pc-server     && bun run compile              # → dist/rikkahub-pc.exe（单文件，约 117 MB）
cd pc-server     && bun run compile:linux        # → dist/rikkahub-pc
cd web-ui        && bun run build                # → web-ui/build/client
cd desktop-shell && fetch-sdk.cmd && build.cmd   # → desktop-shell/dist/RikkaHub.exe
```

前端改动必须先 `bun run build`，17455 上的界面才会更新。版本号只有一个入口：`cd pc-server && bun run version:bump X.Y.Z`，它会同步 `updates/index.ts`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 和关于页，CI 里的版本一致性检查会拦住手改。

Tauri NSIS 流程、内嵌 bash bundle 的生成、便携版目录布局和打包注意事项（例如 `.cmd` 必须是 CRLF + ASCII）见 [docs/BUILD.md](docs/BUILD.md)。

## 容器部署（Docker / 飞牛 OS）

镜像和 compose 文件在仓库根目录，面向 Linux NAS：浏览器访问界面，后端和数据都在容器里。完整的构建参数、反向代理与排障细节见 [docs/DOCKER.md](docs/DOCKER.md)。

```bash
cp .env.example .env        # 填入 RIKKAHUB_PASSWORD
docker compose up -d --build
docker compose logs -f
```

访问密码是 compose 的必填项。没有设置时 `docker compose up` 会直接报错退出，不会起一个不鉴权的服务。容器内监听端口固定为 **11451**（`114514` 超出 TCP 合法范围，会被内核和 `docker -p` 拒绝）；宿主机端口用 `RIKKAHUB_HTTP_PORT` 覆盖，容器内不做端口顺延。首次构建要在容器里克隆 pi 引擎并编译前后端，需要数分钟到十几分钟，之后复用缓存，几秒即可启动。镜像以 uid/gid 1000 非 root 运行，用 `docker run` 之前先执行 `sudo chown -R 1000:1000 pc-data`。

不用 compose 时，加固项要自己补齐：

```bash
docker run -d --name rikkahub-plus --restart unless-stopped \
  --read-only --tmpfs /tmp:rw,nosuid,size=256m \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 11451:11451 \
  -e RIKKAHUB_PASSWORD='换成你的密码' \
  -v "$PWD/pc-data:/app/pc-data" \
  rikkahub-desktop-plus:0.1.3
```

只有 `/app/pc-data` 必须挂载。不要把宿主目录挂到 `/app` 或 `/app/web-ui`，那会覆盖镜像里的程序文件。要交给 agent 使用的 NAS 目录，通过挂载表划边界：

```yaml
volumes:
  - ./pc-data:/app/pc-data
  - /vol1/1000/agent/workspace:/workspace:rw   # 唯一推荐可写的工作区
  - /vol1/1000/documents:/data/documents:ro     # 其余一律只读
```

之后在应用里新建文件夹型工作区，路径填容器内的 `/workspace`，不是宿主路径。每多一个 `:rw` 挂载，可写范围就扩大一块。反向代理需要透传原始 `Host`，否则 POST 和 DELETE 会被跨源检查挡成 403。

## 数据目录与备份

所有运行时数据都在 `pc-data/`（可用 `RIKKAHUB_PC_DATA_DIR` 指向别处），这个目录已被 `.gitignore` 排除：

| 路径 | 内容 |
| --- | --- |
| `state.json` | 全部设置：供应商与 API Key、WebDAV / S3 凭据、SSH 设备、外部接入、备份开关 |
| `rikka_hub.db`（含 `-wal` / `-shm`） | 会话、消息节点、FTS5 全文索引、工作区、记忆、记忆向量 |
| `files/` `skills/` `fonts/` | 附件、技能、自定义字体 |
| `workspaces/` `memory/` `AGENTS.md` | 托管工作区、记忆快照、全局工作区指引 |
| `logs/` `tmp/` `updates/` `pi-agent/` `home/` `runtime-bin/` | 取证日志、暂存、更新缓存、引擎工作目录、容器内 `HOME`、内嵌 bash 解包目录 |

活库是 SQLite（WAL 模式）。列表分页和排序下推到 SQL，流式生成只 upsert 当前节点。会话和记忆从旧 JSON 格式一次性迁移过来，迁移保留了回退路径。设置页的存储概览按数据类型给出条目数和占用体积。

备份导出为一个 zip，包含 `settings.json`（安卓兼容）、`pc-backup.json`（PC 到 PC 的元数据，跨机恢复时原样带回设置）、`pc_conversations.db`、`rikka_hub.db`（安卓 v24 schema）、`upload/`、`skills/` 和 `fonts/`。内容和安卓端互通：手机备份可以在桌面还原，且导入不会重置 30 项 PC 专属配置（场景模型、备份范围、SSH 设备、外部接入等）。Windows 侧打包用 PowerShell 的 `CreateFromDirectory`，再归一中央目录的分隔符，因为 `bsdtar` 会弄坏非 ASCII 文件名。

导出内容由 `backupScope` 的 12 项决定：对话、助手、记忆、模型、世界书、提示词注入、常用语、搜索服务、附件、技能、字体、全局指引。这组开关统一作用于本地、WebDAV、S3 和 Kelivo。另有 `backupAllData` 完整备份模式（默认开启，开启时忽略这 12 项，只想按细项挑选时需要先关掉它）。远端备份支持流式进度和包内内容预览。

Kelivo 方向是双向的：导入支持 8 类数据，导出遵循 schema v3 的双 zip 结构（默认关闭；开启后只允许细项模式）。附件不参与 Kelivo 导出。

安卓兼容导出会剥离移动端不认识的内容，包括 `AUDIO` / `VIDEO` / `DOCUMENT` 模态、`RERANK` 模型、stdio MCP、SSH 设备表与 OAuth 凭据，以及 PC 专属的界面字段。判定依据是仓库内固化的安卓契约，不是「能塞就塞」。

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
| `PORT` / `RIKKAHUB_HTTP_PORT` | 监听端口 / 仅 compose：宿主映射端口 |
| `RIKKAHUB_HOST` | 监听地址 |
| `RIKKAHUB_PC_DATA_DIR` | 数据目录，默认为应用目录（源码运行为仓库根，便携版为 exe 所在目录）下的 `pc-data` |
| `RIKKAHUB_PASSWORD` | Web 访问密码；容器内 compose 必填 |
| `RIKKAHUB_BIND_ADDR` | 仅 compose：宿主监听地址 |
| `RIKKAHUB_UID` / `RIKKAHUB_GID` | 容器运行身份，默认 `1000`；修改后需同步 `chown` |
| `RIKKAHUB_SANDBOX` | 沙盒档位声明，取 `off`、`restricted` 或 `full`；compose 设为 `restricted` |
| `RIKKAHUB_SANDBOX_PROBE_PATH` | 可选：对指定的区外代表位置做写探针 |
| `RIKKAHUB_CONTAINER` | 置 `1` 强制按容器形态运行（监听 0.0.0.0、锁定端口、禁用原地更新） |
| `RIKKAHUB_ANALYTICS` | `1` / `0` 强制开关匿名统计；镜像默认 `0` |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 出站代理；容器内固定为 `env` 模式 |
| `TZ` | 时区，compose 默认 `Asia/Shanghai` |

桌面默认端口是 `17455`，被占用时按顺序尝试 20 个端口，都不可用则退回系统分配；容器固定 `11451` 且不重试。

## 版本记录

0.0.2 之后合入了 393 个文件、5.6 万行新增。按版本看：

| 版本 | 主要内容 |
| --- | --- |
| **0.0.3** | 会话文件侧边栏（四个来源页签、按类型预览、应用内编辑、409 冲突处理）；`EMBEDDING` / `RERANK` 模型类型与对应场景档 |
| **0.0.4** | 侧边栏收口：附件与工具调用深链、PDF 内联预览、HTML/SVG 空 sandbox、Mermaid 复用、编辑器行号与草稿保留 |
| **0.0.5** | 媒体生成工作台（图片和视频、5 类供应商、S3 上传存储、任务取消与历史）；思考与工具步骤整体折叠 |
| **0.0.6** | 更新检查与下载兼容系统证书拦截，开启加速或代理时不再误报「无法连接 GitHub」 |
| **0.1.0** | 外部接入（QQ / 微信扫码配对）、SSH 远程工作区与内置终端、记忆向量混合召回与助手级策略、非破坏式上下文压缩与消息钉住、子智能体、Windows 低完整性沙盒、记忆失真与遗忘实验、长文本粘贴设置化 |
| **0.1.1** | 容器加固（非 root、只读根、访问密码必填）、沙盒判定口径统一（容器看挂载表，普通 Linux 的目录权限报错不再算生效）、健康检查只判存活、SSH 授权根与路径边界修正 |
| **0.1.2** | Windows 受限沙盒启用链路修复：后端不是由桌面壳拉起时「立即重启」原本是空操作，现在开关真正生效；关闭沙盒需退出重开的限制在界面上如实提示 |
| **0.1.3** | 内置 `@rikkahub/fetch`（第三种 MCP 传输：进程内，不依赖供应商，HTML 转正文 Markdown，出站拦回环/内网/云元数据）、实验功能「心情」（每轮异步判定 + 按置信度与每日上限注入，默认关闭）、受限沙盒下本地 MCP 可用（npm/uv/pip 缓存改道 + 初始化超时 60 秒）、更新检查以界面版本为准 |

同批修复里值得一提的：微信「已连接但收不到消息」（入站消息被误判为机器人回声）、点击停止后排队项悬挂导致 IM 串行回复链冻结、导入手机备份重置 PC 专属配置、压缩模型未配置时误兜底到 `gpt-4o-mini`、压缩后上下文用量不降反升，以及 SSH 凭据声称不导出安卓而实际从未剥离（已修复并有测试锁定）。

## 开发与测试

```bash
cd pc-server && bun run typecheck && bun test      # 后端类型检查与单测
cd pc-server && bun run smoke:request-chain        # 冒烟：请求链 / 备份往返 / 代理 / 内嵌 bash
cd web-ui    && bun run typecheck && bun run test:unit && bunx oxlint app
```

| 项目 | 数值 |
| --- | --- |
| TypeScript 源文件 | 916 个（后端 543、前端 356），约 18.7 万行 |
| 测试文件 | 275 个（后端 227、前端 48） |
| 最近一次全量跑测（2026-10-28） | 后端 2069 通过 / 8 跳过，前端 509 通过，两侧 typecheck 0 错，4 条冒烟全部通过 |
| 0.0.2 → 0.1.1 变更量 | 393 个文件，+56,167 / −3,891 |

仓库带四条 CI 工作流：`ci.yml` 负责后端 typecheck、单测、冒烟和版本一致性，以及前端 typecheck、单测和构建；`docker-publish.yml` 用 QEMU 构建多架构镜像并推送到 ghcr；`build-linux.yml` 产出 Linux tar.gz 并附加到 Release；`rust-check.yml` 在 Tauri 目录有改动时跑 `cargo check`。测试通过 `bunfig.toml` 预加载夹具，不会写到真实的 `pc-data/`。合入前要求三关全过：typecheck 零错、单测通过、便携版实机冒烟通过。

## 与上游的关系

| 层级 | 项目 | 关系 |
| --- | --- | --- |
| 1 | [RikkaHub](https://github.com/rikkahub/rikkahub)（[@re-ovo](https://github.com/re-ovo)，Android） | 产品设计、品牌与理念的来源 |
| 2 | [RikkaHub Desktop](https://github.com/yuh-G/rikkahub-desktop)（Tauri + Bun） | 本分支的直接上游 |
| 3 | 本仓库（RikkaHub Desktop PLUS） | 基于上游源码的社区增强分支，由 ODO-TECH 维护 |

本分支与上游没有隶属关系，也不代表上游发布任何内容。版本号自成体系，不再与上游对齐：更新检查查的是本仓库 Release，两边的 tag 混用只会让版本比较出错。本分支的 Windows 发布物只在本仓库 Releases 提供，上游 Releases 发布的是上游代码，不含本分支的改动。功能取舍以本分支的维护方向为准。

## 许可

沿用上游的分段双许可（Segmented Dual Licensing），条款不做改动：

- 个人、教育、研究与非商业用途，或用户数不超过 50 的组织：**GNU AGPL v3**，全文见 [LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)。
- 商业用途或超过 50 人：按 [LICENSE](LICENSE) 中的联系方式取得商业授权。

`LICENSE` 是条款声明（未改动上游原文），`LICENSE-AGPL-3.0.txt` 是它引用的协议全文，两者互为补充，不构成额外的许可授予。`LICENSE` 里的商业授权联系方式属于上游维护者，本分支作者不提供商业授权或相关承诺。衍生分发需要遵守 AGPL v3，包括公开修改后的源码。

## 隐私与网络行为

- 没有账号体系，数据默认全部保存在本机 `pc-data/`，API 密钥只存在本地设置里。不上传对话内容、模型名、文件名或查询词。
- 编译版（单文件 exe）默认发送匿名启动统计：设备 UUID、本地日期、版本、操作系统，以及当日计数（消息数、活跃分钟、供应商失败数，搜索、TTS、MCP、图像生成的调用次数）。启动时发一次，之后每 10 分钟一次，发往上游端点，5 秒超时，失败静默。源码运行默认不上报，容器镜像默认关闭（`RIKKAHUB_ANALYTICS=0`），也可以用该变量彻底关闭。
- 编译版启动时会向本仓库的 GitHub Releases 静默检查一次更新（用 HEAD 重定向取 tag，版本相同时不产生 API 调用）。只在新版本且未被跳过时提示，网络错误不打扰。
- 日志在展示前统一脱敏：Authorization 类的值按 scheme 打码，URL 会做清洗。
- 提 Issue 前请先脱敏，日志正文、截图和配置里可能包含 API Key、WebDAV / S3 凭据或 SSH 主机信息。

## 使用说明

- macOS 不发布产物。没有设备可以构建、签名与验证，相关配置仅为上游遗留。
- SSH 不是沙箱。边界止于授权目录（词法归一、不跟随符号链接），远端是一台真实机器；远程目录不支持改名、宿主文件管理器定位和项目级 AGENTS.md，也不提供端口转发。
- Windows 受限沙盒需要重启一次才会生效，关闭时会自动还原目录标签。「完全访问」档不再逐条审批，请只挂载确实需要写入的目录。
- 容器内的能力差异：镜像里没有 Node/npm（stdio MCP 的 `npx` 起不来）、没有系统 TTS 和剪贴板、明文 HTTP 下麦克风等非安全上下文 API 会被浏览器拦截、容器内不自更新（升级走重新构建）。
- SSE 传输已移除。读取历史配置时会统一归一为 Streamable HTTP。

## 维护与贡献

长期维护，节奏由实际使用需求决定，不承诺功能时间点。合并门槛是明确的：`bun run typecheck` 零错、`bun test` 通过、便携版实机冒烟通过；数据格式变更必须附带一次性迁移与回退路径；不接受改变上游许可条款的改动。

Bug 和功能建议请开 Issue，并按仓库内的模板填写环境与复现步骤。欢迎 PR 但不保证合并。提交前请确认没有引入个人数据、本机路径或凭据。发布流程见 [docs/PUBLISH.md](docs/PUBLISH.md)，构建细节见 [docs/BUILD.md](docs/BUILD.md)，排查入口见 [docs/DEBUG_REFERENCE.md](docs/DEBUG_REFERENCE.md)，各项设计与取舍记录在 `docs/plan-*.md`。

## 致谢

- [@re-ovo](https://github.com/re-ovo) 与 [RikkaHub](https://github.com/rikkahub/rikkahub)
- [yuh-G/rikkahub-desktop](https://github.com/yuh-G/rikkahub-desktop)
- [@Noah0932](https://github.com/Noah0932)（Debian / Ubuntu、Arch 打包）、[@AstralFlare-owo](https://github.com/AstralFlare-owo)（Nix / NUR）
- [earendil-works/pi](https://github.com/earendil-works/pi)（对话与工具编排引擎）
- [Chevey339/kelivo](https://github.com/Chevey339/kelivo)（互传对端格式）

## English summary

**RikkaHub Desktop PLUS** is a community-enhanced fork of **RikkaHub Desktop**, maintained by [@ODO-TECH](https://github.com/ODO-TECH). The upstream project provides a complete client: multi-provider chat, assistants and prompt tooling, MCP, web search and the Android data format. This fork adds four things on top of it.

- **A native Windows shell.** WinForms on the system Edge WebView2 runtime, with no bundled browser engine. Cold start went from about 6.3 s to about 1.9 s after locating two platform-level defects.
- **Structured local data.** Conversations, messages, workspaces and memory live in SQLite with FTS5, and the backup scope is broken into 12 selectable items that apply uniformly to local, WebDAV, S3 and Kelivo backups.
- **Workspaces and tooling.** A conversation can be bound to a real folder or an SSH directory. The model gets `read` / `write` / `edit` / `bash` / `grep` / `find` / `ls` behind an approval gate, plus Skills, stdio MCP, parallel subagents and a built-in terminal.
- **Deployment.** A `debian:bookworm-slim` runtime with bash, zip/unzip and fontconfig, a compose file for Linux NAS (non-root, read-only root, mandatory password), and a Windows low-integrity sandbox tier that needs no elevation.

Other pieces worth naming: hybrid memory recall (lexical 0.45 plus cosine 0.55) with neighbour expansion and optional rerank, frozen per conversation to protect prefix caching; non-destructive context compaction that never deletes messages and keeps history searchable; 21 provider presets with 9 scene-model slots and subscription OAuth including a device-code fallback; 11 TTS kinds plus realtime ASR; an image and video generation workbench; 18 built-in search services; and QQ / WeChat pairing so a phone can drive the desktop assistant.

The OS boundary is measured rather than assumed. On Windows, low-integrity tokens make out-of-region writes fail in the kernel without elevation; in containers the mount table is the boundary. A startup probe checks whether it actually holds, and the UI reports enforced, not enforced or unknown.

Platforms: Windows 10/11 x64 is the primary target and ships as a portable zip in Releases. Multi-arch container images and a Linux tarball are built by CI. macOS artifacts are not published because no Mac hardware is available to build or sign them.

Compiled builds send an anonymous startup counter (device UUID, date, version, OS and daily counters; no message content, IP, model names, file names or queries). It is off by default when running from source and inside the container image, and can be disabled with `RIKKAHUB_ANALYTICS=0`. Licensed under the same segmented dual licensing as upstream (AGPLv3 for non-commercial, personal, educational or research use, or organizations with at most 50 users).
