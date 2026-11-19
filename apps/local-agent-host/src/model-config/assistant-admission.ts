/** Ephemeral request admission for one installation's assistant model source.
 * Business jobs/recovery stay with their application owners. No credentials or payloads enter this owner. */
export type AssistantModelPurpose = "reception" | "context-summary" | "execution" | "memory-propose" | "memory-verify";
export const assistantModelPurposes: readonly AssistantModelPurpose[] = [
  "reception",
  "context-summary",
  "execution",
  "memory-propose",
  "memory-verify",
];
export const backgroundPurpose = (purpose: AssistantModelPurpose) =>
  purpose === "memory-propose" || purpose === "memory-verify";
export interface ModelWait {
  reason: "capacity" | "rate_limit";
  retryAt?: number;
}
export class ModelAdmissionDeferred extends Error {
  readonly status = 429;
  constructor(readonly retryAt: number) {
    super("Assistant model request deferred");
  }
}
export function retryAfterTime(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds < 0) return;
  const at = Number.isFinite(seconds) && seconds >= 0 ? now + Math.ceil(seconds * 1000) : Date.parse(value);
  return Number.isSafeInteger(at) && at >= 0 ? Math.max(now, at) : undefined;
}
interface Waiter {
  owner: string;
  purpose: AssistantModelPurpose;
  signal: AbortSignal;
  enqueued: number;
  observe(wait: ModelWait | null): void;
  grant(release: () => void): void;
  reject(error: unknown): void;
  abort(): void;
}
interface Resource {
  active: boolean;
  pending: Waiter[];
  notBefore: number;
  failures: number;
  lastOwner?: string;
  foregroundUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  highStreak: number;
}
export class AssistantModelAdmission {
  private readonly resources = new Map<string, Resource>();
  private closed = false;
  constructor(
    private readonly options: {
      now?: () => number;
      random?: () => number;
      idleGraceMs?: number;
      maxPending?: number;
      maxResources?: number;
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private resource(key: string) {
    let r = this.resources.get(key);
    if (!r) {
      if (this.resources.size >= (this.options.maxResources ?? 256)) {
        for (const [k, v] of this.resources)
          if (!v.active && !v.pending.length && v.notBefore <= this.now()) {
            clearTimeout(v.timer);
            this.resources.delete(k);
            break;
          }
        if (this.resources.size >= (this.options.maxResources ?? 256))
          throw Error("Assistant model capacity unavailable");
      }
      r = {
        active: false,
        pending: [],
        notBefore: 0,
        failures: 0,
        foregroundUntil: 0,
        highStreak: 0,
      };
      this.resources.set(key, r);
    }
    return r;
  }
  cooldown(key: string, header: string | null): number {
    const r = this.resource(key),
      now = this.now();
    const exponential = Math.min(30000, 2000 * 2 ** Math.min(r.failures++, 4));
    const delay = Math.round(exponential * (0.5 + (this.options.random ?? Math.random)() * 0.5));
    r.notBefore = Math.max(r.notBefore, retryAfterTime(header, now) ?? now + delay);
    for (const w of [...r.pending])
      if (backgroundPurpose(w.purpose)) {
        r.pending.splice(r.pending.indexOf(w), 1);
        w.signal.removeEventListener("abort", w.abort);
        w.observe(null);
        w.reject(new ModelAdmissionDeferred(r.notBefore));
      }
    this.pump(r);
    return r.notBefore;
  }
  success(key: string) {
    this.resource(key).failures = 0;
  }
  acquire(
    key: string,
    request: {
      owner: string;
      purpose: AssistantModelPurpose;
      signal: AbortSignal;
      deadlineAt?: number;
      observe: (wait: ModelWait | null) => void;
    },
  ): Promise<() => void> {
    request.signal.throwIfAborted();
    if (this.closed) return Promise.reject(Error("Assistant model source closed"));
    const r = this.resource(key),
      now = this.now();
    if (request.deadlineAt !== undefined && r.notBefore >= request.deadlineAt)
      return Promise.reject(new ModelAdmissionDeferred(r.notBefore));
    if (backgroundPurpose(request.purpose) && (r.notBefore > now || (r.foregroundUntil > now && !r.active)))
      return Promise.reject(new ModelAdmissionDeferred(Math.max(now + 2000, r.notBefore, r.foregroundUntil)));
    if (r.pending.length >= (this.options.maxPending ?? 64))
      return Promise.reject(new ModelAdmissionDeferred(Math.max(now + 2000, r.notBefore)));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        ...request,
        enqueued: now,
        grant: resolve,
        reject,
        abort: () => {
          const i = r.pending.indexOf(waiter);
          if (i >= 0) r.pending.splice(i, 1);
          request.signal.removeEventListener("abort", waiter.abort);
          request.observe(null);
          reject(request.signal.reason ?? Error("Assistant model request aborted"));
          this.pump(r);
        },
      };
      r.pending.push(waiter);
      request.signal.addEventListener("abort", waiter.abort, { once: true });
      if (request.signal.aborted) waiter.abort();
      else this.pump(r);
    });
  }
  private pump(r: Resource) {
    clearTimeout(r.timer);
    r.timer = undefined;
    if (this.closed) return;
    const now = this.now();
    for (const w of r.pending)
      w.observe(r.notBefore > now ? { reason: "rate_limit", retryAt: r.notBefore } : { reason: "capacity" });
    if (r.active || !r.pending.length) return;
    if (r.notBefore > now) {
      r.timer = setTimeout(() => this.pump(r), Math.min(2147483647, r.notBefore - now));
      return;
    }
    if (
      r.foregroundUntil > now &&
      r.pending.every((w) => backgroundPurpose(w.purpose)) &&
      !r.pending.some((w) => now - w.enqueued >= 10000)
    ) {
      r.timer = setTimeout(() => this.pump(r), r.foregroundUntil - now);
      return;
    }
    const rank = (w: Waiter) =>
      w.purpose === "reception" || w.purpose === "context-summary" ? 0 : w.purpose === "execution" ? 1 : 2;
    let candidates = r.pending.filter((w) => rank(w) === Math.min(...r.pending.map(rank)));
    const aged = r.pending.find((w) => now - w.enqueued >= 10000 && rank(w) > 0);
    if (r.highStreak >= 3 && aged) candidates = [aged];
    const w = candidates.find((w) => w.owner !== r.lastOwner) ?? candidates[0]!;
    r.pending.splice(r.pending.indexOf(w), 1);
    w.signal.removeEventListener("abort", w.abort);
    if (w.signal.aborted) {
      w.reject(w.signal.reason);
      this.pump(r);
      return;
    }
    r.active = true;
    r.lastOwner = w.owner;
    r.highStreak = rank(w) === 0 ? r.highStreak + 1 : 0;
    w.observe(null);
    let released = false;
    w.grant(() => {
      if (released) return;
      released = true;
      r.active = false;
      if (rank(w) === 0) r.foregroundUntil = this.now() + (this.options.idleGraceMs ?? 750);
      this.pump(r);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resources.values()) {
      clearTimeout(r.timer);
      for (const w of r.pending.splice(0)) {
        w.signal.removeEventListener("abort", w.abort);
        w.observe(null);
        w.reject(Error("Assistant model source closed"));
      }
    }
    this.resources.clear();
  }
}
