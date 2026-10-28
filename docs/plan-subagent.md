# 子智能体（subagent）：计划

- 版本：0.0.7 候选特性（编号占位，按发布节奏定）
- 范围：主 AI 派遣「子智能体」执行子任务——子智能体跑在隔离上下文里，可用工具干活，干完只把**摘要**带回主对话
- 状态：**纯方案，未动任何代码**（2026-10-26）。等用户批准后才进入实施。
- 背景结论：上游 RikkaHub 无此能力且明确拒绝第三方 server tools（issue #1490 维护者回复 "I will not add support for third-party server tools"）；社区 fork ExTV/rikkahub-agent 已验证该语义可行（`subagent_dispatch` 工具、独立 side-context、默认并发 3、结果单条摘要回灌），但其为 Android 原生实现，不移植代码，只对齐语义。

---

## 0. 结论先行

**subagent 不引入任何新安全体系。它就是一个普通工具（`subagent_dispatch`），声明、审批、执行全部走现有管线**，与 search_web / MCP 工具同级同待遇：

1. 声明进 `tools/bound`（聊天引擎与 pi 引擎同一注入源，schema 逐字一致）；
2. 审批走 `initialApprovalState` + `gateToolApproval`（现有三档矩阵，不新增判定分支——subagent 本身恒 auto，子智能体**内部**的工具调用才是审批发生地）;
3. 执行进 `tools/execution.executeToolCall` 分发（聊天引擎路径），pi 路径经新桥 `pi-engine/subagent-tools.ts` 复用同一执行内核——照抄 general-tools.ts 的「根源纪律：一行分发/守卫/审批逻辑都不复刻」。

三条不变量：

1. **pi 只出大脑，不出手脚。** pi 自带的 subagent 扩展（`pi/packages/coding-agent/examples/extensions/subagent`）**不启用**——它 spawn 独立 pi 子进程，携带 pi 内建 read/bash/edit/write，绕开 `executeWorkspaceToolCore` 的三道闸与审批壳，正是 runner.ts:21 注释明令封死的绕行面。
2. **子智能体的每一次动手都过现有审批。** 子智能体经 `runPiGeneration` 跑隔离会话，其工具面 = 从现有 customTools 装配函数现取的**子集**；审批判定与父会话逐字同源——工作区工具的 pending/auto 由**该工作区的 `permissionPreset`**（`confirm_each` / `balanced` / `full_access`，`foundation/types/dto.ts:150`）决定，子智能体继承不放宽。
3. **主对话不被子过程污染。** 子生成不落库（runner 本就不写 DB）、不进父 sink、不占父 part 流；终局只有一条摘要文本作为工具结果回灌模型。

## 1. 已定裁决（与用户对齐过）

| # | 裁决 | 理由 |
| --- | --- | --- |
| D1 | 自己写 `subagent_dispatch` 工具，**不开 `noExtensions`、不用 pi 子进程方案** | 扩展方案绕开审批壳；便携版不带 pi CLI |
| D2 | 子智能体工具面**可配置**，默认 = read / grep / find / ls + search_web / scrape_web + **edit / write**；bash 默认不含 | 用户明确要求子智能体能写文件（2026-10-26）。安全性不靠"只读"兜底：写类沿用工作区 `permissionPreset` + 宽严边界（root/cwd）+ `executeWorkspaceToolCore` 三道闸，**爆炸半径不超出父会话所在工作区**；`confirm_each` 档下每次子写都弹卡 |
| D3 | 深度锁 **1 层**，靠工具面裁剪实现（子面不装 subagent_dispatch），不做运行时计数 | 结构性封顶，免记账、免防并发竞态 |
| D4 | 并发默认 **3** / 单次任务上限默认 **8** / token 预算默认 **200k**，**三项均可自定义**（服务端硬校验区间：1–8、1–16、16k–2M） | 对齐社区语义；一次 dispatch 在父循环只算 1 步，`MAX_TOOL_STEPS=256` 拦不住它，所以必须有自己的预算阀 |
| D5 | 子智能体**固定走 `runPiGeneration`**，即使父会话是聊天引擎 | `fetchAuxiliaryText` 是单发无工具，只算"换个模型问一句"；pi 路径才有真工具循环与隔离上下文 |
| D6 | PC 专属设置，**默认关**；安卓导出剥离（settings 走 `stripPcOnly`，先例：proxyConfig / 长文本粘贴字段） | 与 RERANK 剔除、stdio 剥离同一约定 |
| D7 | 历史会话里的 subagent 工具行，安卓导出时对齐工作区工具行的既有处理；无先例则进 `PC_ONLY_MESSAGE_PART_TYPES` 同款降级 | P3 验收时核实（见 §4 P3-4） |
| D8 | **命名与参数措辞对齐社区 fork**：工具名 `subagent_dispatch`，参数用 snake_case（`model_id`） | 用户拍板（2026-10-26）。理由：从 ExTV fork 迁来的用户心智零成本；将来若给上游提 PR，口径与社区一致更好卖。边界：只对齐**我能确证的部分**（工具名 + `model_id` 存在性 + 并发默认 3），`tasks[]/mode` 的形状来自 pi 示例而非社区 fork——它的 Kotlin 源码没读过，不假装逐字一致 |
| D9 | **同一 dispatch 内，写类工具（edit/write）按目标路径串行化**（路径互斥锁），读类与搜索照常并行 | D2 放开写之后的新 hazards：两个子智能体并发改同一文件 = 丢更新 / `edit.oldText` 失配。锁在 dispatch 作用域内，不引入全局状态。**代价**：子面若自定义勾选 bash，bash 里的重定向写文件不受路径锁保护——UI 需明写这一条 |

**摘要来源**：子智能体终局的 assistant 文本（`outcome.text`）即摘要，**不再额外调一次摘要模型**——子任务 prompt 里明确要求"最后一条回复必须是给主 AI 的结论摘要"，省一次调用、避免二级幻觉。

## 2. 数据流（一次 dispatch 的完整路径）

```
主 AI(pi 或聊天循环) 调 subagent_dispatch { tasks: [{ title, prompt, model_id? }], mode: "single"|"parallel" }
  //  v1 裁决：chain 不进首发（见文末决策 1），`{previous}` 串联由主 AI 自己拆多次 dispatch。
  → tools/execution.executeToolCall 分发到 runSubagentDispatch(新)
  → 逐任务: runPiGeneration({          ← 同一驱动器,零改动复用
        provider/model:  model_id 指定 ? findModel 解析 : 父会话当前模型,
        history: [] ,                   ← 空历史 = 干净 side-context(白送:引擎上下文
                                       //  本就每轮从传入 history 重建,runner 不落库)
        promptText: 任务 prompt,
        cwd: 父会话 cwd(边界壳照常生效:写类同样受 root/cwd 宽严边界约束),
        tools: 子面(从 createPiWorkspaceTools / createPiGeneralTools 现取后按设置过滤;
               //  默认含 edit/write、不含 bash;subagent_dispatch 恒剔除 —— D2+D3),
        sink: 子收集器(不接父 sink;只聚合 usage/状态,进度经 onUpdate 回父循环),
        signal: 父 signal 级联取消,
        conversationId: 父会话 id,
        approvalScopeId: 子 scope(见 P0),
      })
  → 子智能体内部: 工具调用逐个过 initialApprovalState → gateToolApproval →
       审批卡弹给用户(带「子任务」标识) → 放行才执行
       //  工作区工具判定走 workspaceApprovalDecision(tools/approval.ts:33),
       //  继承父会话工作区的 permissionPreset;危险命令拦截仍要求 userApproved,
       //  子智能体拿不到 full_access 之外的豁免
  → 全部完成: 结果以单条摘要文本(每任务一段,含 usage)回灌主 AI
```

并行纪律：与现有工具一致全 `sequential`？**否**——subagent 是长耗时聚合体，父循环内一个 dispatch = 一次工具执行，子任务之间在**执行内核内部**用受并发限制的 Promise 池（默认并发 3）跑；对 pi/聊天循环而言它仍是一个 sequential 工具调用，不破坏父层"审批卡一次一张"的节奏。

放开写（D2）之后的两处必须处理：

1. **并发子审批卡会同时存在多张**（`confirm_each` 工作区下 3 个子智能体可能各自挂一张 pending 卡）。这不是新机制——P0 的 approvalScope 就是为它准备的；卡面加「子任务 · 标题」前缀，用户能分清是谁在请求。
2. **同文件并发写**由路径互斥锁解决（D9）：`runSubagentDispatch` 作用域内维护 `Map<绝对路径, Promise 链>`，子面的 edit/write execute 在真正调 `executeWorkspaceToolCore` 前先排队拿到该路径的锁，用完交棒；不同路径并行。锁不进全局 state、不跨 dispatch。

## 3. 分阶段实施

### P0（前置，独立可发布）：审批等待者加 scope

**问题**：`pi-engine/runner.ts` 收尾时 `clearToolApprovalWaiters(ctx.conversationId)` 全表清扫，`approval-gate.ts` 按 conversationId 逐个 reject。子生成沿用父会话 id ⇒ A 子智能体收工会把正在等用户批准的 B 子智能体的等待者误杀，卡死 pending。**并发 ≥2 必炸，数据正确性问题，先修才谈 subagent。**

改动：

- `inference-engine/approval-gate.ts`：`waitForToolApproval` / `resolveToolApproval` / `clearToolApprovalWaiters` 的 key 从 `conversationId` 扩为 `approvalScope`（默认 = conversationId，**主路径行为逐字节不变**——默认值兜底，现有调用方零改动）。
- `pi-engine/runner.ts`：`PiGenerationContext` 加可选 `approvalScopeId`，runner 传给清扫；`gateToolApproval`（approval-flow）的登记/决议路径透传 scope。
- API `/tool-approval`（api/handlers/conversations.ts）：决议按 `conversationId + scope` 查找；pending 卡 DTO 带上 scope 由前端原样回传，缺省视为主 scope（兼容旧卡）。

验收：单测——两个并发 scope 各挂一个等待者，clear 其一，另一个照常被 resolve 唤醒；主路径（无 scope）现有测试全绿，`bun test` 已知 3 败不新增。

### P1：后端 `subagent_dispatch`（pi 工作区会话先行）

新文件与改动：

- `tools/subagent.ts`（新）：schema + 执行内核。
  - schema：`{ tasks: [{ title, prompt, model_id? }], mode: "single"|"parallel" }`；工具名与 `model_id` 措辞对齐社区 fork（D8）。chain 模式不在 v1（决策 1），上一任务输出改由主 AI 自行拼接后再次 dispatch。
  - 执行内核 `runSubagentDispatch`：并发池（读类并行、写类按路径串行 D9）、总预算（子任务数上限 + 累计 token 上限，均取自设置），超限抛错回灌"预算耗尽"，逐任务调用 `runPiGeneration`、聚合摘要。**纯函数面，不 import pi**（与 approval-gate 同纪律：api 层要 import 执行分发，别把 pi 依赖树拖进去——pi 调用经内部 indirection 注入）。
- `tools/definitions.ts`：`openAiSubagentTool(settings)` 声明（默认关时返回空数组，语义同 enableWebSearch 守卫）。
- `tools/bound.ts`：接入 `conversationFunctionTools` 聚合。
- `tools/execution.ts`：`executeToolCall` 加 `if (name === "subagent_dispatch")` 分支 + 关闭后拒执守卫（语义抄 search_web 关闭分支）。
- `pi-engine/subagent-tools.ts`（新）：pi customTools 桥，照抄 general-tools.ts 骨架（声明同源、执行走同一内核、审批恒 auto——审批发生在子智能体内部工具上，不在 dispatch 本身）。子面装配 = `createPiWorkspaceTools` 全集 → 按 `allowedTools` 过滤（默认剔 bash）→ edit/write 两个包一层路径锁 → 恒剔 `subagent_dispatch`。
- `conversations/orchestrator.ts:856` 装配点：pi 会话工具数组追加 subagent 桥（设置开启时）。

设置项（`foundation/types/settings/app-config.ts`，全部 PC 专属、`stripPcOnly` 剥离）：

| 字段 | 默认 | 自定义区间 | 说明 |
| --- | --- | --- | --- |
| `subagent.enabled` | `false` | — | 总开关，关时工具不声明 |
| `subagent.maxConcurrency` | `3` | 1–8 | 并行子任务数 |
| `subagent.maxTasksPerCall` | `8` | 1–16 | 单次 dispatch 任务上限 |
| `subagent.tokenBudget` | `200000` | 16000–2000000 | 单次 dispatch 累计 token 预算 |
| `subagent.allowedTools` | 默认面（含 edit/write，不含 bash） | read/grep/find/ls/search_web/scrape_web/edit/write/bash 多选 | 勾选 bash 时 UI 需明写"路径串行保护失效"（D9 代价） |

校验纪律：区间**服务端与前端同校验**，服务端为准（不信任前端）；越界报明确错误文案，不静默夹取。

模型拒绝兜底（D5 代价）：`mapProviderModelToPi` 拒绝某 `model_id` 时，该任务结果为明确错误文案（"模型 X 无法在子智能体引擎使用：原因"），**不静默降级**，主 AI 可见可换模型重试。

验收：mock 供应商下——single/parallel 两模式出摘要；并发上限生效且改设置后随之变化；父 signal 中止时全部子生成级联取消；默认面不含 bash（模型硬调则拒执文案）、含 edit/write 且**写落在父会话工作区边界内**（越界路径仍被宽严边界拒）；**两个子任务并发写同一文件不丢更新**（路径锁）；预算超限报错；三档 `permissionPreset` 下的弹卡行为逐档验证（confirm_each 每写必弹 / balanced 边界内 auto / full_access 不弹）；设置越界值被服务端拒；P0 的 scope 测试在 subagent 场景重放通过。

### P2：聊天引擎面等价

- `inference-engine/tool-loop.ts` 路径经 `executeToolCall` 分支自动获得执行能力，需补的只有：工具声明注入（聊天引擎各装配点经 `conversationFunctionTools` 已单源，P1 接入即同时生效）。
- 审批 scope：聊天引擎 pause-resume 不经等待者表（approval-gate.ts 头注），子生成走 pi 路径经 P0 scope，互不干扰。
- 验收：普通聊天（非工作区会话）里模型可派子智能体并拿到摘要；关闭设置后 tools 数组无声明、历史残留调用被拒执。

### P3：前端 + 导出收口

- 工具卡渲染（web-ui）：dispatch 卡显示模式/任务清单/运行状态；**进行中不铺子过程文本**（在时间线就地展示状态一行 + 已完成任务的摘要段，符合"变换结果就地展示、默认折叠"的既定交互约定）；子审批卡带「子任务 · 标题」前缀，用户能分清是谁在请求。
- 设置 UI：subagent 开关进现有工具/生成设置卡；高级项进**卡内折叠区**（advanced 标记，搜索可自动展开）——遵循「二级菜单=卡内折叠区」约定。折叠区内含：三个数值输入（并发 / 单次任务上限 / token 预算，带区间提示与服务端同校验）+ 子面工具多选（默认勾选含 edit/write、不含 bash；勾 bash 时行尾提示"路径串行保护失效"）。
- 安卓导出（P3-4，D7）：核实 `backup/export.ts` 对工作区工具 part 的既有处理——若已有剥离先例则 subagent 行同款；若无，把 subagent 工具行类型加进 `PC_ONLY_MESSAGE_PART_TYPES` 同机制处理；settings 侧 `subagent` 字段进 `stripPcOnly` 分支（先例：proxyConfig）。
- 验收：导出的安卓 zip 里无 subagent 设置字段、无残留工具行引用未知工具；PC 侧会话往返正常。

## 4. 风险与显式边界

1. **token/成本放大**：一次 dispatch 眼见一次工具调用，背后是 N 段独立生成。缓解：D4 预算 + 摘要回灌（子过程 token 不进父上下文）+ 默认关。
2. **并发子审批卡的 UX**：D2 放开写之后，`confirm_each` 工作区里并发 3 个子智能体可能各自挂一张 pending 卡，这是新体验。缓解：卡前缀「子任务 · 标题」+ 折叠区里可把并发调到 1（等价于串行子智能体）；`balanced` / `full_access` 工作区下边界内写本就 auto，不受影响。若实测仍吵，再谈"子审批并入主 AI 一次性批"聚合选项（不在本期）。
3. **并发写同文件**：路径互斥锁（D9）覆盖 edit/write；bash 不覆盖——所以 bash 默认不在子面，勾上时 UI 明写代价。主对话自身与子智能体之间**不共享锁**（父的工具批本就 sequential，同一轮不会父子同时写），如需更强保证可在 P2 复核。
4. **`model_id` 生效性**：社区 fork 在此翻过车（其 issue #28：参数形同虚设）。P1 验收单列一条：指定便宜模型的子任务，LLM 请求日志里必须看到该模型的出站请求。
5. **不做的事**：不做按会话挑选子智能体组合（社区 issue #120 的坑，v1 不接）；不做 >1 层嵌套（D3）；不做子智能体持久会话/续聊（每次 dispatch 即弃）；不做 OpenRouter server tools（上游明确拒绝的路线）。

## 5. 决策回执与仍需确认

**已定（2026-10-26 用户拍板）**

1. 子智能体**要能写文件** → D2 改为可配置面、默认含 edit/write（安全兜底从"只读"改成"继承工作区 `permissionPreset` + 边界壳 + 路径锁 D9"）。
2. 并发 / 单次任务上限 / token 预算**三项都要能自定义** → 默认 3 / 8 / 200k，区间 1–8 / 1–16 / 16k–2M，进卡内折叠区，前后端同校验。
3. 工具名与参数措辞**对齐社区 fork** → `subagent_dispatch` + `model_id`（D8，只对齐可确证的部分）。

**仍需你确认（我给了默认，不反对就按这个做）**

1. **chain 模式（ scout→planner→worker 式串联）要不要进 v1。** 我的建议：v1 只做 `single` + `parallel`，chain 推后。理由：chain 的收益主要在那套 `.md` agent 定义体系上，而我们不用它；只靠 `{previous}` 拼字符串，主 AI 自己在一次 dispatch 里排好任务顺序就够了。
2. **子面工具与三项预算是全局设置还是按助手覆盖。** 我的建议：v1 全局，跟 `enableWebSearch` 同层级；按助手 override 等真的出现"不同角色要不同子面"再加，否则设置卡会多一堆没人用的行。
3. **子任务失败时的呈现口径。** 我的建议：单任务失败不整批作废，摘要里逐段标「失败：原因」，让主 AI 决定要不要重派——这与聊天引擎"失败回灌模型可见"的现有心智一致。
