# pc-server

RikkaHub Desktop PLUS 的 Bun 后端。`server.ts` 只负责进程生命周期、端口绑定与路由装配，业务按目录拆分：会话、推理引擎、工具、MCP、备份、SSH、工作区、文件提取。

## 从源码运行

先在仓库根目录还原 `pi/` 引擎（见 [../docs/BUILD.md](../docs/BUILD.md)），然后：

```bash
bun install
bun run server.ts          # http://localhost:17455
```

- 桌面默认端口 `17455`，可用 `--port=<n>` 或 `PORT` 覆盖。
- 容器内固定 `11451`（镜像 `ENV PORT`），不做端口顺延。
- 持久化数据在 `../pc-data/`（或 `RIKKAHUB_PC_DATA_DIR` 指定的目录）。

## 编译单文件

```bash
bun run compile            # → ../dist/rikkahub-pc.exe（Windows x64）
bun run compile:linux      # → ../dist/rikkahub-pc（Linux x64）
```

产物自带 Bun 运行时，运行时从自身所在目录查找 `icons/` 与 `web-ui/build/client/`，找不到时回退到源码目录。

## 验证

```bash
bun run typecheck
bun test
bun run smoke:request-chain      # mock 供应商 / MCP / WebDAV / S3 全链路
bun run smoke:backup-roundtrip   # 备份导出 → 恢复往返
```

测试数据走 `test-preload.ts` 重定向的临时沙箱，不会读写真实 `pc-data/`。Windows 上恒定的 3 个失败见 `docs/BUILD.md` 第 7 节。

## 目录

| 目录 | 职责 |
| --- | --- |
| `api/` | HTTP 路由与鉴权；`handlers/` 按域拆分 |
| `conversations/` | SQLite 会话库、消息节点、全文索引 |
| `engines/`、`pi-engine/`、`subprocess-engine/` | 对话引擎适配与 pi 子进程桥接 |
| `inference-engine/`、`model-providers/` | 供应商接入、审批流与模型目录 |
| `agents/`、`assistants/` | 全局 agent 指引、助手与人设 |
| `app-config/` | 默认设置、提示词、统计端点 |
| `tools/` | 内置工具、MCP（Streamable HTTP / stdio） |
| `workspace/` | 工作区、路径边界、shell 工具 |
| `files/` | 附件与文档文本提取（子进程 worker） |
| `backup/` | 本地 zip、WebDAV、S3、Kelivo 导入导出 |
| `persistence/` | 设置 JSON、实例锁、启动卫生 |
| `foundation/` | 路径、端口、平台检测等无业务依赖的基础件 |
| `ssh/` | 远程设备与单次命令执行 |
| `media/`、`search/` | 语音输入、搜索服务 |
| `memory/` | 助手记忆与待确认记忆 |
| `commands/` | 斜杠命令注册表 |
| `observability/` | 错误上报、启动里程碑与崩溃取证 |
| `updates/` | 版本号与更新检查（仅上游 Release） |

## 约定

- **模块单向依赖**：`foundation/` 不感知业务；路由层不直接写库。
- **凭据只落 `pc-data/state.json`**，不写日志、不进仓库。
- 注释写「为什么」与不变量（节流合并、供应商怪癖、流式重连），不复述代码。
- 数据格式变更必须带一次性迁移与回退路径。
- 新增外部命令依赖时，Windows 与 Linux 两条分支都要有解析路径；容器里没有的运行时（如 Node）不要假设存在。
