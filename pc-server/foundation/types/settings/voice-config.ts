import type { AsrProvider, TtsProvider } from "..";

export interface VoiceConfig {
  asrProviders: AsrProvider[];
  selectedASRProviderId: string | null;
  ttsProviders: TtsProvider[];
  selectedTTSProviderId: string | null;
}
