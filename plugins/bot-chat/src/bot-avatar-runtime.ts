export type BotAvatarActivityLevel =
  "active" | "attentive" | "ambient" | "hidden";

export const BOT_AVATAR_ACTIVITY_RATE_HZ: Readonly<
  Record<BotAvatarActivityLevel, number>
> = Object.freeze({
  active: 60,
  attentive: 30,
  ambient: 8,
  hidden: 0,
});

export interface BotAvatarActivityInput {
  readonly visible: boolean;
  readonly working: boolean;
  readonly targeted: boolean;
}

export function botAvatarActivityLevel({
  visible,
  working,
  targeted,
}: BotAvatarActivityInput): BotAvatarActivityLevel {
  if (!visible) return "hidden";
  if (working) return "active";
  if (targeted) return "attentive";
  return "ambient";
}

export function botAvatarRateHz(
  level: BotAvatarActivityLevel,
  reducedMotion: boolean,
): number {
  return reducedMotion ? 0 : BOT_AVATAR_ACTIVITY_RATE_HZ[level];
}

export interface BotAvatarSchedulerHost {
  /** Same monotonic time origin as requestFrame. */
  getTime(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delayMs: number): number;
  clearTimer(id: number): void;
}

export interface BotAvatarFrameSubscription {
  setRateHz(rateHz: number): void;
  wake(): void;
  dispose(): void;
}

interface BotAvatarFrameSubscriber {
  readonly callback: (time: number) => void;
  lastDeliveredAt: number;
  rateHz: number;
  wakeOnce: boolean;
}

function browserSchedulerHost(): BotAvatarSchedulerHost {
  return {
    getTime: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (id) => window.clearTimeout(id),
  };
}

/**
 * One scheduler is owned by a mounted BotAvatarStage. Every live source
 * subscribes to it, so adding Bots never adds competing RAF loops.
 */
export class BotAvatarScheduler {
  private readonly host: BotAvatarSchedulerHost;
  private readonly subscribers = new Map<number, BotAvatarFrameSubscriber>();
  private disposed = false;
  private frameId: number | null = null;
  private nextSubscriberId = 0;
  private timerId: number | null = null;

  constructor(host: BotAvatarSchedulerHost = browserSchedulerHost()) {
    this.host = host;
  }

  subscribe(
    callback: (time: number) => void,
    initialRateHz: number,
  ): BotAvatarFrameSubscription {
    if (this.disposed) throw new Error("BotAvatarScheduler is disposed");
    const id = ++this.nextSubscriberId;
    const subscriber: BotAvatarFrameSubscriber = {
      callback,
      lastDeliveredAt: Number.NEGATIVE_INFINITY,
      rateHz: Math.max(0, initialRateHz),
      wakeOnce: false,
    };
    this.subscribers.set(id, subscriber);
    this.schedule();
    let active = true;
    return {
      setRateHz: (rateHz) => {
        if (!active || this.disposed) return;
        const nextRate = Math.max(0, rateHz);
        if (subscriber.rateHz === nextRate) return;
        subscriber.rateHz = nextRate;
        if (subscriber.rateHz === 0)
          subscriber.lastDeliveredAt = Number.NEGATIVE_INFINITY;
        this.reschedule();
      },
      wake: () => {
        if (!active || this.disposed) return;
        subscriber.wakeOnce = true;
        this.reschedule();
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(id);
        this.reschedule();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.cancelScheduledWork();
  }

  private cancelScheduledWork(): void {
    if (this.frameId !== null) this.host.cancelFrame(this.frameId);
    if (this.timerId !== null) this.host.clearTimer(this.timerId);
    this.frameId = null;
    this.timerId = null;
  }

  private reschedule(): void {
    this.cancelScheduledWork();
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.frameId !== null || this.timerId !== null) return;
    let highestRate = 0;
    for (const subscriber of this.subscribers.values()) {
      highestRate = Math.max(
        highestRate,
        subscriber.wakeOnce ? 60 : subscriber.rateHz,
      );
    }
    if (highestRate <= 0) return;
    if (highestRate >= 60) {
      this.frameId = this.host.requestFrame(this.deliver);
      return;
    }
    this.timerId = this.host.setTimer(() => {
      this.timerId = null;
      // Low-frequency presentation does not need a display-rate RAF merely
      // to reject every other frame. All sources still share this one clock.
      this.deliver(this.host.getTime(), highestRate);
    }, 1_000 / highestRate);
  }

  private readonly deliver = (time: number, timerRateHz = 0): void => {
    this.frameId = null;
    if (this.disposed) return;
    for (const subscriber of this.subscribers.values()) {
      if (!subscriber.wakeOnce && subscriber.rateHz <= 0) continue;
      const interval =
        subscriber.rateHz > 0
          ? 1_000 / subscriber.rateHz
          : Number.POSITIVE_INFINITY;
      // The timer already throttles its fastest subscribers. Testing elapsed
      // time again can halve 30Hz motion when browser delays round down to 33ms.
      if (
        !subscriber.wakeOnce && subscriber.rateHz !== timerRateHz &&
        time - subscriber.lastDeliveredAt + 0.01 < interval
      )
        continue;
      subscriber.wakeOnce = false;
      subscriber.lastDeliveredAt = time;
      subscriber.callback(time);
    }
    this.schedule();
  };
}
