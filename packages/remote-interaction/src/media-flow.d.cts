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
  reset(): boolean;
  readonly bucket: 'fast' | 'slow';
  capacity(): boolean;
  switchBucket(bucket: 'fast' | 'slow'): boolean;
  snapshot(): { bucket: 'fast' | 'slow'; stage: FeedbackStage; ready: boolean; gap: boolean; window: number; pending: number; bytes: number; oldestMs: number; feedbackDelayMs: number | null; fps: number; requestedFps: number; sent: number; acknowledged: number; dropped: number; resets: number; pressure: boolean; recentProgress: boolean };
  feedback(value: unknown): boolean;
  requestKey(): void;
  admit(packet: Uint8Array): boolean;
  tick(): void;
  dispose(): void;
}
