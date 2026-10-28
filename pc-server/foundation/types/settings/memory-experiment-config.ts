// 实验功能：记忆与上下文的「失真 / 摘要 / 遗忘」设置切片（PC 独有）。
// 纪律：这里是**唯一**的实验开关来源。任何改变记忆注入、召回、压缩后置行为的代码
// 必须先经过 memory/experiment/gate.ts 的门控；总开关关闭时行为与原实现逐字节一致。
// 所有开关默认关闭，dryRun 默认开启——打开总开关的第一天只产生审计，不改数据。
export interface MemoryExperimentSettings {
  /** 总开关。关闭时本实验零副作用（不写审计、不解析、不调模型、不改注入）。 */
  enabled: boolean;
  /** 试运行：所有合并 / 失真 / 清除只写审计提案，不修改记忆内容与状态。 */
  dryRun: boolean;
  /** 结构化断言入口：允许通过 API / 工具写入带 kind + facets 的记忆候选。 */
  structuredIntake: boolean;
  /** 压缩后置候选：上下文摘要提交后，尽力从被压缩原文提取记忆候选（只进 pending）。 */
  compactionCandidates: boolean;
  /** 第一轮合并提案：按人物 / 事件 / 标签识别覆盖、完成、同类合并。 */
  mergeProposals: boolean;
  /** 用户提及计分：反复提及的记忆加分并获得保护；事件多次提及可晋升习惯。 */
  mentionScoring: boolean;
  /** 周期维护：按评分决定 7 / 14 天失真计划与 30 天延迟清除。 */
  maintenance: boolean;
  /** 状态感知召回：只召回 active；当前 / 历史意图走不同的时间路由。 */
  statusRecall: boolean;
  /** 易变召回块：按最新用户消息召回，追加在历史之后，不冻结、不破坏前缀缓存。 */
  dynamicRecall: boolean;
  /** 允许调用记忆场景模型做合并结论 / 失真摘要；关闭时只用确定性规则（零网络请求）。 */
  llmAssist: boolean;
  /** 安全自动执行：仅「完成即删」类无争议合并可在提议后自动执行（仍写审计）。
   *  dryRun=true 时本开关无效。 */
  autoApplySafe: boolean;
  /** 热记忆阈值：提及次数达到此值的记忆不进入第二轮失真。 */
  hotMentionThreshold: number;
  /** 低权重事件的失真周期（天）。 */
  eventDistillDays: number;
  /** 高权重习惯 / 高提及事件的失真周期（天）。 */
  habitDistillDays: number;
  /** 失真后保留原文的宽限期（天），0 = 不自动清除原文。 */
  purgeAfterDays: number;
  /** 单次压缩最多提取的记忆候选数。 */
  maxCandidatesPerCompaction: number;
  /** 易变召回块注入条数。 */
  dynamicRecallTopK: number;
}

export interface MemoryExperimentConfig {
  memoryExperimentSettings: MemoryExperimentSettings;
}
