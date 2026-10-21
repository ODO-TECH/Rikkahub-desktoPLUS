import type { JsonValue } from "..";

export interface SearchConfig {
  enableWebSearch: boolean;
  searchServices: JsonValue[];
  searchCommonOptions: Record<string, JsonValue>;
  searchServiceSelected: number;
  /** R1-12:用户删除过的内置搜索服务 type 墓碑(小写)。state-load 的补齐/回填豁免它,
   *  且随 settings 进备份往返(恢复/跨机迁移不推翻删除意图)。手动重加该 type 时撤销。 */
  dismissedSearchServiceTypes: string[];
}
