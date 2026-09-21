/** Ephemeral client input presentation. Never serialized into a draft or intent. */
export interface ComposerAudioLevels {
  subscribe(listener: (level: number) => void): () => void;
}
export interface ComposerDictationInteraction {
  readonly kind: "dictation";
  readonly phase: "starting" | "listening" | "transcribing";
  readonly startedAt: number | null;
  readonly audioLevels: ComposerAudioLevels;
  /** True only after this input transaction has committed its final text. */
  finish(): Promise<boolean>;
  cancel(): void;
}
