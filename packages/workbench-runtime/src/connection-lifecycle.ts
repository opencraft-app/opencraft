import type { RecoveryClock } from "./recovery-policy";

export type ConnectionPhase = "idle" | "attempting" | "usable" | "backoff" | "blocked" | "disposed";
export interface ConnectionState<T> {
  readonly phase: ConnectionPhase;
  readonly binding: T | null;
  readonly error: Error | null;
  readonly recovering: boolean;
}
export interface ConnectionAttempt {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
interface Attempt {
  controller: AbortController;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer: unknown;
}
const delays = [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** One writer for connection admission, revocation, readiness and retry timers.
 * Resource owners retain their own demand, data and source identities. */
export class ConnectionLifecycleOwner<T> {
  private state: ConnectionState<T> = { phase: "idle", binding: null, error: null, recovering: false };
  private attempt: Attempt | null = null;
  private retryTimer: unknown = null;
  private retryTicket = 0;
  private stableTimer: unknown = null;
  private stableTicket = 0;
  private failures = 0;
  private lastHintAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly input: {
    clock: RecoveryClock;
    run(attempt: ConnectionAttempt): Promise<T>;
    valid(binding: T): boolean;
    invalidate(): void;
    changed(): void;
    usable(binding: T): void;
    backoff(attempt: number, delayMs: number): void;
    manual(error: unknown): boolean;
    autoReconnect?: boolean;
    delaysMs?: readonly number[];
    /** Default backoff spreads reconnect storms; explicit schedules stay exact. */
    jitter?: boolean;
    random?: () => number;
    stableMs?: number;
    timeoutMs?: number;
  }) {}
  get snapshot(): ConnectionState<T> { return this.state; }
  get pending(): boolean { return this.attempt !== null; }
  get reconnectAttempt(): number { return this.failures; }
  private now() { return this.input.clock.now?.() ?? Date.now(); }
  private cancelRetry() {
    ++this.retryTicket;
    if (this.retryTimer !== null) this.input.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
  private cancelStability() {
    ++this.stableTicket;
    if (this.stableTimer !== null) this.input.clock.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
  private retire(error: Error): boolean {
    const previous = this.attempt;
    this.attempt = null;
    if (previous) {
      this.input.clock.clearTimeout(previous.timer);
      previous.reject(error);
      previous.controller.abort(error);
    }
    return previous !== null;
  }
  connect(force = false): Promise<void> {
    if (this.state.phase === "disposed") return Promise.reject(new Error("Connection owner is disposed"));
    if (this.attempt) return this.attempt.promise;
    if (!force && this.state.phase === "usable" && this.state.binding !== null && this.input.valid(this.state.binding)) {
      return Promise.resolve();
    }
    const recovering = force || this.state.phase !== "idle";
    const invalidate = this.state.binding !== null;
    this.cancelRetry();
    this.cancelStability();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // Internal triggers and observer reentry may not retain the returned promise.
    void promise.catch(() => undefined);
    const attempt: Attempt = { controller: new AbortController(), promise, resolve, reject, timer: null };
    this.attempt = attempt;
    this.state = { phase: "attempting", binding: null, error: null, recovering };
    const current = () => this.attempt === attempt && !attempt.controller.signal.aborted;
    const assertCurrent = () => {
      if (!current()) throw attempt.controller.signal.reason ?? new Error("Connection attempt was superseded");
    };
    attempt.timer = this.input.clock.setTimeout(() => {
      if (current()) this.lost(new Error("Connection attempt timed out"));
    }, this.input.timeoutMs ?? 60_000);
    // Ownership and deadline precede all observers and external I/O.
    if (invalidate) this.input.invalidate();
    this.input.changed();
    void Promise.resolve().then(async () => {
      assertCurrent();
      const binding = await this.input.run({ signal: attempt.controller.signal, assertCurrent });
      assertCurrent();
      if (!this.input.valid(binding)) throw new Error("Connection was lost before readiness commit");
      this.input.clock.clearTimeout(attempt.timer);
      this.attempt = null;
      this.state = { phase: "usable", binding, error: null, recovering };
      const ticket = ++this.stableTicket;
      if (this.input.autoReconnect !== false) this.stableTimer = this.input.clock.setTimeout(() => {
        if (ticket !== this.stableTicket || this.state.binding !== binding || this.state.phase !== "usable") return;
        this.stableTimer = null;
        if (this.input.valid(binding)) this.failures = 0;
      }, this.input.stableMs ?? 60_000);
      attempt.resolve();
      this.input.changed();
      if (this.state.phase === "usable" && this.state.binding === binding && this.input.valid(binding)) this.input.usable(binding);
    }).catch(cause => {
      if (current()) this.lost(cause, this.input.manual(cause));
    });
    return promise;
  }
  lost(cause: unknown, manual = false): void {
    if (this.state.phase === "disposed") return;
    // Later ordinary close events cannot downgrade an explicit manual block.
    if (this.state.phase === "blocked") return;
    if (this.state.phase === "backoff" && !manual) return;
    const error = cause instanceof Error ? cause : new Error("Connection is unavailable");
    this.cancelRetry();
    this.cancelStability();
    const blocked = manual || this.input.autoReconnect === false;
    this.state = { phase: blocked ? "blocked" : "backoff", binding: null, error, recovering: true };
    this.retire(error);
    let delayMs = 0;
    if (!blocked) {
      const schedule = this.input.delaysMs;
      const base = (schedule ?? delays)[Math.min(this.failures++, (schedule ?? delays).length - 1)] ?? 60_000;
      delayMs = this.jitteredDelay(base, schedule === undefined);
      const ticket = ++this.retryTicket;
      this.retryTimer = this.input.clock.setTimeout(() => {
        if (ticket !== this.retryTicket || this.state.phase !== "backoff") return;
        this.retryTimer = null;
        void this.connect(true).catch(() => undefined);
      }, delayMs);
    }
    // Child revocation is synchronous, before any public readiness notification.
    this.input.invalidate();
    this.input.changed();
    if (this.state.phase === "backoff") this.input.backoff(this.failures, delayMs);
  }
  private jitteredDelay(delayMs: number, useDefaultSchedule: boolean): number {
    if (!useDefaultSchedule || this.input.jitter === false) return delayMs;
    const random = Math.min(1, Math.max(0, this.input.random?.() ?? Math.random()));
    return Math.max(1, Math.round(delayMs * (0.8 + random * 0.4)));
  }
  admitRecoveryHint(): boolean {
    if (this.state.phase === "disposed" || this.state.phase === "blocked" || this.pending
      || this.now() - this.lastHintAt < 5_000) return false;
    this.lastHintAt = this.now();
    return true;
  }
  dispose(): void {
    if (this.state.phase === "disposed") return;
    this.cancelRetry();
    this.cancelStability();
    this.state = { phase: "disposed", binding: null, error: null, recovering: false };
    this.retire(new Error("Connection owner is disposed"));
    this.input.invalidate();
    this.input.changed();
  }
}
