export interface BotAvatarClockFrame {
  readonly now: number;
  readonly delta: number;
}

/** Logical per-actor time driven by the Stage scheduler. */
export class BotAvatarClock {
  private lastRawTime: number;
  private logicalTime = 0;
  private parked = false;

  constructor(rawTime = performance.now()) {
    this.lastRawTime = rawTime;
  }

  advance(rawTime: number): BotAvatarClockFrame {
    if (this.parked) return { now: this.logicalTime, delta: 0 };
    const delta = Math.min(
      0.05,
      Math.max(0, (rawTime - this.lastRawTime) / 1_000),
    );
    this.lastRawTime = rawTime;
    this.logicalTime += delta * 1_000;
    return { now: this.logicalTime, delta };
  }

  park(rawTime = performance.now()): void {
    if (this.parked) return;
    this.advance(rawTime);
    this.parked = true;
  }

  unpark(rawTime = performance.now()): void {
    if (!this.parked) return;
    this.parked = false;
    this.lastRawTime = rawTime;
  }

  snapshot(): number {
    return this.logicalTime;
  }
}
