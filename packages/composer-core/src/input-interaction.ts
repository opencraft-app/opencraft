/** Ephemeral client input presentation. Never serialized into a draft or intent. */
export interface ComposerAudioLevels {
  subscribe(listener: (level: number) => void): () => void;
}
interface ComposerDictationInteractionBase {
  readonly kind: "dictation";
  readonly startedAt: number | null;
  readonly audioLevels: ComposerAudioLevels;
  /** True only after this input transaction has committed its final text. */
  finish(): Promise<boolean>;
  cancel(): void;
}
export type ComposerDictationInteraction = ComposerDictationInteractionBase & (
  | { readonly phase: "starting" | "listening" | "transcribing" }
  | { readonly phase: "failed"; readonly message: string; retry(): void }
);
