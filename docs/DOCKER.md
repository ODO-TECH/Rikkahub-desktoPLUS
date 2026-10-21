# 容器部署 · RikkaHub Desktop PLUS（飞牛 OS / Linux NAS）

本页是 RikkaHub Desktop PLUS 的容器部署说明：镜像契约、`docker compose` 用法、容器内目录树、Linux 适配点与已知限制。构建细节见 [BUILD.md](BUILD.md)。

## 1. 端口：为什么是 11451 而不是 114514

TCP/UDP 端口号是 16 位无符号整数，合法范围 **1–65535**。`114514` 超出上限，`docker -p` 与内核都会直接拒绝，所以镜像契约取同一串数字的有效前缀 **11451**。

- 容器内固定 `11451`：`ENV PORT=11451` 与 `EXPOSE 11451` 都锚定它。
- 宿主机映射默认 `11451:11451`，可在 compose 里用 `RIKKAHUB_HTTP_PORT` 改**宿主机**端口，容器内端口不变。
- 容器内**不做端口顺延**：端口冲突会直接失败并打印原因。换宿主机端口请改映射，不要在应用内改端口（设置页的端口项在容器里会被拒写，避免"改了会生效"的假象）。

从旧的 8080 镜像升级时，`docker run -p 8080:8080` 会失效，需要改成 `-p 11451:11451` 或 compose 的默认映射。浏览器里的界面 origin 随之变化，localStorage 中的界面偏好（侧栏布局、标签等）会重置一次；会话与设置都在服务端 `pc-data/`，不受影响。

## 2. 构建与启动

在仓库根目录（与 `Dockerfile`、`docker-compose.yml` 同级）：

```bash
docker compose up -d --build
docker compose logs -f
```

只构建镜像、不用 compose：

```bash
docker build -t rikkahub-desktop-plus:2.0.0-preview-v5 .
docker run -d --name rikkahub-plus \
  --restart unless-stopped \
  -p 11451:11451 \
  -e RIKKAHUB_PASSWORD='换成你的密码' \
  -v "$PWD/pc-data:/app/pc-data" \
  rikkahub-desktop-plus:2.0.0-preview-v5
```

首次启动需要克隆 pi 引擎并编译前端与后端，耗时取决于网络与机器，通常数分钟到十几分钟；之后 `docker compose up -d` 会复用构建缓存。启动完成后打开 `http://<NAS 地址>:11451`。

飞牛 OS 的 Docker 应用里也可以用「项目 / Compose」导入本文件，但 `build:` 需要完整的仓库上下文；更稳的做法是 SSH 到 NAS，在仓库目录里执行上面的 `docker compose up -d --build`，之后在飞牛 Docker 面板里管理容器。

把源码放到 NAS 上时，建议单独一个目录（例如 `/vol1/1000/docker/rikkahub-desktop-plus`），只放仓库文件，构建产物与 `pc-data/` 都在这下面。构建阶段要访问 GitHub 克隆 pi 引擎；NAS 出网受限时用 compose 里注释掉的 `build.args` 传 `HTTPS_PROXY`。

## 3. 容器内目录

镜像内固定布局（`/app` 是工作目录）：

```text
/app/
├── rikkahub-pc                 # Bun 单文件后端（Linux x64 / arm64 交叉编译）
├── web-ui/build/client/        # 前端 SPA 静态资源（运行时从磁盘读取）
├── icons/                      # 供应商与品牌图标
├── fonts/                      # 内置字体，并已注册给 fontconfig
└── pc-data/                    # 唯一需要持久化的目录（VOLUME）

/workspace/<名字>/              # 可选：宿主目录挂载点，镜像内不预建
```

只有 `/app/pc-data` 需要挂载。**不要**把宿主目录挂到 `/app` 或 `/app/web-ui`，否则会盖掉镜像内的程序文件。

`/app/pc-data` 首次启动后生成的内容：

| 路径 | 内容 | 是否敏感 |
| --- | --- | --- |
| `state.json` | 全部设置：供应商与 API Key、WebDAV/S3 凭据、SSH 设备与私钥、备份开关、界面偏好 | 是，等同于密码本 |
| `pc-server.lock` | 单实例互斥锁（PID）；容器被强杀后遗留的陈旧锁会在下次启动时自动接管 | 否 |
| `rikka_hub.db` | 会话、消息节点、FTS5 索引、工作区、助手记忆、待确认记忆、元数据（SQLite WAL） | 是，含全部对话 |
| `rikka_hub.db-wal` / `-shm` | SQLite WAL 与共享内存文件，随库存在 | 是 |
| `files/` | 附件（按 ID 存储） | 是 |
| `skills/` | 技能（含用户导入的 ZIP 解包结果） | 视内容 |
| `fonts/` | 用户上传的自定义字体 | 否 |
| `workspaces/` | 托管型工作区：`<id>/files/` 为模型可见边界，`<id>/tmp/` 放超长输出 | 是 |
| `tmp/` | 上传/恢复/导入的临时暂存区，启动卫生会清理陈旧残留 | 否 |
| `memory/` | `global_memory.json`、`assistant_memory.json`、`pending_memory.json`：SQLite 是权威源，这三份是可读快照/灾备，迁移与回退仍会读它们 | 是 |
| `AGENTS.md` | 全局工作区指引 | 视内容 |
| `pi-agent/` | 引擎工作目录；`sessions/` 已退役，启动卫生会清理残留，可安全清空 | 否 |
| `updates/` | 已下载更新包缓存；容器内更新被禁用，通常为空 | 否 |
| `logs/` | 仅在**上次异常退出**时保留取证日志（`server.log`、`server.boot.pending.log`） | 可能含运行细节 |
| `device-id.txt` | 匿名统计用的设备 UUID；镜像默认 `RIKKAHUB_ANALYTICS=0`，不会创建 | 否 |
| `skip-version.txt` | 用户选择跳过的版本号 | 否 |
| `ui-origin.json` | 界面 origin 接力记录；容器内不启用接力，通常不生成 | 否 |
| `models-dev-cache.json` | 模型目录缓存 | 否 |
| `runtime-bin/` | **仅 Windows** 的内嵌 bash 运行时，Linux 容器里不会出现 | 否 |

需要在 NAS 上给 agent 一个真实目录时，把宿主目录挂到 `/workspace/<名字>`，再在应用里添加"文件夹型工作区"指向它。托管型工作区始终落在 `pc-data/workspaces/`，不会写到宿主目录。

## 4. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `11451` | 容器内监听端口；改它要同步改端口映射与健康检查（镜像健康检查自动跟随 `PORT`） |
| `RIKKAHUB_PASSWORD` | 空 | Web 访问密码。留空 = 不鉴权 |
| `RIKKAHUB_ANALYTICS` | `0` | 镜像默认关闭匿名统计；设 `1` 会向**上游**统计端点上报 |
| `RIKKAHUB_CONTAINER` | `1` | 容器检测兜底（Podman 等没有 `/.dockerenv` 的运行时）；保持监听 `0.0.0.0`、固定端口、关闭原地更新与 origin 接力 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 空 | 容器内代理模式固定为 `env`，只认这几个变量，应用内"检测系统代理"不生效 |
| `TZ` | `Asia/Shanghai` | 时区；镜像已装 `tzdata`，compose 已设置 |
| `RIKKAHUB_PC_DATA_DIR` | `/app/pc-data` | 数据目录；一般不必改，改的话挂载点要跟着改 |

`RIKKAHUB_HOST` 不需要设置：容器检测成立时服务默认监听 `0.0.0.0`，端口映射才能通。

## 5. 针对 Linux / Docker 的适配

这一版把原来只在 Windows 上成立的路径逐项落到容器里：

- **运行时换成 `debian:bookworm-slim`**（原为 distroless）。distroless 没有 shell，agent 的 bash 工具会整项停用；现在的解析顺序是 `/bin/bash` → PATH 上的 `bash` → `sh`，容器内第一条就命中。
- **`zip` / `unzip` 装进 PATH**。备份导出在非 Windows 平台必须 spawn `zip`，ZIP 导入走 `unzip` 分支；旧镜像把它们和库塞进 `/tools` 却不设 `PATH` / `LD_LIBRARY_PATH`，实际不可用。
- **`bash`、`coreutils`、`grep`、`sed`、`gawk`、`findutils`、`procps`、`curl`** 保证 shell 工具、文本处理与健康检查可用。
- **fontconfig 注册 `/app/fonts`**：`fc-list` 能枚举内置的 HarmonyOS Sans、Noto Serif SC 等字体，不再回退到容器里根本不存在的 Windows 字体清单。
- **代理只走环境变量**：容器内 `mode=env`，忽略 `gsettings`，也忽略应用内的自动检测。
- **更新检查返回"容器化"**：前端提示用 `docker pull` / 重新构建升级；容器内禁用原地更新与 `rikkahub://restart` 重启协议。
- **默认关闭匿名统计**：镜像是本分支的编译产物，不应把本地部署记到上游看板；需要时显式 `RIKKAHUB_ANALYTICS=1`。
- **健康检查**：每 30 秒请求 `http://127.0.0.1:${PORT}/api/health`，`start-period` 40 秒覆盖启动迁移。

Windows 专有、在容器里不适用的部分：WebView2 桌面壳与托盘、内嵌 MSYS bash、PowerShell 解压分支、注册表代理读取、便携版更新器。它们都有 Linux 分支或被容器检测短路，不会在镜像里被调用。

## 6. 反向代理

需要 HTTPS 或域名访问时，把 NAS 上的反代指到 `http://<NAS 地址>:11451`，并注意：

- **必须透传原始 `Host`**（`proxy_set_header Host $host;`）。服务端校验 `Origin` 与 `Host` 一致，否则 POST / DELETE 会 403。
- 升级 WebSocket（`Upgrade` / `Connection`）与关闭缓冲（流式响应已带 `X-Accel-Buffering: no`）。
- 仍然设置访问密码：反代只加密传输，不提供账号体系。

## 7. 备份、迁移与升级

- **备份**：先 `docker compose stop` 再打包整个 `pc-data/`，或直接使用应用内的"本地备份"。SQLite 是 WAL 模式，运行中直接拷 `rikka_hub.db` 可能拿到不一致的副本。
- **迁移到另一台机器**：把 `pc-data/` 放到同样的挂载点即可；`state.json` 里的本机路径、SSH 私钥、API Key 会一起带过去，注意保管。
- **升级**：`git pull` 后 `docker compose up -d --build`。数据目录不变；镜像 tag 变了也不会动 `pc-data`。
- **回滚**：保留旧镜像 tag，或还原升级前的 `pc-data/` 快照。数据格式变更自带一次性迁移与回退路径。

## 8. 已知限制

- **没有系统 TTS 与剪贴板**：`espeak-ng`、`wl-copy` / `xclip` 未安装，启动日志会列出这两项警告，属预期；浏览器端的朗读与复制不受影响。
- **裸 HTTP 下浏览器 API 受限**：通过 `http://<NAS IP>:11451` 访问时不是安全上下文，`navigator.mediaDevices`（语音输入/录音）、`crypto.randomUUID`、剪贴板 API 会被浏览器禁用。需要语音输入就用反向代理加 HTTPS；其余功能有降级路径。
- **stdio MCP 需要命令在容器内存在**：镜像不含 Node/npm，`npx ...` 之类的 server 会启动失败。优先用 Streamable HTTP MCP；确实要本地 stdio，请基于本镜像自行加装运行时并维护派生镜像。
- **SSH 能力不变**：设备管理、连接测试、单次命令执行；没有交互式 shell / SFTP / 端口转发。私钥文件需要挂进容器，或在设置里粘贴私钥内容。
- **更新走镜像**：容器内不能原地升级，也不会下载更新包。
- **只监听容器网络**：端口由 compose 映射决定；容器内改端口无效。
- **`scrape_web` 的 SSRF 面**：工具会在容器内抓取模型给出的任意 URL；在意的网络环境请隔离容器网络或限制出站。

## 9. 排障

```bash
docker compose ps
docker compose logs --tail=200 rikkahub-plus
curl -fsS http://127.0.0.1:11451/api/health
docker exec -it rikkahub-plus bash          # 运行时自带 bash，可直接进去查
```

- 启动即退出：先看日志里的 `RIKKAHUB_FATAL:` 标记；端口被占时会明确提示，容器内不做顺延。
- 页面能开但 API 403：反代没透传 `Host`，或访问密码/token 失效。
- 备份导出失败：确认 `docker exec rikkahub-plus which zip` 有输出；正常镜像应指向 `/usr/bin/zip`。
- 数据目录权限问题：compose 默认以 root 运行；要归属普通用户，见 compose 末尾的 `user:` 注释与 `chown` 步骤，并同时把 `HOME` 设为可写目录（如 `/tmp`）。
