export interface ChatFadeTimelineOptions {
  readonly segmentDelayMs?: number;
  readonly maximumDelayMs?: number | null;
  readonly animationDurationMs?: number;
}

/**
 * Decorative motion cannot build an unbounded queue behind received text.
 * Absolute start times keep remounts from replaying a segment's original delay.
 */
export class ChatFadeTimeline {
  private readonly startAtMsByKey = new Map<string, number>();
  private readonly settledKeys = new Set<string>();
  private nextSegmentStartAtMs = 0;
  private readonly segmentDelayMs: number;
  private readonly maximumDelayMs: number | null;
  private readonly animationDurationMs: number;

  constructor(options: ChatFadeTimelineOptions = {}) {
    this.segmentDelayMs = options.segmentDelayMs ?? 16;
    this.maximumDelayMs = options.maximumDelayMs === undefined ? 96 : options.maximumDelayMs;
    this.animationDurationMs = options.animationDurationMs ?? 150;
  }

  delayFor(key: string, nowMs: number): number {
    const cached = this.cachedDelayFor(key, nowMs);
    if (cached !== null) return cached;
    const desiredStartAtMs = Math.max(this.nextSegmentStartAtMs, nowMs);
    const startAtMs = this.maximumDelayMs === null ? desiredStartAtMs
      : Math.min(desiredStartAtMs, nowMs + this.maximumDelayMs);
    const delayMs = Math.max(Math.round(startAtMs - nowMs), 0);
    this.startAtMsByKey.set(key, startAtMs);
    this.nextSegmentStartAtMs = startAtMs + this.segmentDelayMs;
    return delayMs;
  }

  cachedDelayFor(key: string, nowMs: number): number | null {
    const startAtMs = this.startAtMsByKey.get(key);
    return startAtMs === undefined ? null : Math.max(0, Math.round(startAtMs - nowMs));
  }

  settle(key: string): void {
    this.settledKeys.add(key);
  }

  isSettled(key: string, nowMs?: number): boolean {
    if (this.settledKeys.has(key)) return true;
    const startAtMs = this.startAtMsByKey.get(key);
    return nowMs !== undefined && startAtMs !== undefined
      && nowMs >= startAtMs + this.animationDurationMs;
  }
}
