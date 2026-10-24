export type FeedbackStage = 'received' | 'rendered';
export interface CreditOptions { maxItems: number; maxBytes: number; maxItemBytes?: number; }
export interface MediaConfig {
  type: 'media-config'; version: 1; epoch: string; stage: FeedbackStage;
  profile: 'h264-timestamp-v1'; maxFrameBytes: number;
}
export interface MediaFeedback {
  version: 1; epoch: string; received: string | null; rendered: string | null;
  ready?: boolean; requestReset?: boolean; fps?: number;
}
export function packetId(bytes: Uint8Array): string | null;
export function parseMediaConfig(value: unknown): MediaConfig | null;
export function parseMediaFeedback(value: unknown): MediaFeedback | null;
export class CreditWindow {
  constructor(options: CreditOptions);
  readonly size: number;
  readonly bytes: number;
  reserve(id: string, bytes: number, key?: boolean, now?: number): boolean;
  release(id: string): boolean;
  acknowledgeThrough(id: string): boolean;
  contains(id: string): boolean;
  index(id: string): number;
  oldestAge(now: number): number;
  retire(): void;
}
