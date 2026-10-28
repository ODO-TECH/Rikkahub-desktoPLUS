# RikkaHub Desktop PLUS Debug 基准与执行规范

> 建立日期：2026-10-27  
> 适用范围：`pc-server/`、`web-ui/`、`desktop-shell/` 的跨功能调试与回归验收。  
> 本文记录的是当时工作树的诊断基线。后续模型开始前必须重新核对代码和测试状态，不得默认问题仍存在或已经修复。

## 1. 核心原则

1. 先建立能捕获准确症状、在当前实现下稳定变红的反馈闭环，再修改实现。
2. 红测试必须走真实调用缝，不能只测一个脱离实际调用链的浅层 helper。
3. 并发问题用 deferred、barrier 或可控 mock 固定时序，不用长 `sleep` 碰运气。
4. 先最小化复现，再提出可证伪假设；每次只改变一个变量。
5. 先写回归测试并确认失败，再修复；原始完整场景必须在最后重跑。
6. 不把已知 Windows 环境性失败当作业务回归，也不为了全绿削弱断言。
7. 不在 bug fix 中混入全仓格式化、无关重构或并行会话留下的语义修改。

## 2. 当前功能关系

```text
桌面 / 语音 / IM
      ↓
消息队列 → generateAnswer
      ↓
记忆召回 → 自动/手动压缩 → Chat 或 pi 引擎
                              ↓
                    工作区工具 / SSH / 子代理
                              ↓
                       权限审批与沙盒

备份导入 → 替换设置、会话、记忆
         → 必须同步作废旧生成、压缩、队列、waiter、审批、广播和缓存
```

高风险耦合点：

- IM 与桌面/语音共用会话、生成和消息队列。
- Chat 与 pi 共用记忆召回，但压缩实现和完成路径不同。
- 工作区运行时可指向本地或 SSH；pi 资源目录仍是本机路径。
- 备份导入替换权威数据，旧异步任务不得再写入新状态。
- 桌面壳主要通过 HTTP `/api/app/shutdown` 关闭后端，不是信号退出路径。

## 3. 2026-10-27 自动化基线

| 检查 | 当时结果 |
|---|---|
| 后端 typecheck | 通过，本项目 0 错误；滤除 pi 内部 46 条诊断 |
| 前端 typecheck | 通过 |
| 前端生产构建 | 通过 |
| WebView2 壳编译 | 通过 |
| `git diff --check` | 通过 |
| 后端完整测试 | 2046 pass、8 skip、3 fail |
| 前端完整测试 | 506 pass、3 fail |
| oxlint | 0 error、4 个未使用 import warning |
| 代理行为冒烟 | PASS |
| 内嵌 Bash 冒烟 | PASS |
| 备份往返冒烟 | zip 结构和业务断言通过，随后命中 EBUSY |
| 请求链冒烟 | 记忆 API 断言失败；已定位为测试仍按旧全局写入策略配置 |

后端 3 个已知失败：

- `workspace/boundary.test.ts`：向 `C:\WINDOWS\Temp` 写入时 EPERM。
- `workspace/runtime.test.ts`：同类管理员权限问题。
- `backup/android-passthrough.e2e.test.ts`：清理临时目录时 EBUSY。

这些属于既有 Windows 环境/flake 基线，不做 bisect，不修改业务断言来隐藏。

前端 3 个失败均位于 `web-ui/app/tests/settings-search-index.test.ts`：

- 中文缺少 `settings:nav_search.keywords.memory_dedup`。
- 未登记 `settings:assistants.memory_enable`。
- 未登记 `settings:assistants.memory_organize_every`。
- 条目缺失同时导致“AI 写入策略”的面包屑打分断言失败。

## 4. 已定位的问题证据

后续处理前先重新读取相关代码并建立红测试。以下行号是 2026-10-27 工作树位置。

### P0-1：IM `/stop` 被普通问答串行阻塞

证据：

- `pc-server/im/runtime.ts:109`：整个 `route` 进入 `enqueueForChat`。
- `pc-server/im/runtime.ts:129`：命令处理也在该串行任务内。
- `pc-server/im/runtime.ts:135`：普通消息等待完整 `askAssistant`。
- `pc-server/im/runtime.ts:184`：`/stop` 只有排到队首才执行。

准确症状：模型生成期间发送 `/stop`，必须等回答结束后才执行停止。

### P0-2：IM 排队 waiter 在停止/失败/导入后可能悬挂

证据：

- `pc-server/im/runtime.ts:361-365`：生成中注册 `waitingReply` 并等待派发结果。
- `pc-server/conversations/message-queue.ts:131-165`：停止冻结、失败暂停队列。
- `pc-server/conversations/orchestrator.ts:1340-1343,1366-1370`：停止和失败分别进入 hold/pause。
- `pc-server/conversations/message-queue.ts:188-200`：已有 `clearMessageQueue` 可结算 waiter。
- `pc-server/backup/import.ts:1862-1881`：导入收尾未调用队列清理。

准确症状：未派发的 IM 消息没有终态交付，聊天串行路由被等待 Promise 占住，后续命令无法处理。

### P0-3：安卓设置导入重置 PC-only 配置

证据：

- `pc-server/backup/import.ts:721-791`：合并从 `...app` 开始，仅显式保留部分 PC 字段。
- `pc-server/persistence/state-load.ts:73-82,119-121,226-229`：缺失字段由默认状态/归一化补齐。
- `pc-server/app-config/defaults.ts:113,181-182`：自动压缩、SSH 和 IM 默认值。

当时遗漏：

- `memoryVectorSettings`
- `subagent`
- `chatAutoCompact`
- `sshDevices`
- `imAccess`

必须同时保持反向契约：导出安卓包仍剥离 SSH/IM 凭据；PC → PC 完整备份保留这些字段。

### P1-1：导入与 pi 手动压缩竞态

证据：

- `pc-server/backup/import.ts:1862-1878`：只中止 `generating` 并清 working set，未作废压缩任务。
- `pc-server/api/handlers/conversations.ts:724-782`：压缩状态与请求生命周期。
- `pc-server/conversations/orchestrator.ts:757-775`：压缩结果直接修改会话并标脏。
- `pc-server/conversations/index.ts:493-516`：working set 中找不到旧会话时跳过脏刷新。

准确症状：导入期间返回的旧压缩结果可能不落库，但调用方仍看到成功。

### P1-2：记忆召回缓存身份和失效代际不足

证据：

- `pc-server/api/handlers/conversations.ts:294-300`：移动助手只修改 `assistantId`。
- `pc-server/memory/recall-cache.ts:19-29`：召回选择只按 `conversationId` 存取。
- `pc-server/memory/recall.ts:231-280`：缓存仅校验嵌入模型；异步完成后直接写回。
- `pc-server/inference-engine/context-snapshots.ts:60-72`：失效只清缓存，没有取消或作废旧召回任务。
- `pc-server/memory/index.ts:752-769`：提示词按当前可见记忆过滤旧选择，交集为空会退回全量。

两个独立红场景：

1. 助手 A 完成召回后移动至助手 B，B 不得复用 A 的选择。
2. 嵌入/重排进行中修改记忆或重新匹配，旧任务不得写回已失效选择。

### P1-3：HTTP 与信号 shutdown 清理不一致

证据：

- `pc-server/server.ts:246-266`：HTTP 路径先刷盘，遗漏 detached 工作区进程和 stdio MCP 清理。
- `pc-server/server.ts:498-533`：刷盘与释放锁。
- `pc-server/server.ts:535-548`：信号路径包含额外清理，且先停 IM 再刷盘。

风险：桌面壳使用的 HTTP 路径可能留下孤儿进程，刷盘后旧生产者仍可能修改状态。

### P1-4：SSH 子代理丢失远程环境说明

证据：

- `pc-server/conversations/orchestrator.ts:860-875`：父生成注入远程工作区提示。
- `pc-server/conversations/orchestrator.ts:896-909`：子代理只接收本地 `engineCwd` 等参数。
- `pc-server/pi-engine/subagent-tools.ts:210-230`：子代理资源只追加通用子代理提示。

准确症状：SSH 工作区中的子代理可能按本机 shell/路径理解任务。

### P2：冗余和测试维护项

- HTTP 与信号 shutdown 各维护一份清理清单，已经发生漂移。
- 安卓导入/导出分别手工维护 PC-only 字段策略，已经发生漏项。
- `web-ui/app/components/message/parts/subagent-tool-part.tsx:12`：未使用 `Bot`。
- `web-ui/app/components/message/chat-message.tsx:17`：未使用 `Tooltip`、`TooltipContent`、`TooltipTrigger`。
- 两处 `prepareMemoryRecall` 是有意的共享冻结缓存调用，不作为重复代码删除。
- 本地与 SSH 工具内核是不同边界实现，不在本次 debug 中强行合并。

## 5. 执行顺序与红测试计划

### D0：固定测试基线

1. 重新运行 typecheck、前后端测试和构建，更新本文基线。
2. 修正 `pc-server/scripts/request-chain-smoke.ts` 的旧记忆配置：直接给当前助手设置 `memoryWriteScope: "always_assistant"`，不要只修改全局 `writeStrategy`。
3. 确认请求链的记忆写入、后续注入和 API 读取全部通过，再把它作为最终验收入口。

```bash
cd pc-server
bun run smoke:request-chain
```

### D1：IM 停止与 waiter 终态

目标测试：

```bash
cd pc-server
bun test im/runtime.test.ts conversations/message-queue.test.ts
```

必须覆盖：

1. deferred 模型回答未释放时，`/stop` 已触发 abort。
2. 停止后 waiter 结算、队列不自动续跑、后续命令可处理。
3. 前序生成失败后 waiter 不悬挂。
4. 正常两条消息仍保持 FIFO。

修复边界：

- `/stop` 走命令快速通道，不等待普通问答。
- 明确 IM 排队项在停止/失败时是取消还是保留；不能出现 waiter 已结算但桌面 resume 后又静默生成且无人接收回复的状态。
- 不用全局清空所有队列的方式误伤桌面和语音。

### D2：导入统一作废运行态

目标测试：

```bash
cd pc-server
bun test backup/import-runtime.test.ts conversations/message-queue.test.ts
```

必须覆盖生成、pi 压缩、队列 waiter、审批、steering、待发广播和 settings-only 导入。

推荐统一作废范围：

```text
生成 AbortController
压缩任务与压缩代际
消息队列与 waiter
审批等待
steering 通道
待发 SSE 广播
working set 与脏标记
```

异步任务返回时必须验证会话身份/代际，不能只依赖 abort。

### D3：PC-only 配置保留

目标测试：

```bash
cd pc-server
bun test backup/android-contract.test.ts backup/zip-structure.test.ts
```

给所有 PC-only 字段写入非默认哨兵值，执行安卓设置导入后逐字段断言不变；同时验证安卓导出仍剥离敏感字段。

收敛一份明确的导入保留清单，不再靠新增字段时手工记得补合并代码。

### D4：记忆缓存代际

目标测试：

```bash
cd pc-server
bun test memory/recall.test.ts inference-engine/context-snapshots.test.ts
```

缓存身份至少包含：

```text
conversationId + assistantId + embeddingModelKey + invalidationGeneration
```

失效递增代际；召回写缓存前重新核对，避免旧异步结果复活。

### D5：统一 shutdown

将 HTTP 与信号入口收口到同一实现，并用 spy 验证调用顺序和幂等：

```text
停止接收入口
→ 停止 IM、生成等状态生产者
→ 清理 detached 工作区进程
→ 关闭 stdio MCP、SSH
→ 刷 settings / conversations / memory
→ checkpoint
→ 释放数据目录锁
→ 退出
```

保留 `/api/app/shutdown` 的 loopback-only 与代理转发头防护。

### D6：SSH 子代理上下文

扩展 `pc-server/pi-engine/subagent-tools.test.ts`：

- 子代理收到远程 shell、发行版、路径和“非沙盒”说明。
- 本地工作区不注入远程说明。
- 并发子代理不重复探测 SSH。
- pi 本地资源目录继续使用 `engineCwd`。

### D7：前端与维护项

1. 补设置搜索索引和中文关键词。
2. 删除 4 个未使用 import。
3. 修正旧请求链冒烟配置。
4. 不执行全仓自动格式化，不混入无关重构。

```bash
cd web-ui
bun test app/tests/settings-search-index.test.ts
bunx oxlint app
```

### D8：全量验收

按层次执行，不允许跳级：

```text
最小回归测试
→ 原始复现脚本
→ 所属模块完整测试
→ 后端/前端全量测试
→ typecheck
→ 前端生产构建与桌面壳编译
→ 请求链、备份、代理、Bash 冒烟
```

常用命令：

```bash
cd pc-server
bun run typecheck
bun test
bun run smoke:request-chain
bun run smoke:backup-roundtrip
bun run smoke:proxy-behavior
bun run smoke:embedded-bash

cd ../web-ui
bun run typecheck
bun run test:unit
bunx oxlint app
bun run build

cd ../desktop-shell
MSYS_NO_PATHCONV=1 cmd.exe /c build.cmd
```

#### D8 执行记录（2026-10-28）

| 层 | 结果 |
| --- | --- |
| 后端全量 `bun test` | 2069 pass / 8 skip / 2 fail |
| 后端 `typecheck` | 0 错误 |
| 前端 `test:unit` | 509/509 |
| 前端 `typecheck` / `oxlint app` | 0 错误 / 0 警告 |
| 前端 `build` / 桌面壳 `build.cmd` | 成功（`dist\RikkaHub.exe`） |
| 请求链 / 备份往返 / 代理 / Bash 冒烟 | 全部 PASS（退出码 0，无孤儿监听） |

2 个失败为已知环境基线：非管理员会话写 `C:\WINDOWS\Temp` 报 `EPERM`
（`workspace/boundary.test.ts`、`workspace/runtime.test.ts`），隔离复跑同样失败，
与本次改动无关。

验收中修掉的测试基础设施缺陷：

1. Windows 下 `Bun.spawn(["bun", ...])` 走 npm shim 多一层包装，`kill()` 只杀包装层，
   真服务器变孤儿占端口/数据目录。全部 e2e 与冒烟改为 `Bun.spawn([process.execPath, ...])`。
2. `memory/vector-index.ts` 防抖回调在设置被整体替换（导入/重载）后读到缺失字段，
   定时器内抛出未捕获 TypeError。两次读取改为空值安全，字段缺失视同关闭。

## 6. 单个 bug 的标准流程

### Phase 1：反馈闭环

开始前必须能写出一条命令，并证明它：

- 捕获用户准确症状。
- 当前实现下稳定变红。
- 修复后同一命令可变绿。
- 秒级、确定、可无人值守。
- 不依赖真实付费供应商、真实 QQ/微信消息或外部 SSH 主机。

没有红测试，不进入实现修改。

### Phase 2：复现与最小化

- 至少连续复现两次。
- 逐步删除无关助手、模型、消息和配置。
- 剩余每个元素都必须是触发问题所必需。
- 最小场景成为回归测试，原始场景留作最终复验。

### Phase 3：假设

测试前列出约 3 个可证伪假设，格式：

```text
如果 X 是原因，那么改变 Y 后故障应消失/加重。
```

不得只凭单个看似合理的解释直接修改。

### Phase 4：探针

- 每次只改变一个变量。
- 临时日志统一标记 `[DEBUG-rdp-编号]`。
- 不做无差别全链路日志。
- 凭据、token、认证头、私钥和用户内容必须写为 `<REDACTED>`。

### Phase 5：修复与回归

- 先确认新测试在旧实现上失败。
- 只修改缺陷需要的文件。
- 修复后跑最小测试、原始复现和模块测试。
- 不处理并行会话留下的无关语义问题；仅报告。

### Phase 6：清理

- 删除所有 `[DEBUG-rdp-*]`。
- 关闭本轮启动的测试服务。
- 检查最终 diff 与 `git diff --check`。
- 记录真实根因、修改范围、测试证据和剩余环境失败。

## 7. 环境与进程安全规范

1. 测试使用独立 `RIKKAHUB_PC_DATA_DIR` 和 `RIKKAHUB_ANALYTICS=0`。
2. 模型、MCP、WebDAV、S3、代理等均使用本地 mock；打真实计费接口前必须另行确认。
3. 未经确认不安装/卸载 APK、不操作真实 IM 平台、不修改外部 SSH 主机。
4. 测试结束后优先用对应实例的 `/api/app/shutdown` 清理，不动正式 17455 demo。
5. `server.ts` 被脚本直接启动时不受桌面壳 Job 防孤儿保护。2026-10-27 曾出现 88 个孤儿 bun、约 6.35 GB 工作集。
6. 如需杀进程，先列出 PID、端口、命令行、保留清单和数量，再取得明确确认；禁止静默批量 `taskkill`。
7. 已知保留项：17455 验收 demo 和 Qoder 自身的子进程。判活不能只看进程名。
8. 测试残留目录先列出再询问，不擅自递归删除。
9. 当前仓库常有并行编辑；不要覆盖、还原或格式化他人未提交改动。

## 8. 完成定义

只有同时满足以下条件，才能声明本轮 debug 完成：

- D1–D7 新增回归测试均从红变绿。
- 原始请求链冒烟通过。
- 前端设置搜索失败清零。
- 后端除已登记环境失败外没有新增失败。
- 导入后旧生成、压缩、队列、waiter、审批和广播无法污染新状态。
- 安卓导入保持 PC-only 配置，敏感字段剥离仍有效。
- 两种 shutdown 使用同一生命周期。
- 无调试日志、无本轮遗留测试服务、无无关大规模格式化。
- 最终报告明确区分“代码验证通过”“真实 UI/外部平台待用户验收”和“已知环境性失败”。
