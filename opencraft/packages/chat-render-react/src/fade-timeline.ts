export interface ChatFadeTimelineOptions {
  readonly segmentDelayMs?: number;
  readonly maximumDelayMs?: number | null;
}

/**
 * Renderer-neutral reconstruction of Codex's per-message fade scheduler.
 * Stable segment keys retain their first delay and settled segments never
 * animate again when React revisits the same document candidate.
 */
export class ChatFadeTimeline {
  private readonly delayMsByKey = new Map<string, number>();
  private readonly settledKeys = new Set<string>();
  private nextSegmentStartAtMs = 0;
  private readonly segmentDelayMs: number;
  private readonly maximumDelayMs: number | null;

  constructor(options: ChatFadeTimelineOptions = {}) {
    this.segmentDelayMs = options.segmentDelayMs ?? 16;
    this.maximumDelayMs = options.maximumDelayMs ?? 96;
  }

  delayFor(key: string, nowMs: number): number {
    const cached = this.delayMsByKey.get(key);
    if (cached !== undefined) return cached;
    const startAtMs = Math.max(this.nextSegmentStartAtMs, nowMs);
    const delayMs = Math.max(Math.round(startAtMs - nowMs), 0);
    this.delayMsByKey.set(key, delayMs);
    this.nextSegmentStartAtMs = startAtMs + this.nextStepMs(delayMs);
    return delayMs;
  }

  cachedDelayFor(key: string): number | null {
    return this.delayMsByKey.get(key) ?? null;
  }

  settle(key: string): void {
    this.settledKeys.add(key);
  }

  isSettled(key: string): boolean {
    return this.settledKeys.has(key);
  }

  private nextStepMs(delayMs: number): number {
    if (this.maximumDelayMs === null || delayMs < this.maximumDelayMs) return this.segmentDelayMs;
    return Math.max(1, this.segmentDelayMs * 0.25);
  }
}
