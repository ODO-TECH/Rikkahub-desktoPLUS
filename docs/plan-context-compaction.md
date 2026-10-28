# 聊天模式上下文压缩：计划与实施记录

- 版本：0.0.3 增补（跨版本基础设施）
- 范围：聊天引擎（普通对话）的上下文压缩，与工作区（pi）引擎的压缩语义对齐
- 状态：主链路已实施并通过测试（2026-10-25）；「记录可视化 + 摘要预算」（§12）与「自动压缩 + 钉住消息」（§13）均已落地（2026-10-26）。本文在实施完成后补齐，作为正式计划与落地记录。
- 前置决策：① 时间线原样保留，压缩处画分割线；② 以用户主动压缩为主，接近上限时在最后一条回复下方提示一行。

---

## 0. 结论先行

聊天模式的 `/compact` 从「删掉旧消息、只留摘要」改为「**保留原文 + 记一条切点记录 + 生成时按切点重放摘要**」。压缩记录与工作区 pi 共用同一结构（`conversation.engineCompactions`），「哪条记录生效」抽成引擎中性单源。前端并行识别两代分割线，并在上下文接近上限时给一行可点击的压缩提示。

三条不变量：

1. **原文只增不删。** 模型视野由切点决定，用户时间线、搜索索引、导出与备份仍能看到全部历史。
2. **只有最新一条有效记录生效。** 新摘要链式包含旧摘要，二次压缩只处理切点后的新增段，不会丢掉早期上下文。
3. **提示与服务端同口径。** 阈值 = 上下文窗口 − 16384（pi `reserveTokens` 默认），严格大于才提示；压缩完成后的旧 usage 由记录时间抑制，不误报。

---

## 1. 改造前与现在

| 维度 | 改造前（聊天引擎） | 改造后 | 工作区 pi（参照） |
| --- | --- | --- | --- |
| 历史存储 | 旧消息从 `conversation.messages` 移除 | 原文保留，新增压缩记录 | 原文保留 |
| 模型视野 | 摘要 + 保留的尾部 | 摘要 + 切点及之后 | 原生 compaction 重放 |
| 时间线 | 摘要行顶掉全部旧消息 | 原文 + 「以上对话已压缩为摘要」分割线 | 切点分割线 |
| 搜索 | 重建 FTS 后旧内容搜不到 | 全量可搜 | 全量可搜 |
| 二次压缩 | 只压当前剩下的消息（更早上下文已丢） | 只压切点后的新增段，摘要链式累积 | 同一记录语义 |
| token 估算 | 因消息被删而立即下降 | 按「摘要 + 切点后」估算 | pi 自算 |
| 失败 / 取消 | 整体作废，不改会话 | 同样作废，并保留既有审计防线 | pi 自管 |

旧实现的问题不止是信息损失：它与 pi 的切点语义分叉，同一个会话切到工作区后模型看到的边界完全不同；摘要替换还会让搜索、引用、导出永久丢失早期原文。

---

## 2. 目标与非目标

**目标**

1. 压缩不再删除任何消息；切点之前只由摘要替代，切点及之后逐字保留。
2. 压缩记录结构、有效记录判定与 pi 共用，聊天引擎不再维护自己的「删历史」语义。
3. 生成请求只包含「摘要 + 切点后原文」，切点前的原文不再进提示词。
4. 上下文用量估算遵守切点与摘要，压缩后数值确实下降。
5. 时间线能区分新旧两代压缩；接近上限时给出一条可操作的提示。
6. 旧会话、取消 / 并发写入、安卓导出等既有边界不回归。

**非目标**

- 不做聊天模式的自动压缩（本次仍是用户主动触发）。
- 不提供压缩记录的查看 / 编辑 / 删除界面。
- 不迁移旧 `compaction_boundary` 会话；旧标记继续按旧语义显示。
- 不向安卓导出压缩记录或切点注解。

---

## 3. 数据模型

### 3.1 压缩记录

```ts
interface EngineCompactionRecord {
  /** 切点：从这条消息（含）起保留原文，之前的历史被 summary 取代。 */
  cutMessageId: string;
  /** 被取代历史的摘要。第二次压缩起为链式文本（含更早的摘要）。 */
  summary: string;
  /** 压缩前的上下文估算（展示 / 诊断用，不参与判定）。 */
  tokensBefore: number;
  createdAt?: string;
}
```

存储位置是 `pc_conversation.engine_compactions`（JSON 数组），与 pi 共用。解析采用宽容策略：坏条目单独丢弃，不让整列作废。

### 3.2 有效记录判定

`findEffectiveCompaction(records, history, isUsable)` 的规则：

1. 切点必须仍在当前选中路径的历史里。
2. `isUsable` 由调用方补：pi 要求该消息能编出条目；聊天引擎只要求在场（恒真）。
3. 取**最新**一条满足条件的记录；都不满足时为 `null`，退回全量历史。

切点被编辑或删除时，陈旧记录自动跳过并回落到更早一条。更早的切点若仍有效，它的摘要继续生效，中间那段原文重新可见——这是唯一不丢信息的降级方向。

### 3.3 链式摘要

因为只有最新一条记录生效，第二次压缩必须把上一次摘要拼在新摘要前面：

```
第一次：summary = A
第二次：summary = A + "\n\n" + B   （B 只总结第一次切点之后的新增段）
```

不链式拼接就会在第二次压缩时把早期上下文整段丢掉；反过来，若不从上次切点开始切，就会把已被摘要吸收的原文再压一遍，摘要重复膨胀，成本也随会话总长度增长。

### 3.4 切点注解

`compaction_cut` 打在切点前一条消息上，前端把分割线画在该消息下方：

- 线上：用户仍可见的原文（模型已不再逐字看到）。
- 线下：切点及之后，模型逐字可见的范围。
- 同一会话只保留一条 `compaction_cut`；再次压缩会先清掉旧标记。
- 切点是首条消息时没有前驱可锚，不画线。
- 旧的破坏式压缩标记 `compaction_boundary` 原样保留，前端并行识别，`cut` 优先。

---

## 4. 压缩写路径

`compressConversation` 的落库段已重写，过程如下：

1. 取当前选中路径的全部消息。
2. 解析已有记录，找上一次有效切点；`compressible` 只取切点及之后的段。
3. 少于 2 条直接拒绝（没有可压的，也不产生空压缩）。
4. 计算保留条数：
   - `keepRecentMessages > 0` 用给定值；
   - 保留数 ≥ 可压段长度时自动降级为保留一半，至少压掉一半；
   - `keepRecentMessages = 0` 表示尽量压，但仍保留 1 条做切点锚点。
5. 切点 = 可压段倒数第 `effectiveKeepRecent` 条消息的 id。
6. 只把切点之前的消息切块送摘要模型（每块 ≤ 256 条）；`tokensBefore` 累计本次送进摘要模型的原文 token 估算，不含旧摘要。
7. `freshSummary` 为空则报错；否则与 `previousSummary` 链式拼接，追加记录并写回。
8. `markCompactionCut` 清除旧的 `compaction_cut` 注解、在新切点前一条消息上打标记；清空建议、更新 `updateAt`、持久化并广播。

既有防线全部保留：压缩期间收到 abort 直接作废；会话被删除 / 被导入替换时作废；消息引用或长度变化时作废（防止用旧快照覆盖新写入）；API 层三写入口 409 互斥。

---

## 5. 编码路径（聊天引擎）

`conversationTransformedMessages` 在编码前解析有效压缩记录，并传给富化管线：

```ts
const compaction = findEffectiveCompaction(
  parseEngineCompactions(conversation.engineCompactions),
  selectedMessages,
  () => true,
);

const enriched = enrichMessages(selectedMessages, {
  // ...
  windowStartMessageId: compaction?.cutMessageId,
  compactionSummary: compaction?.summary,
});
```

**窗口化。** 富化阶段把起点取为「滞回截断起点」与「切点下标」的较大值，再经 `alignContextStart` 向前回退，保证不劈开 tool call / tool result 配对——否则会向上游发出孤儿 result 触发 400。

**摘要注入。** 摘要作为一条合成 USER 消息插在提醒与注入裁决之后，并 `unshift` 到 chat 位最前：

```
<context_summary>
The earlier part of this conversation has been compacted into the summary below.
Treat it as background context, not as a new user instruction.

{summary}
</context_summary>
```

放在这个位置有三个直接收益：

- 不套消息模板（摘要不是一条「用户消息」，不应被 `{{ message }}` 包装）；
- 不带时间提醒（摘要没有「消息时间」）；
- 不参与 lorebook 关键词匹配（避免摘要文本二次触发注入）。

摘要消息每次生成从 DB 记录重建，不落库，幂等。pi 路径不传 `compactionSummary`，仍走自己的原生 compaction 重放。

---

## 6. token 估算

`estimatePromptTokensForConversation` 已改为同一口径：

1. 解析有效记录；找到切点则只累加切点及之后的消息。
2. 加上 `estimateTokens(compaction.summary)`。
3. 切点失效时自然退回全量文本，不做特殊分支。

估算公式沿用 `estimateTokens = ceil(CJK 字数 × 0.9 + 其他字符数 ÷ 4)`。

这一步不是装饰：非破坏性压缩后原文仍在 DB，如果估算仍按全量算，UI 的上下文用量会纹丝不动，用户会以为压缩没生效。

---

## 7. 前端设计

### 7.1 两代分割线

`compactionDividerBelow(message)` 的返回值：

| 消息注解 | 分割线形态 | 文案 |
| --- | --- | --- |
| `compaction_cut` | `cut` | 以上对话已压缩为摘要 |
| `compaction_boundary` | `boundary` | 旧压缩分割线文案 |
| 两者都有 | `cut`（记忆边界更贴近模型现状） | 同 `cut` |

文案与 `aria-label` 使用同一份 i18n 文本，避免视觉标签与读屏标签不一致。

### 7.2 接近上限提示

满足全部条件才显示：

- 普通对话（`workspaceId` 为空），工作区会话不显示；
- 时间线最后一条已加载节点的选中消息是 ASSISTANT 且带 `usage`；
- 最近一次压缩不是在这条消息之后发生的（`createdAt` 比较）；
- `used = promptTokens + completionTokens > 0`；
- 分母优先取当前模型的 live 上下文上限，缺失时回退消息生成时的 `usage.contextLimit`；
- `threshold = limit − 16384`，且 `threshold > 0`，`used` **严格大于** `threshold` 才显示（与 pi `shouldCompact` 同口径）。

显示形态是最后一条回复下方的一行琥珀色文字按钮：

> 上下文即将用完（已用 92%），点此压缩对话

点击打开现有的压缩对话框，不新增第二套压缩入口，也不自动执行。

**旧 usage 抑制。** 压缩完成到下一轮回复之间，最后一条消息的 usage 仍是压缩前的窗口量。若直接拿它判断，会出现「刚压完还催着压」。因此用最新记录的 `createdAt` 与消息 `createdAt` 比较：记录更新则视为旧口径，等下一次回复落地后按新 usage 重新裁决。

### 7.3 折叠区与摘要卡（2026-10-26 反馈）

上一版只有一条「以上对话已压缩为摘要」的分割线：压缩过的原文照旧铺在时间线上，摘要要点开弹窗才看得到。现在：

- **默认折叠。** 最新一条有效压缩记录的锚点（切点前一条）及其之前的节点全部渲染成 0 高；锚点那一行换成摘要卡。
- **摘要卡**展示：已压缩节点数、`压缩前 tokens → 摘要 tokens`、摘要前 4 行、`展开原文` / `详情`。点详情仍打开压缩记录弹窗，展开原文则就地恢复所有原始消息。
- **折叠是渲染层行为**：`selectedNodeMessages` 数组不裁剪，切分支、向上翻页、搜索定位仍按原下标工作。展开后卡片留在锚点下方，按钮变为「收起原文」。
- **例外**：分享选择（需要勾选全部消息）和搜索命中定位（`?msg=` 可能落在折叠区）期间强制展开；结束后回到用户自己的折叠选择。切会话或产生新压缩记录时重置为折叠。
- **翻页守卫**：折叠时列表顶部就是摘要卡，`startReached` 不再向上拉旧页（拉出来也会被折叠）。轮次条只列可见消息，点击/范围下标换算回完整数组。

摘要链也不再堆副本：`mergeCompactionSummary(previous, fresh)` 在相同或「一方完整包含另一方且长度 ≥ 16」时只保留一份，短句（如「A 方案通过」）不做包含去重，避免误判。旧 demo 记录是在此修复前落库的，仍保留当时的 1×/2×/3× 重复（mock 固定摘要 + 链式拼接），属于历史演示数据，不影响新压缩。

---

## 8. 跨端与备份边界

- `engine_compactions` 是 PC 自有列，不在安卓 `Conversation` schema 中，安卓导出只写 `ConversationEntity` 的安卓列，不会携带；安卓导入的会话没有记录，表现为「完整历史、未压缩」，这是安全方向。PC→PC 备份走独立的 `pc_conversations.db`，压缩记录会完整保留。
- `compaction_cut`（以及旧 `compaction_boundary`）是 PC-only 注解，已加入 `PC_ONLY_ANNOTATION_TYPES`，导出前过滤。
- `UIMessageAnnotation` 的类型注册与 `PC_MESSAGE_ANNOTATION_TYPES` 保持编译期双向断言；`android-contract.test.ts` 明确把 `compaction_cut` 归类为 PC-only，安卓多态解码不会遇到未知判别符。
- 旧会话的 `compaction_boundary` 不迁移；新压缩只产生 `compaction_cut`。

---

## 9. 变更清单

| 文件 | 变更 |
| --- | --- |
| `pc-server/inference-engine/engine-compaction.ts` | 新增：记录类型、宽容解析、有效切点判定单源、链式摘要复述去重 |
| `pc-server/conversations/auxiliary.ts` | 压缩改为写记录：链式摘要（经 `mergeCompactionSummary`）、切点计算、`compaction_cut` 标记；保留取消 / 并发 / 审计防线 |
| `pc-server/inference-engine/conversation-encoding.ts` | 聊天编码解析有效记录，传入切点锚与摘要 |
| `pc-server/inference-engine/message-enrichment.ts` | 切点窗口锚；`<context_summary>` 合成消息及位置约束 |
| `pc-server/conversations/helpers.ts` | token 估算按「摘要 + 切点后」计算 |
| `pc-server/foundation/types/dto.ts` | 新增 `CompactionCutAnnotation`，注册进 PC 注解类型表 |
| `pc-server/backup/export.ts` | 导出过滤 `compaction_cut` |
| `pc-server/backup/android-contract.test.ts` | 补 `compaction_cut` 的 PC-only 断言 |
| `pc-server/conversations/pi-route.test.ts` | 压缩用例改为非破坏式；新增编码体、链式压缩、`keepRecent=0` 用例 |
| `web-ui/app/lib/compaction.ts` | 两代分割线判定、阈值 / 百分比、压缩后旧 usage 抑制、最新记录折叠位置；手动压缩参数归一化（`normalizeCompressTargetTokens` / `normalizeCompressKeepRecent`） |
| `web-ui/app/components/message/compaction-divider.tsx` | `cut` / `boundary` 两套文案 |
| `web-ui/app/components/message/compaction-summary-card.tsx` | 时间线摘要卡：节点数、token 规模、摘要预览、展开 / 收起、详情入口 |
| `web-ui/app/components/message/compaction-detail-dialog.tsx` | 头部 / 底部固定、正文单滚动区；修复长摘要盖住说明与关闭按钮 |
| `web-ui/app/components/message/chat-message.tsx` | 导出 `useCurrentContextLimit`（模型上限单例缓存）；ContextGauge 改为点击弹层：用量 + 进度条 + 「压缩上下文」入口（§16 / §17） |
| `web-ui/app/components/icons/compress-context-icon.tsx` | 新增：压缩图标（圆角方框 + 中缝拉链），弹层与加号菜单共用（§17） |
| `web-ui/app/routes/conversations.tsx` | 时间线分割线、临界提示行、压缩区默认折叠 / 展开例外、轮次条与翻页下标换算；`onCompress` 传入消息组件 |
| `web-ui/app/components/input/chat-input.tsx` | 加号菜单「压缩对话历史」图标换为压缩图标；工具栏常驻按钮先加后撤（§16 加、§17 撤，入口移入上下文弹层） |
| `web-ui/app/locales/{zh-CN,en-US}/{page,message,settings}.json` | 新增分割线、提示与摘要卡文案；`message.json` 增加弹层与手动压缩文案 |
| `web-ui/app/locales/{zh-CN,en-US}/input.json` | 曾加工具栏按钮文案，§17 随入口迁移移除（键并回 `message.json`） |
| `web-ui/app/tests/compaction.test.ts` | 分割线、阈值边界、分母优先级、压缩后抑制、折叠位置回落；手动参数归一化 |
| `docs/plan-context-compaction.md` | 本文 |

---

## 10. 验收与测试

**功能验收**

1. 压缩一个聊天会话后，原文一条不少，切点前一条消息下方出现「以上对话已压缩为摘要」。
2. 下一轮请求体只包含摘要与切点后原文；切点前的内容不再出现。
3. 第二次压缩只处理新增段，最终摘要仍包含第一次的摘要；时间线只有一条 `compaction_cut`。
4. `keepRecentMessages = 0` 仍保留 1 条做切点；可压消息不足 2 条时明确报错。
5. 编辑 / 删除切点消息后，记录自动失效，退回更早记录或全量历史。
6. 压缩后上下文环数值下降；在下一轮回复前不出现「即将用完」的误报。
7. 接近上限时提示出现；点击打开现有压缩框；压缩完成后提示消失。
8. 旧 `compaction_boundary` 会话继续显示旧分割线，不受新逻辑影响。
9. 压缩中取消、压缩期间有新消息写入、会话被删除，三种情况均不改写会话。
10. 安卓导出 zip 中不含压缩记录，注解清洗不残留 `compaction_cut`。

**自动化结果（2026-10-25）**

| 项目 | 结果 |
| --- | --- |
| `pc-server` 全量测试 | 1663 pass / 8 skip / 3 fail |
| `web-ui` 全量测试 | 474 pass / 0 fail |
| 两端 typecheck | 0 error |
| 前端构建 + 17455 demo 重启 | 成功，`/api/health` 返回 `{"ok":true,"version":"0.0.6"}` |

pc-server 的 3 个失败是既有环境问题（APP zip 导入 e2e、两条宽边界写入用例），与本次改动无关，改动前即存在。新增的请求体断言会实际抓取上游请求，确认 `<context_summary>`、摘要文本与「第 3 / 4 轮」存在，「第 0 / 2 轮」不在提示词中。

---

## 11. 风险与后续

| 风险 | 现状与对策 |
| --- | --- |
| 估算偏差 | `estimateTokens` 是启发式，CJK 0.9、其他 ÷4，可能与供应商 tokenizer 有出入；提示阈值留了 16K 保留区，偏差不直接导致截断 |
| 摘要链式增长 | 已有预算护栏：链式摘要超过 `max(1024, targetTokens × 2)` 时做一次二次浓缩；模型不配合时保留原摘要，信息完整优先于严格达标（见 §12.2） |
| 提示依赖 usage | 没有 usage 的历史消息不会触发提示；服务端会补估算 usage，但第三方上游完全缺 usage 时仍可能不显示 |
| 切点与分支绑定 | 切点只在当前选中路径有效；切换分支、编辑或删除切点会安全降级，但分割线位置可能回退 |
| 手动压缩的局限 | 用户不点提示就不会压缩；若后续要对齐 pi 的自动行为，可复用 `shouldCompact` 与同一记录语义，不需要再改数据模型 |
| 旧会话未迁移 | `compaction_boundary` 会话仍按旧语义显示，早期原文已不可恢复；这是历史数据约束，不在本次范围内 |

**后续可做（两项已于 2026-10-26 落地，见 §13）**

1. 聊天模式自动压缩：按 `contextWindow − reserveTokens` 触发，复用本次的记录与编码路径。
2. 压缩后保留用户手动钉住的「关键消息」，避免被摘要吞掉细节。

---

## 12. 后续阶段落地（2026-10-26）

本轮把原「后续可做」的前两项落地：压缩记录可视化、摘要长度预算/二次浓缩。

### 12.1 压缩记录可视化

- **数据面**：`buildCompactionAnchors`（`web-ui/app/lib/compaction.ts`）把 `engineCompactions` 映射到分割线锚点。切点按节点成员查找（兼容切点落在非当前分支）；锚点取前一节点的当前选中消息；切点已删除或切点在首条的记录跳过；同一锚点多条记录以后者为准。
- **交互**：仅现行 `compaction_cut` 分割线可点，点开 `CompactionDetailDialog`；旧 `compaction_boundary` 保持不可点——旧压缩的原文已删除，没有可展示的记录，避免给出「还能查」的错误暗示。
- **详情内容**：本次压缩原文、当前摘要、摘要相对上一版的变化、净减少/净增加、切点消息预览、压缩时间、可复制的完整摘要，以及「切点前原文仍保留在本地会话与搜索索引中、只是不再发给模型」的说明。
- **无新接口**：详情卡只读前端已缓存的 `engineCompactions`，不做额外请求。

### 12.2 摘要长度预算

- **预算**：`compactionSummaryBudget(targetTokens) = max(1024, floor(targetTokens × 2))`。默认目标 2000 → 预算 4000；连续压缩到第三份摘要时触发二次浓缩。
- **二次浓缩**：使用独立提示词 `DEFAULT_CONDENSE_SUMMARY_PROMPT`，输入是链式摘要本身（不是会话原文），目标仍是 `targetTokens`；只有结果确实更短才替换。
- **失败语义**：取消向上抛 `AbortError`，不落库；其他失败保留链式摘要并照常完成主压缩（可能超预算，但信息完整）。只做一遍，不无限追打。
- **落库闸门**：取消 / 会话被替换 / 消息变更三项检查移到二次浓缩之后统一复检，覆盖第二个 LLM 调用窗口。
- **状态条**：二次浓缩不带 `progress`（否则进度会从 100% 倒退），显示「正在压缩上下文」并继续计时。

### 12.3 验证

| 项目 | 结果 |
| --- | --- |
| `web-ui/app/tests/compaction.test.ts` | 13 pass（新增解析 / 锚点 / token 估算 5 例） |
| `web-ui` 全量单元测试 | 479 pass / 0 fail |
| `pc-server/conversations/pi-route.test.ts` | 21 pass（新增二次浓缩成功 / 失败 2 例） |
| `pc-server` 相关测试（auxiliary + inference-engine） | 200 pass / 0 fail |
| 两端 typecheck | 0 error |
| 前端构建 + 17455 demo 重启 | 成功，`/api/health` 返回 `{"ok":true,"version":"0.0.6"}` |

未做详情卡的截图回归：demo 数据里没有带压缩记录的会话，卡片由纯函数测试、类型检查与构建覆盖；要看到实际效果需在 demo 里真实压缩一次对话。

---

## 13. 自动压缩与钉住消息（阶段三 / 四，2026-10-26）

原 §11「后续可做」两项已落地。自动路径与手动路径共用同一条压缩记录、同一套落库闸门，不产生第二种数据形态。

### 13.1 阶段三：聊天模式自动压缩

- **入口与边界**：`generateAnswer` 在 `ensureAssistantGenerationNode` 之前调用 `maybeAutoCompactChat`（`pc-server/conversations/auto-compaction.ts`），只对 `adapter.kind === "chat"` 生效；pi 工作区继续用引擎原生 threshold / overflow 压缩，不重复触发。调用点在空白助手占位创建之前，本轮问题不会进摘要输入。
- **默认关闭**：`settings.chatAutoCompact` 默认 false。压缩会真实调用压缩模型（可能产生费用），不默认替用户花这次调用；开关在「设置 → 模型 → 压缩模型」卡片下方的「自动压缩」。
- **阈值**：`contextWindowFor(modelsDevCache, provider, model.modelId) − 16384`，严格大于才触发；窗口未知、非有限或 ≤ 16384 一律不触发（不知道上限就不猜）。与前端「即将用完」提示条、pi `shouldCompact` 同口径。
- **估算**：优先取切点之后最后一条带真实 usage 的助手消息（prompt + completion + 其后消息）；该 usage 必须晚于当前压缩记录，避免刚压完拿压缩前的窗口数误触发第二次。没有可用 usage 时先 `prepareMemoryRecall`，再把 system、摘要、注入、工具往返完整编码后计数，与正式生成同一时机。
- **保留范围**：最近 25%，下限 4 条、上限 32 条，目标摘要 2000 tokens。压掉约 3/4，避免「压完仍超阈值」每轮重复付费。
- **结果与失败**：成功则照常继续本轮生成；压缩模型失败只记一条 warn 并沿用原上下文（不顶掉用户刚发的消息），取消 / 会话接管立即退出。压缩期间置 `compressing` 并广播 `engine-status`（`reason: "threshold"`），与手动压缩共用状态条。
- **与钉住配合**：若切点前的可摘要段全被钉住，自动路径静默跳过，不每轮弹一条失败警告。

### 13.2 阶段四：钉住关键消息

- **数据形态**：消息 `annotations` 中的 `{ type: "pinned" }`。这是 PC 独有能力，安卓导出时由 `PC_ONLY_ANNOTATION_TYPES` 剥离；老消息行没有 `annotations` 列或为 null 时按「未钉住」处理，不崩。
- **交互**：消息右上角「⋯」→「钉住 / 取消钉住」；钉住后气泡下方常驻 `已钉住` 胶囊（Pin 图标，悬停说明用途）。接口 `POST /api/conversations/:id/messages/:mid/pin`，幂等；压缩在途返回 409 `compress_in_progress`，避免摘要输入与钉住集错位。
- **摘要侧**：压缩时切点前的钉住消息从摘要输入中剔除；若切点前全部被钉住，明确报错「没有可摘要的内容」。因此链式摘要不会把钉住原文吞成缩写。
- **模型侧**：编码时取切点之前的钉住消息，拼进同一条合成 USER 摘要行的 `<pinned_messages>` 块（role 小写、原文不转义）；切点之后的钉住消息本来就在窗口里逐字可见，不重复注入。与摘要同一行是为了不改变上游对相邻 user 消息的轮次裁决；摘要不变时前缀逐字节稳定，缓存友好。
- **估算一致**：`helpers.ts` 的上下文估算计入钉住块，保证「前端提示数 ≈ 实际发给模型的视野」。

### 13.3 改动文件

| 文件 | 变更 |
| --- | --- |
| `pc-server/inference-engine/engine-compaction.ts` | 阈值 / 自动判定 / `isPinnedMessage` / `pinnedMessagesBefore`（引擎中性单源） |
| `pc-server/conversations/auto-compaction.ts` | 新增：发送前预检、usage 新鲜度、保留条数、best-effort 失败语义 |
| `pc-server/conversations/orchestrator.ts` | 生成前接入自动压缩；仅 chat 引擎 |
| `pc-server/conversations/auxiliary.ts` | 摘要输入剔除钉住消息；全钉住时报错；自动原因透传状态 |
| `pc-server/inference-engine/conversation-encoding.ts` | 提取切点前的钉住消息交给富化层 |
| `pc-server/inference-engine/message-enrichment.ts` | `<pinned_messages>` 注入块与说明外框 |
| `pc-server/conversations/helpers.ts` | 上下文估算计入钉住块 |
| `pc-server/api/handlers/conversations.ts` | `messages/:id/pin` 路由、幂等、压缩互斥 409 |
| `pc-server/backup/export.ts` | 安卓导出剥离 `pinned` 注解 |
| `web-ui/app/components/message/chat-message.tsx` | 「⋯」菜单钉住 / 取消钉住 |
| `web-ui/app/components/message/chat-message-annotations.tsx` | 常驻 `已钉住` 胶囊 |
| `web-ui/app/routes/conversations.tsx` | 钉住请求与节点帧刷新 |
| `web-ui/app/components/settings/default-models.tsx` | 「自动压缩」开关（默认关） |
| `web-ui/app/components/message/compaction-detail-dialog.tsx` | 修正切点消息角色标签（大写枚举比较） |
| `web-ui/app/locales/{zh-CN,en-US}/{page,message,settings}.json` | 钉住、自动压缩文案 |
| `pc-server/inference-engine/engine-compaction-threshold.test.ts` | 新增：阈值边界、窗口未知、钉住判定 |
| `pc-server/conversations/pi-route.test.ts` | 自动压缩启用 / 默认关 / 失败兜底；钉住注入；pin 接口 |
| `pc-server/inference-engine/message-enrichment.test.ts` | `<pinned_messages>` 形状与原文不转义 |
| `pc-server/backup/android-contract.test.ts` | 导出剥离 `pinned` |

### 13.4 验证

**自动化（2026-10-26）**

| 项目 | 结果 |
| --- | --- |
| `pc-server` 全量测试 | 1679 pass / 8 skip / 3 fail（既有 Windows 环境失败：APP zip e2e EBUSY + 两条宽边界写入需管理员，与本次无关） |
| 阶段三 / 四定向（pi-route + threshold + enrichment + android-contract） | 77 pass / 0 fail |
| `web-ui` 全量单元测试 | 479 pass / 0 fail |
| 两端 typecheck | 0 error |
| 前端构建 + 17455 demo 重启 | 成功，`/api/health` 返回 `{"ok":true,"version":"0.0.6"}` |

**Demo 实测（零出网、零计费）**

- 独立数据目录 `demo-profiles/userdata-compaction`；假供应商绑定回环别名 `127.0.0.2:18124`，按 prompt 识别「摘要请求 / 聊天请求」，不访问任何外网。
- 会话 12 轮、23,009 字符，估算 17,106 tokens > 阈值 16,384；第 2 轮消息钉住。
- 发送一条新问题后：先发出摘要请求（prompt 12,565 tokens，含第 1 轮、不含钉住原文与本轮问题）；随后生成请求只有 6 条消息（prompt 5,082 tokens），含 `<context_summary>`、`<pinned_messages>`、钉住原文与本轮问题，不含第 1 / 9 轮。
- 会话仍为 14 个节点（原文一条不少），只有一条压缩记录（切点 `demo-msg-10`，`tokensBefore` 12,389）；重启后端后记录与钉住胶囊都还在。
- 截图：`demo-profiles/c-01-bottom.png`（压缩后的回答与 5,082 tokens）、`c-02-divider.png`（分割线）、`c-03-pinned.png`（第 2 轮 `已钉住` 胶囊）、`c-04-detail.png`（压缩详情卡，切点角色显示「用户」）。

### 13.5 边界与风险

| 风险 | 现状与对策 |
| --- | --- |
| 自动压缩产生模型费用 | 默认关闭，设置页明确提示「会调用上面的压缩模型」；demo 用本地 mock 验证，不产生费用 |
| 估算偏差导致误触发 / 漏触发 | usage 优先，且校验 usage 晚于压缩记录；无 usage 时完整编码；16K 保留区吸收 tokenizer 偏差 |
| 自动压缩失败 | best-effort：只记 warn，本轮按原上下文继续；上游超限时仍会自行报错，手动入口一直在 |
| 钉住块体积线性增长 | 注入全文，不截断；界面用胶囊提示已有钉住，用户可随时取消；安卓导出剥离，旧客户端不受影响 |
| 钉住集与摘要错位 | pin 接口在压缩期间返回 409；摘要输入在压缩开始时一次切好，结束后统一复检再落库 |
| 切点后的钉住消息 | 不注入、不额外处理——它们本来就在逐字窗口内，避免重复内容 |

---

## 14. 演示如何复现

`demo-profiles/tools/` 下有一套零出网演示（仅供验收，不属于产品代码）：

1. 启动假供应商：`bun demo-profiles/tools/mock-compaction-provider.ts`（127.0.0.2:18124）。
2. 灌数据（先停 demo，避免 SQLite 双写）：`RIKKAHUB_PC_DATA_DIR=demo-profiles/userdata-compaction bun demo-profiles/tools/seed-compaction-demo.ts`（脚本会拒绝写入非 `userdata-compaction` 目录）。
3. 启动：`DEMO_DATA_DIR="$PWD/demo-profiles/userdata-compaction" bash demo-profiles/tools/demo-server.sh run --build`。
4. 打开 `http://127.0.0.1:17455/c/demo-compaction-20261026`，直接发送任意消息：自动压缩先跑，随后模型只看到摘要 + 钉住消息 + 切点后原文。

验收时可查 `http://127.0.0.2:18124/__state` 核对两次请求体；全程不触达真实供应商。若要重置演示：停 demo → 重新运行 seed（重建会话与压缩记录）→ 再启动。

---

## 15. 折叠摘要卡与详情卡修复（2026-10-26 用户反馈）

**反馈**：压缩对话没有折叠，压缩成果只能在弹窗里看；详情弹窗的长摘要会盖住「保留说明」和关闭按钮。

**时间线（`routes/conversations.tsx` + `components/message/compaction-summary-card.tsx`）**

- `latestCompactionPlacement` 在 `lib/compaction.ts` 里选出最新有效记录及折叠范围；最新记录失效时回落到更早一条（与模型视野的降级方向一致）。
- 折叠时 `localIndex < anchorNodeIndex` 的节点渲染为 0 高；锚点行渲染摘要卡。数组不裁剪，切分支 / 翻页 / 搜索 / 编辑全部照旧。
- 摘要卡显示压缩节点数、`tokensBefore → summaryTokens`、摘要前 4 行、展开 / 收起与详情入口。默认折叠，切会话或产生新记录时重置。
- 分享选择与 `?msg=` 搜索定位期间强制展开；`startReached` 在折叠时不再拉旧页；轮次条按可见切片换算下标。
- 文案：`conversations.compaction_card.{title,size,expand,collapse,note,detail}`（zh-CN / en-US）。
- 新增测试：`latestCompactionPlacement` 取最后一条有效记录、失效回落、空数据返回 null（`web-ui/app/tests/compaction.test.ts`）。

**详情弹窗（`components/message/compaction-detail-dialog.tsx`）**

- 根因：Radix `ScrollArea` 的 Root 是 `overflow: visible`，viewport 随内容撑高，外层 `max-h` 只裁外框不裁内容，长摘要画到说明与按钮上。
- 修法：`DialogContent` 改为 `flex flex-col`，头部与底部固定，中间单独 `overflow-y-auto`；摘要不再嵌套第二层滚动。`ScrollArea` 引用移除。
- 实测（CDP）：滚动区 `scrollHeight 875 / clientHeight 596`，滚到底部时保留说明与关闭按钮完整可见（`c-13-detail-final.png`、`c-14-detail-scrolled-bottom.png`）。

**摘要链去重（`engine-compaction.ts` / `auxiliary.ts`）**

- `mergeCompactionSummary`：相同摘要只留一份；一方的长文本完整包含另一方（被包含方 ≥ 16 字符）时用较长者；短句不做包含判断。
- 旧 demo 三条记录在修复前落库（mock 固定摘要 × 链式拼接），仍保留 1×/2×/3× 副本；只影响这份演示数据，新压缩不再累积。

---

## 16. 阈值前手动压缩与自定义保留条数（2026-10-26 用户反馈）

**反馈**：用户要能手动决定在阈值之前压缩上下文；「保留最近消息」要能自定义，不能只选 `0 / 16 / 32 / 64`。

**能力确认**：后端手动压缩本来就没有阈值闸门（只有「可压消息 ≥ 2 条」与「切点前至少有一条非钉住消息」两道必要防线），自动阈值只约束 `maybeAutoCompactChat`。缺的是入口可发现性与参数自由度，因此本轮只改前端与文案，没动压缩数据模型与后端接口。

**手动入口（`components/input/chat-input.tsx`）**

- ~~加号菜单旁新增常驻剪刀按钮~~ → 本轮加的常驻按钮在下一轮反馈中撤销，入口移入上下文弹层（见 §17）；加号菜单里的「压缩对话历史」保留为第二入口。
- 压缩对话框顶部新增手动说明：手动压缩随时可执行，自动压缩只在阈值处兜底；压缩后原文仍保留，可展开查看。

**自定义保留条数（`routes/conversations.tsx`）**

- 「保留最近消息」由纯预设切换改为数字输入 + 预设快捷键。输入值按字符串保存，失焦 / 提交时才归一化，避免输入过程中被逐键夹紧。
- 归一化单源在 `lib/compaction.ts`，可在单测中覆盖：
  - 目标 tokens：非法 / 空回落默认 2000，最小 256，小数截断。
  - 保留条数：非法 / 空回落 32，负数归 0，小数截断；`0` 合法，表示尽量压缩（后端仍保留 1 条做切点锚点；若大于等于可压条数，后端自动降级为一半）。
- 预设按钮的高亮改为比较归一化后的值：输入 `4` 时四个预设都不高亮，避免「显示 32 选中、实际按 4 执行」的错觉。

**测试**

| 项目 | 结果 |
| --- | --- |
| `web-ui/app/tests/compaction.test.ts` | 17 pass / 0 fail（新增参数归一化 2 组，覆盖空值、非法值、下限、负数、小数、自定义回落） |
| `web-ui` typecheck | 0 error |
| `web-ui` 构建 | 成功，已同步到 `dist/web-ui/build/client` |
| demo（17455，本地 mock） | 阈值前手动压缩成功：6 节点会话约 294 tokens，保留 4 条，记录切在节点 2 的用户消息；时间线显示「已压缩 2 条更早的消息」，快速跳转 4/4 → 1/4 |

**Demo 证据**

- `demo-profiles/tools/c-26-compress-dialog-final.png`：对话框中的手动说明、目标 tokens 输入、保留条数数字输入与提示。
- `demo-profiles/tools/c-24-small-repaired.png` / `c-25-small-repaired-top.png`：阈值前压缩后的会话（远低于 16,384 阈值），摘要卡与保留 4 条的原文。
- 演示会话 `demo-compress-small-20261026` 与 `userdata-compaction` 数据目录保留，便于回归；未删除。

---

## 17. 压缩图标与入口位置调整（2026-10-26 用户反馈·第二轮）

**反馈**：剪刀图标太丑，要求换成参考图那种「一眼读出压缩」的图标（圆角方框 + 中缝拉链）；压缩入口不要放工具栏，收进上下文预览。

**新图标（`components/icons/compress-context-icon.tsx`）**

- 纯描边 SVG，圆角方框 + 中缝斜齿交错（拉链），`currentColor` 随主题。
- 几何取舍：参考图的拉链齿细密，照抄在 14–16px 会糊成横条（读成 E / 列表）；齿数减到 4 段、振幅 ±2.4 单位、线宽 1.6，16px 与 20px 下都能看出斜齿交错（与参考图振幅 / 框宽比例一致，约 0.3）。

**入口移入上下文预览（`components/message/chat-message.tsx`）**

- ContextGauge 由悬停 Tooltip 改为点击 Popover：上下文窗口标题、已用百分比、进度条、token 数，以及分隔线下的「压缩上下文」动作 + 说明「可随时手动压缩，不必等上下文接近上限」。
- `onCompress` 从时间线 `handleCompressConversation` 经 ChatMessage → NerdLineRow 传入 ContextGauge；挂在每条 assistant 消息的圆环上，会话末尾是用户消息时入口也不丢。
- `chat-input.tsx` 撤掉上一轮的常驻剪刀按钮；加号菜单「压缩对话历史」保留为第二入口，图标换为新压缩图标。
- i18n：`context_window_*`、`open_context_menu`、`compress_context`、`compress_context_hint` 落在 `locales/*/message.json`（chat_message 节）；上一轮加在 `input.json` 的键已移除。

**测试与验收**

| 项目 | 结果 |
| --- | --- |
| `web-ui` typecheck | 0 error |
| `web-ui/app/tests/compaction.test.ts` | 17 pass / 0 fail |
| `web-ui` 构建 | 成功，已同步到 `dist/web-ui/build/client` |
| demo（17455，本地 mock） | 圆环点击弹出弹层，用量 16%（5.2k / 32.8k）+ 进度条 + 压缩入口齐全；工具栏无剪刀；加号菜单图标已换 |

**Demo 证据（`demo-profiles/tools/shot-out/`）**

- `d-25-popover.png` / `d-26-popover-zoom.png`：上下文弹层全貌与放大（用量 + 进度条 + 压缩上下文 + 提示）。
- `d-28-icon-native-zoom.png`：16px 原生像素下的拉链齿形。
- `d-31-plus-menu.png` / `d-32-menu-item-zoom.png`：加号菜单「压缩对话历史」新图标。
- `d-27-toolbar-zoom.png`：工具栏已无压缩按钮。

**过程备注**：验收期间 `userdata-compaction` 数据目录曾意外清空（`rikka_hub.db` 0 会话、`state.json` 丢演示助手；`freelist_count=195` 表明行被删除而非损坏，后端无对应自动清除路径，根因未查明）。已用 `seed-compaction-demo.ts`（服务器停止时）重灌供应商 / 助手 / 12 轮会话，并补发一轮 mock 对话恢复验收环境；`state.json` 留有 `before-assistant-repair` / `before-second-repair` 两份备份。
