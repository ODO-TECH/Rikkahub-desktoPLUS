import type { JsonValue } from "..";

export interface ToolConfig {
  mcpServers: JsonValue[];
  modeInjections: JsonValue[];
  lorebooks: JsonValue[];
  quickMessages: JsonValue[];
}
