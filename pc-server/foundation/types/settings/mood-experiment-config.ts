// 实验功能：心情状态（PC 独有）。每轮回复结束后异步判定一次情绪 delta，按助手累积。
// 纪律：本切片是唯一开关来源；所有判定必须先经 mood/gate.ts 门控。总开关关闭时
// 不判定、不调模型、不写库。dryRun 下照常判定与记账（会产生模型调用），但不注入。
// 注入模式只定措辞；「只记账不注入」由 dryRun 承担，不再单设 off。
export type MoodInjectMode = "label" | "event";

export interface MoodExperimentSettings {
  /** 总开关。关闭时零副作用。 */
  enabled: boolean;
  /** 试运行：只判定记账，不向提示词注入任何内容。 */
  dryRun: boolean;
  /** 判定模型。空串 = 跟随对话模型。 */
  moodModelId: string;
  /** 心情基线（衰减的回归目标）。 */
  moodBase: number;
  /** 心情下限。 */
  moodFloor: number;
  /** 心情回归基线的半衰期（小时）。 */
  decayHalfHours: number;
  /** 显著变化阈值：心情 |Δ| 达到此值才算「值得告诉她」。 */
  sigMood: number;
  /** 显著变化阈值：任一维度 |Δ| 达到此值同样算显著。 */
  sigDim: number;
  /** 注入置信度门槛，低于此值只记账。 */
  injectConfidence: number;
  /** 每日最多注入次数。 */
  injectPerDay: number;
  /** 注入模式：label 单行；event 三行（基调 / 缘由 / 反模仿句）。 */
  injectMode: MoodInjectMode;
}

export interface MoodExperimentConfig {
  moodExperimentSettings: MoodExperimentSettings;
}
