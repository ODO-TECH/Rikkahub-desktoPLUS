// 特性 C：记忆向量检索的「怎么用」设置切片（PC 独有）。
// 「用哪个模型」不在这里——嵌入 / 重排都是「设置 › 模型 › 场景模型」的全局场景档
// （model-config.ts 的 embeddingModelId / rerankModelId），本切片只管开关与召回参数。
export interface MemoryVectorSettings {
  /** 总开关。关闭时零网络请求，记忆注入行为与未引入本特性时逐字节一致。 */
  enabled: boolean;
  /** 新写入 / 编辑记忆后自动嵌入（防抖合并）。开启前 UI 会提示成本。 */
  autoIndex: boolean;
  /** 最终注入条数，夹在 5–50。 */
  topK: number;
  /** 可见记忆 ≤ 此值时直接全量注入，不发任何请求，夹在 0–200。 */
  minMemories: number;
  /** 记忆互近邻扩展（纯本地余弦计算，零额外请求）。 */
  expandNeighbors: boolean;
  /** 是否把候选交给全局重排场景档重排；未配置重排模型时此项无效。 */
  rerankEnabled: boolean;
  /** 送重排的候选数，夹在 10–100。 */
  rerankTopN: number;
}

export interface MemoryVectorConfig {
  memoryVectorSettings: MemoryVectorSettings;
}
