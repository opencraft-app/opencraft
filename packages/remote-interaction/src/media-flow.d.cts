import type { CreditWindow, FeedbackStage, MediaConfig } from './protocol.cjs';
export interface MediaFlowOptions {
  stage: FeedbackStage;
  epoch(): string;
  configure(config: MediaConfig): void;
  keyframe(): void;
  close(): void;
  pace?(fps: number): void;
  now?(): number;
}
export class MediaFlow {
  constructor(options: MediaFlowOptions);
  readonly credits: CreditWindow;
  readonly epoch: string;
  readonly ready: boolean;
  reset(): void;
  feedback(value: unknown): boolean;
  requestKey(): void;
  admit(packet: Uint8Array): boolean;
  tick(): void;
  dispose(): void;
}
