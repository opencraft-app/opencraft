/** Client-device capability. Never routed through an Agent/AppServer Host. */
export interface NativeSpeechOptions { language?: string; deviceId?: string | null }
export interface NativeSpeechPreferences { deviceId: string | null; language: string | null }
export interface NativeSpeechInfo {
  supported: boolean; available: boolean; language: string; supportsOnDeviceRecognition: boolean;
  authorization: "notDetermined" | "authorized" | "denied" | "restricted";
  devices: readonly { id: string; name: string }[];
}
/** Identity comes from a real native recognition task, not a string heuristic. */
export interface NativeSpeechUtterance {
  utteranceId: string; sequence: number; phase: "partial" | "final"; text: string;
}
export type NativeSpeechEvent = { sessionId: string } & (
  | ({ type: "utterance" } & NativeSpeechUtterance)
  | { type: "level"; level: number }
  | { type: "status"; phase: "starting" | "listening" | "transcribing"; onDevice?: boolean }
  | { type: "end" }
  | { type: "error"; code: string; message: string }
);
export interface NativeSpeechPort {
  probe(language?: string): Promise<NativeSpeechInfo>;
  readPreferences(): Promise<NativeSpeechPreferences>;
  writePreferences(value: NativeSpeechPreferences): Promise<void>;
  start(sessionId: string, options: NativeSpeechOptions): Promise<void>;
  stop(sessionId: string): Promise<unknown>;
  cancel(sessionId: string): Promise<unknown>;
  onEvent(listener: (event: NativeSpeechEvent) => void): () => void;
}
