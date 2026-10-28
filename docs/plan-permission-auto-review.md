# 权限预审档（sandboxed_auto）方案

> 状态：修订方案，未开工。本文只描述设计；实现代码零改动。
> 参考对象：DeepSeek Harness 0.2.1-rc.3 官方 `auto` 与社区 `dsh-auto-approve` 的 `sandboxed-auto`（源码位于本仓库同级 `reference/_dl/`）。

## 0. 一句话结论

在 `balanced` 与 `full_access` 之间新增工作区专属档位 `sandboxed_auto`：**复用现有审批状态机和已落地的操作系统写边界，由模型先应答一次；模型放行不置 `userApproved`，失败或拿不准就交回人工。**

与上一版的关键区别：**本地 bash 自动放行必须以 `/api/app/sandbox` 实测边界生效为前提**。现在低完整性进程/容器挂载能约束 bash 及其子进程的区外写，不再只是 write/edit 的应用层 realpath 自觉。区外读和网络仍无硬边界，SSH 远端也不受本机沙盒保护，所以仍不能宣称凭证不会外泄或完整命令安全。

`sandboxed_auto` 是“审批策略 + 实测系统边界”的组合档，不是换个名字的 balanced。边界未生效、未知或不适用时，可以保留预审 UI 和人工卡，但**不得自动 approve**；不能静默退化成模型直接放行无沙盒 bash。

## 1. 现状与本方案能改变的边界

| 已有能力 | 位置 | 与本方案的关系 |
| --- | --- | --- |
| 三档预设 | `foundation/types/index.ts`、`workspace/index.ts` | 新档只用于工作区；读取与更新两处归一化都要改 |
| 两段式审批矩阵 | `workspace/approval.ts` | 无参下界到终局只升不降；新档 bash 无参即 pending |
| 危险命令清单 | `workspace/approval.ts` | 保留并先于模型；只覆盖已知灾难形态，不是完整 shell 解析器 |
| 执行层危险命令兜底 | `workspace/runtime.ts` | 新档模型放行不得绕过；只有真人批准可越过 |
| write/edit 严界 | `workspace/boundary.ts` | 模型放行仍走严界；边界生效时区外写由 OS 拒绝 |
| Windows/容器沙盒 | `workspace/sandbox.ts`、`restricted-launch.ts` | 低完整性/只读挂载约束整个后端及 bash 子进程的区外写；以实测 `boundaryActive` 为准 |
| 区外读 | `workspace/boundary.ts`、沙盒 no-write-up 语义 | 原语义免审；低完整性只挡写不挡读，仍可能读取敏感文件 |
| bash / 网络 | `workspace/runtime.ts`、沙盒实测状态 | 本地写已有条件性硬边界；网络无约束，SSH 远端不受本机边界保护 |
| run-and-suspend 审批 | `inference-engine/approval-flow.ts`、`approval-gate.ts` | 复用 pending → approved/denied；预审不另造 waiter |
| subagent | `tools/subagent.ts`、`pi-engine/subagent-tools.ts` | 继承父工作区和 preset；每任务独立 approvalScope，默认无 bash，写路径加锁 |
| MCP 逐工具审批 | `tools/approval.ts`、`pi-engine/general-tools.ts` | 只预审原本 `needsApproval=true` 的 MCP；不受工作区写边界保护 |
| 技能库免审 | `workspace/approval.ts`、`tools/approval.ts` | 新档取消此豁免，技能代码改动必须人工 |
| 真人批准的副作用 | `workspace/runtime.ts`、`conversations/orchestrator.ts` | 沙盒未生效时 `userApproved` 可放宽应用层边界；沙盒生效时真人也写不了区外 |

本方案主要改变的是：**balanced 下大量普通 bash 完全免审的问题**。新档把这些调用纳入预审或人工，同时复用已有沙盒约束本地写副作用。

明确不在本方案内解决：通用文件读取策略、网络隔离、完整 shell 静态分析、MCP 服务端行为约束、SSH 远端沙盒。即使本地写边界生效，也不能宣传为“安全全自动”或“凭证不会外泄”。

## 2. 不变量

- **I1 真人批准与模型放行严格分型。** 模型放行不置 `userApproved`，不能越过危险命令执行兜底。沙盒生效时区外写由 OS 拒绝，真人卡也不能承诺放行。
- **I2 自动放行以实测边界为前提。** 仅本地 Windows/容器、`tier=restricted` 且 `measured=enforced` 时，模型才可 approve bash；off/full/not_enforced/unknown 与 SSH 一律转人工。MCP 不因该条件获得任何额外安全保证。
- **I3 确定性规则优先。** 危险清单与 A 类人工规则先于记忆和模型；命中后模型不可推翻，但是否执行最终仍可由真人决定，不做永久 `deny`。
- **I4 失败关闭到人工，不是直接执行。** 超时、无模型、中止、流式协议异常、输出非法、内部异常、配额耗尽、沙盒状态不满足均进入现有人工卡；若会话已中止，则按现有中止流程收敛 denied，不再弹卡。
- **I5 一次性放行为默认。** 默认不记忆。后续若启用记忆，仅限相同根会话、approvalScope、工具、原始参数、cwd、preset、沙盒状态、策略版本的精确键，并受 TTL 和容量限制；危险/A 类命中永不记忆，父子代理不共享记忆。
- **I6 全链路可审计且最小化留痕。** 模型、记忆、规则转人、真人裁决均有来源；默认不持久化完整参数、完整用户消息或模型原始响应。
- **I7 不改变其他档位。** `confirm_each`、`balanced`、`full_access` 的行为不变；新档新增的严格行为只作用于 `sandboxed_auto`。
- **I8 子代理不扩权。** dispatch 本身保持 auto，实际审批发生在子工具；子任务 prompt 只是直接父级指令，不能扩大真人授权。所有子任务共享根会话预审配额，取消沿父 signal 级联。

## 3. 新档审批矩阵

| 工具/场景 | confirm_each | balanced | **sandboxed_auto** | full_access |
| --- | --- | --- | --- | --- |
| read / grep / find / ls | 免审 | 免审 | 免审（包括区外读，风险不隐藏） | 免审 |
| write / edit（工作区内） | 审批 | 免审 | 免审 | 免审 |
| write / edit（区外） | 审批 | 审批 | **模型不可批；边界生效时人工批准也会被 OS 拒绝** | 免审（仍受实测系统边界约束） |
| write / edit（skills 目录） | 审批 | 免审 | **恒人工** | 免审 |
| 本地 bash（普通命令） | 审批 | 免审 | **仅沙盒实测生效时模型可批，否则人工** | 免审 |
| SSH bash（普通命令） | 审批 | 免审 | **恒人工，本机沙盒不保护远端** | 免审 |
| bash（危险清单/A 类） | 审批 | 审批 | **恒人工；系统边界仍继续生效** | 免审 |
| MCP `needsApproval=true` | 审批 | 审批 | **先模型预审，再放行或人工** | **仍按 MCP 自身 `needsApproval`，不被工作区档关闭** |
| MCP `needsApproval=false` | 免审 | 免审 | 免审 | 免审 |

两点刻意说明：

1. 新档确实比 balanced 更严格：普通 bash 和 skills 写入从免审变为预审/人工。这与“减少打扰”并不矛盾——模型只消化其中低风险部分，不能继续维持普通 bash 全免审再自称安全档。
2. 工作区 preset 不是 MCP 总开关。首版矩阵中“full_access 下 MCP 免审”没有源码依据，删除。无工作区会话仍可配置 MCP 预审，但文案不得称其为工作区沙箱。
3. subagent 继承同一工作区 preset，因此子面 bash 也适用“本地 + 沙盒实测生效”门槛。默认子面没有 bash；用户显式开启后，路径锁仍不覆盖 bash 重定向，不能因模型预审而忽略这一点。

## 4. 统一审批生命周期

```text
流式参数未到
  → 按现有下界建卡；新档 bash 下界为 pending，绝不后来降 auto

参数齐备、工具 execute 内
  1. 现有矩阵求 pending；auto → 直接执行
  2. 危险清单 / A 类人工规则 → 跳过模型和记忆
  3. 自动放行资格检查 → 本地 bash 要求 restricted + enforced；SSH/状态异常转人工
  4. 可选精确记忆 → 命中则 model-equivalent 放行
  5. 模型预审 → approve 则放行；ask 或任何失败则继续
  6. gateToolApproval → 建/更新 pending 卡、注册 waiter、等待真人
  7. 真人批准才得到 userApproved=true；拒绝/中止按现有流程抛错
  8. 执行层再次检查危险规则与实测边界；系统拒绝不得被审批结果覆盖
```

**预审发生在 `gateToolApproval` 之前，因此不得调用 `resolveToolApproval`。** 此时尚未登记 waiter，调用会返回 false 并丢失裁决。正确实现是预审函数直接返回 `allow / manual / aborted`：`allow` 绕过人工等待但不产生 `userApproved`；`manual` 才调用 `gateToolApproval`。

若产品一定要让模型“回答已显示的 pending 卡”，则必须把预审放进 waiter 已注册后的审批状态机，并新增决议来源字段；这是另一套实现，不能与上述前置预审混写。首版采用前置预审，改动更小，也避免卡建后消失。

聊天引擎的 pause-resume 与 pi 的 run-and-suspend 不同：裁决结果应分别表达为“继续执行但未获真人边界豁免”和“恢复并等待人工”，不能在聊天恢复路径复用 `userApproved=true`。P1 必须先补齐两引擎语义测试，不能只改 pi。

## 5. 确定性规则：人工门槛而非安全证明

在 `workspace/approval.ts` 保持纯函数判定；需要文件系统事实（是否有未提交改动、目标是否存在）时不得在这里偷偷做 I/O，应由执行上下文提供证据，或保守转人工。

A 类首批只收高确定性、高收益形态，避免正则清单膨胀成伪沙箱：

- **历史改写/发布/共享状态**：force push、`--mirror`、破坏性 refspec、`git clean -fdx`、包发布、生产部署、共享分支推送。
- **运行时自我修改与供应链**：写应用设置、MCP 配置、插件/preset、`pc-data/skills/**`；全局安装或把下载内容直接交给解释器执行。
- **凭证读取与任意外发**：对已知凭证路径、浏览器 profile、`.env` 的读取；网络命令与本地文件/标准输入重定向组合。仅作为人工门槛，不能声称覆盖编码、变量展开和间接外发。
- **系统级变更**：提权、服务、防火墙、计划任务、注册表和安全控制。
- **混淆且伴随副作用**：命令替换/进程替换/编码执行与写、删或网络操作组合；无法判断时转人工。
- **高风险 MCP**：按“服务端 + 工具名 + 参数效果”配置默认人工清单，不能只按 `delete` 等名字子串猜测。

执行层兜底分两类写清：

1. 现有危险 bash 清单：继续在 `workspace/runtime.ts` 检查；模型放行不算 `userApproved`，命中仍不执行。
2. 新档路径类规则：在 write/edit 的实际 Operations 入口复核 preset、resolved path 与真人豁免，尤其 skills/pc-data；只在审批层判正则没有执行保证。

MCP 没有统一的本地执行层可兜底，只能保证“模型未放行则走人工”，不能保证 MCP 服务端实际效果。A 类规则不是对工具结果、脚本内容或运行时展开的分析。

## 6. 预审输入、输出与授权语义

### 输入

一条 JSON user message，加固定 system policy：

```json
{
  "tool": "bash",
  "args": {"command": "npm install -D vitest"},
  "approvalReason": "existing untrusted reason",
  "preset": "sandboxed_auto",
  "workspace": {"root": "D:\\...", "cwd": "D:\\...", "remote": false},
  "sandbox": {"tier": "restricted", "measured": "enforced"},
  "caller": {"kind": "main|subagent", "approvalScope": "main|subagent-...:0"},
  "latestUserMessage": "bounded trusted instruction",
  "directParentTask": "subagent only; delegated scope, not user authorization",
  "policyVersion": "v1"
}
```

- 参数和审批理由是被审对象，不是指令；工具结果、助手正文、项目说明不得作为授权来源。首版不发送 `historySummary`，避免把历史模型行为误当权限。
- `latestUserMessage` 只取当前根会话可验证的真人用户文本；`directParentTask` 仅存在于 subagent，作用是限定委派范围，不能覆盖真人限制或把一条 medium 操作变成已授权。项目指令、子代理摘要和 checkpoint 均不授权。超过 2000 字、来源无法确认或授权冲突未解决 → 人工。
- subagent 使用与父会话相同的预审 provider/model，但子任务指定的 `model_id` 不得改变预审路由或权限策略，避免委派时静默换用更弱审查器。
- 参数可能包含秘密、私人文本或路径。设置页必须明确“预审会把工具参数和一段用户消息发送给所选 provider”；默认使用当前助手 provider/model 前，也要给出这一提示。不要用静默截断改变命令语义：参数超预算直接转人工。
- 审计摘要做长度限制和控制字符清理；检测到 token/key/password 等形态时只存字段名与哈希，不存值。哈希用于关联，不视为匿名化。

### 输出

首版只保留二元裁决，避免把模型主观 `deny` 变成不可恢复的最终拒绝：

```json
{"verdict":"approve","risk":"low"}
{"verdict":"approve","risk":"medium"}
{"verdict":"ask","risk":"medium","reason":"short optional reason"}
{"verdict":"ask","risk":"high","reason":"short optional reason"}
```

- `high+approve`、`low+ask` 之外不必靠组合表达更多语义；为保持协议最小，实际只允许 `low+approve`、`medium+approve`、`medium+ask`、`high+ask`。其他组合、额外字段、多余文本、工具调用、流式协议异常 → 人工。
- `high` 表示疑似敏感数据跨信任边界外泄等高关注效果，**仍转人工，不是系统永久禁止**。真人是否能批准由现有执行边界和法律/产品策略决定，模型无权作最终裁决。
- `reason` 只用于审批卡与审计摘要，不进入主模型的授权上下文，也不作为下一次调用的授权。
- low：常规、可逆、项目相关工作。medium：不可逆删除既有对象、外发、生产或权限变更，只有真人对动作、目标、范围明确授权才可 approve。high：疑似凭证/隐私跨边界外泄，一律 ask。

## 7. 数据、配置与导出

### 审计

通过现有 SQLite 迁移机制新增 PC 专属表，不直接执行 DDL 片段：

```sql
CREATE TABLE tool_approval_audit (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  args_summary TEXT,
  preset TEXT NOT NULL,
  sandbox_tier TEXT,
  sandbox_measured TEXT,
  approval_scope TEXT NOT NULL,
  subagent_task_index INTEGER,
  decision TEXT NOT NULL,       -- allow_once | manual_required | denied | aborted
  source TEXT NOT NULL,         -- classifier | memory | rule | human | system
  risk TEXT,
  model_id TEXT,
  policy_version TEXT,
  reason_summary TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_approval_audit_conv
  ON tool_approval_audit(conversation_id, created_at);
```

同一次调用允许多行：`rule/manual_required` 后再有 `human/allow_once`。`hard_block` 容易误导为永久拒绝，不用。审计记录裁决事实，不保证还原全部命令内容；完整参数仍以会话记录为准。

### 配置

```jsonc
"permissionAuto": {
  "enabled": false,
  "provider": null,
  "model": null,
  "timeoutMs": 15000,
  "reviewQuotaPerSession": 30,
  "memoryEnabled": false,
  "memoryTtlMs": 1800000,
  "policyVersion": "v1"
}
```

- `null` 表示跟随当前助手路由；UI 明示外发与成本，不宣称免费。可另选更快模型，但不能用未配置模型时静默放行。
- 配额限制的是**预审请求次数**，不是自动放行次数，避免规则命中和失败路径绕过预算。主生成与全部 subagent 按根 conversationId 共享一个原子计数器；不能每个 approvalScope 各领 30 次。并发调用、子任务与重试共享计数，超限转人工。
- 记忆默认关闭；开启后按 approvalScope 隔离，父代理已批准的调用不能成为子代理的授权依据。沙盒 tier/measured、SSH/本地身份、模型与 policy 都进键，状态变化即失效。
- 超时、配额、TTL、模型、policy 的变更不追溯改写历史审计。修改 policy/model 后旧记忆键自然失效。
- PC 专属 preset、预审配置和审计在安卓导出时剥离；工作区 preset 映射为 `balanced` 或产品明确的保守档，不能序列化未知枚举。备份保留 PC 数据时则需覆盖新表与新设置，并纳入恢复测试。

## 8. 接入点与必须补齐的契约

1. `foundation/types/index.ts`：扩展 preset 联合类型与 DTO。
2. `workspace/index.ts`：更新校验与 `normalizePreset` 同时支持新档，不能只改写入端。
3. `workspace/approval.ts`：新档矩阵、A 类纯函数、skills 豁免差异；新档 bash 的无参下界为 pending。
4. `tools/approval.ts`：复用终局判定；MCP 仍由自身 `needsApproval` 决定，不套用 full_access 免审。
5. 新增引擎无关预审服务：只返回 allow/manual/aborted，不直接操作 waiter、不置 userApproved；取消、超时、根会话共享配额在这里统一。调用前读取 `sandboxStatus()`，不能使用环境声明或 UI 开关代替实测。
6. `pi-engine/workspace-tools.ts` 与 `pi-engine/general-tools.ts`：都在 `gateToolApproval` 前调用预审，避免只覆盖 bash 而漏 MCP。workspace 上下文需带本地/SSH 身份；SSH bash 无自动放行资格。
7. `pi-engine/subagent-tools.ts`：子面复用上述工具包装即可继承预审；额外传入 approvalScope、任务序号与 directParentTask，不另写子代理审批分支。dispatcher 自身仍 auto。
8. 聊天引擎工具执行/恢复链路：单独实现同样的“模型放行但无真人豁免”，并验证暂停恢复不会重复执行工具。
9. `workspace/runtime.ts` 与 write/edit Operations：危险命令和路径规则执行层复核；保持 sandboxBoundaryActive 时强制严界，不能为预审新增宽界入口。
10. `conversations/orchestrator.ts`：真人路径仍是唯一 `userApproved=true` 来源。
11. 审计通过注入的 observer/应用层适配器落地；预审核心不直接依赖 pi、parts、SQLite、SSE，遵守现有分层。审计携带沙盒状态和 subagent 身份。
12. 前端：工作区档选择、provider/model 与数据外发提示、审计来源徽标、转人工原因；自动放行资格直接显示现有“系统边界：已生效”实测状态，边界失效时明确“仅人工审批”。
13. SSH 工作区、子智能体并发与 approvalScope、恢复/重启、备份与安卓导出均纳入同一契约；不能只验本地 pi 主会话。

## 9. 能保证、只能降险、不能保证

### 能保证（限本地、实测边界生效时）

- Windows 低完整性/容器挂载对 bash 及其子进程同样施加区外写限制，不再只有 write/edit 受控。
- 模型放行不会获得真人 `userApproved` 的应用层边界豁免；沙盒生效时真人批准也不绕过 OS 拒绝。
- 已覆盖的危险命令和路径规则不会被模型推翻，并有对应执行层复核。
- 预审失败、沙盒未生效或状态未知不会静默变成执行许可。
- 子代理继承同一 preset 与沙盒，dispatch 不形成绕过路径；裁决来源、模型、policy、沙盒状态和子任务身份可追踪。

### 只能降险

- 普通 bash 的模型分类、正则危险识别、提示注入抵抗、MCP 风险判断。
- 已知凭证路径和常见外发形态的识别；变量展开、编码、脚本内容和间接网络通道仍可能漏报。
- subagent 路径锁只覆盖 edit/write；即使模型预审通过，bash 写仍不受这把锁串行化。
- 记忆只减少完全相同调用的重复预审，不证明该命令在新文件系统状态下仍安全。

### 不能保证

- **凭证不会外泄。** Windows 低完整性是 no-write-up，不是 no-read-up；区外 read 和 bash 读取仍可用，网络也未隔离。
- **所有 bash 副作用都限制在工作区。** 网络、外部服务、已挂载可写区及系统允许的其他副作用不因 no-write-up 消失；SSH 远端完全不受本机沙盒保护。
- **MCP 服务端按声明行事。** 工作区边界管不到远端或第三方服务，沙盒生效也不是 MCP 自动放行理由。
- **任何部署都一定有硬边界。** `not_enforced/unknown/off/full` 时不给自动批准；容器与 Windows 的可见性和可写范围也不完全相同。

准确口径是：**实测沙盒为本地自动放行提供区外写硬边界，模型只负责降低审批打断；读、网络、MCP 和 SSH 风险仍在。**

## 10. 可恢复性（独立于预审）

预审不能替代回滚。对删除、批量重写、依赖安装和部署前，优先复用现有 git checkpoint/补丁；非 git 文件只对有明确范围且用户可见的目标做快照。快照失败时相应高风险操作转人工，不拿“大概率可恢复”当保证。

快照本身有空间、敏感副本和清理成本：纳入工作区数据管理与保留期，不默认复制凭证目录，不承诺所有外部/MCP/生产副作用可回滚。

## 11. 验收

- 矩阵：四档 × 工具 × 参数未到/齐备 × 区内/区外/skills；断言 pending 不降级及其他三档不变。
- 生命周期：预审在 waiter 之前不发生 `resolveToolApproval`；模型放行不置 userApproved；人工路径仍可越过既有危险命令门。
- 两引擎：pi run-and-suspend 与聊天 pause-resume 全覆盖；MCP 与工作区工具都有用例；中止不遗留 awaitingApproval/waiter。
- fail-closed：超时、无模型、协议错、非法 verdict/risk 组合、异常、配额满、参数过长、来源不明均转人工；已中止则 denied。
- 记忆：默认关闭；精确键包含 cwd/preset/policy，TTL、容量、危险/A 类不记忆、配置变更失效。
- 执行兜底：模型 approve 后，危险 bash 与 skills/区外写仍不能借模型豁免执行；restricted+enforced 下真人批准区外写也仍被 OS 拒绝。
- 沙盒资格：off/full/not_enforced/unknown、SSH 均转人工；运行中边界状态变化使记忆和自动放行资格失效，不得只信 RIKKAHUB_SANDBOX 声明或设置开关。
- 子代理：默认无 bash；显式开启后继承同一预审门槛；directParentTask 不扩权；父子记忆隔离；所有子任务共享根会话原子配额；并发审批与取消互不误清。
- 数据：审计多阶段关联、沙盒状态、approvalScope/subagent 身份、脱敏、重启后仍在；安卓导出不带新 preset/配置/审计，PC 备份恢复完整。
- 回放集：历史调用人工标注，分别报告“模型误放行”“不必要转人工”“规则命中”，不能只考核 A 类漏报而忽略模型错误；误放行存在未知样本时不得默认开启。
- Windows 真机、容器、SSH、子智能体、并发配额与取消均实测。

## 12. 分阶段

| 阶段 | 内容 | 进入条件 |
| --- | --- | --- |
| P0 | 新档矩阵、沙盒实测资格、确定性人工规则、执行兜底、subagent 上下文、审计与导出契约；不接模型 | 沙盒与 subagent 现有测试不回归，两引擎与 MCP 路径明确 |
| P1 | 默认关闭的预审器、严格协议、超时/取消/根会话共享配额、设置与外发提示 | P0 验收通过，回放集已建立；本地沙盒实测生效 |
| P2 | 默认关闭且按 approvalScope 隔离的精确记忆、审计报告与策略调优 | P1 真机误放行评估通过 |
| P3 | 剩余硬边界：出网 allowlist、读取隔离、SSH 远端约束等 | 单独方案与验收，不与新档捆绑 |

已有 Windows/容器写沙盒不再是 P3 待办，而是 P1 自动放行的前置条件。P0 建立资格与审计，P1 只降低人工频率；读、网络、MCP、SSH 未收紧前，不使用“安全全自动”或“凭证不会泄露”等宣传。

## 13. 与 DSH 的取舍

- 借社区插件的骨架：确定性规则前置、失败转人工、一次性放行、可配置模型。
- 借官方 auto 的策略：按实际效果分级、授权来源分区、工具结果不能授权。
- 不照搬官方无沙箱逐调用 auto，也不照搬社区“一次沙箱升级”的语义：本项目没有同样的 sandbox escalation API。
- 模型不是最终权限主体；真人、确定性执行边界、审计分别保留自己的职责。
