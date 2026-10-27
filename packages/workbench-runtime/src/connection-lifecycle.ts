import type { RecoveryClock } from "./recovery-policy";
import { recoveryNow } from "./recovery-clock";

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
  /** Only a new, completed boundary renews the stage budget; never the total budget. */
  progress(stage: string, timeoutMs?: number): void;
}
interface Attempt {
  controller: AbortController;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  timer: unknown;
  ticket: number;
  readonly deadline: number;
  stageDeadline: number;
  stage: string;
  readonly stages: Set<string>;
}
const delays = [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** One writer for connection admission, revocation, readiness and retry timers.
 * Resource owners retain their own demand, data and source identities. */
export class ConnectionLifecycleOwner<T> {
  private state: ConnectionState<T> = { phase: "idle", binding: null, error: null, recovering: false };
  private attempt: Attempt | null = null;
  private retryTimer: unknown = null;
  private retryTicket = 0;
  private retryAt = Number.POSITIVE_INFINITY;
  private stableTimer: unknown = null;
  private stableTicket = 0;
  private failures = 0;
  private pendingWake = false;
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
    stageTimeoutMs?: number;
  }) {}
  get snapshot(): ConnectionState<T> { return this.state; }
  get pending(): boolean { return this.attempt !== null; }
  get reconnectAttempt(): number { return this.failures; }
  private now() { return this.input.clock.now?.() ?? recoveryNow(); }
  private cancelRetry() {
    ++this.retryTicket;
    if (this.retryTimer !== null) this.input.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = Number.POSITIVE_INFINITY;
  }
  private cancelStability() {
    ++this.stableTicket;
    if (this.stableTimer !== null) this.input.clock.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
  private retire(error: Error, invalidate: () => void): boolean {
    const previous = this.attempt;
    this.attempt = null;
    if (previous) {
      this.input.clock.clearTimeout(previous.timer);
      previous.reject(error);
    }
    // Invalidate child authority before cancellation observers can admit a successor.
    invalidate();
    previous?.controller.abort(error);
    return previous !== null;
  }
  connect(force = false): Promise<void> {
    if (this.state.phase === "disposed") return Promise.reject(new Error("Connection owner is disposed"));
    // Explicit demand can arrive before overdue timers on a resumed page.
    // Retiring may synchronously dispose us or admit a successor via observers.
    if (this.attempt && this.expired(this.attempt)) this.lost(this.timeoutError(this.attempt));
    if (this.snapshot.phase === "disposed") return Promise.reject(new Error("Connection owner is disposed"));
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
    if (this.pendingWake) this.lastHintAt = this.now();
    this.pendingWake = false;
    const now = this.now();
    const attempt: Attempt = { controller: new AbortController(), promise, resolve, reject, timer: null,
      ticket: 0, deadline: now + (this.input.timeoutMs ?? 60_000),
      stageDeadline: now + (this.input.stageTimeoutMs ?? 30_000), stage: "start", stages: new Set(["start"]) };
    this.attempt = attempt;
    this.state = { phase: "attempting", binding: null, error: null, recovering };
    const current = () => this.attempt === attempt && !attempt.controller.signal.aborted;
    const assertCurrent = () => {
      if (current() && this.expired(attempt)) this.lost(this.timeoutError(attempt));
      if (!current()) throw attempt.controller.signal.reason ?? new Error("Connection attempt was superseded");
    };
    this.armDeadline(attempt);
    // Ownership and deadline precede all observers and external I/O.
    if (invalidate) this.input.invalidate();
    this.input.changed();
    void Promise.resolve().then(async () => {
      assertCurrent();
      const binding = await this.input.run({ signal: attempt.controller.signal, assertCurrent,
        progress: (stage, timeoutMs = this.input.stageTimeoutMs ?? 30_000) => {
          assertCurrent();
          if (attempt.stages.has(stage)) return;
          attempt.stages.add(stage);
          attempt.stage = stage;
          attempt.stageDeadline = this.now() + timeoutMs;
          this.armDeadline(attempt);
        },
      });
      assertCurrent();
      if (!this.input.valid(binding)) throw new Error("Connection was lost before readiness commit");
      this.input.clock.clearTimeout(attempt.timer);
      this.attempt = null;
      this.pendingWake = false;
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
    const state: ConnectionState<T> = { phase: blocked ? "blocked" : "backoff", binding: null, error, recovering: true };
    this.state = state;
    if (blocked) this.pendingWake = false;
    let delayMs = 0;
    if (!blocked) {
      const schedule = this.input.delaysMs;
      const base = (schedule ?? delays)[Math.min(this.failures++, (schedule ?? delays).length - 1)] ?? 60_000;
      delayMs = this.jitteredDelay(base, schedule === undefined);
      if (this.pendingWake) delayMs = Math.min(delayMs, Math.max(0, this.lastHintAt + 5_000 - this.now()));
      this.scheduleRetry(delayMs);
    }
    // Retry accounting and child revocation precede abort/status observer reentry.
    this.retire(error, () => this.input.invalidate());
    if (this.state !== state) return;
    this.input.changed();
    if (this.state.phase === "backoff") this.input.backoff(this.failures, delayMs);
    // A retained foreground signal buys one validation, without resetting failures.
    // Recheck after observers: they may have disposed, blocked or started a retry.
    if (this.state.phase === "backoff" && this.pendingWake && this.now() - this.lastHintAt >= 5_000)
      void this.connect(true).catch(() => undefined);
  }
  private jitteredDelay(delayMs: number, useDefaultSchedule: boolean): number {
    if (!useDefaultSchedule || this.input.jitter === false) return delayMs;
    const random = Math.min(1, Math.max(0, this.input.random?.() ?? Math.random()));
    return Math.max(1, Math.round(delayMs * (0.8 + random * 0.4)));
  }
  private scheduleRetry(delayMs: number): void {
    this.cancelRetry();
    this.retryAt = this.now() + delayMs;
    const ticket = ++this.retryTicket;
    this.retryTimer = this.input.clock.setTimeout(() => {
      if (ticket !== this.retryTicket || this.state.phase !== "backoff") return;
      this.retryTimer = null;
      this.retryAt = Number.POSITIVE_INFINITY;
      void this.connect(true).catch(() => undefined);
    }, delayMs);
  }
  private expired(attempt: Attempt): boolean {
    return this.now() >= Math.min(attempt.deadline, attempt.stageDeadline);
  }
  private timeoutError(attempt: Attempt): Error {
    return new Error(`Connection attempt timed out (${this.now() >= attempt.deadline ? "total" : attempt.stage})`);
  }
  private armDeadline(attempt: Attempt): void {
    if (attempt.timer !== null) this.input.clock.clearTimeout(attempt.timer);
    const ticket = ++attempt.ticket;
    attempt.timer = this.input.clock.setTimeout(() => {
      if (this.attempt !== attempt || attempt.ticket !== ticket) return;
      if (this.input.clock.now === undefined || this.expired(attempt)) this.lost(this.timeoutError(attempt));
      else this.armDeadline(attempt);
    }, Math.max(0, Math.min(attempt.deadline, attempt.stageDeadline) - this.now()));
  }
  admitRecoveryHint(): boolean {
    if (this.state.phase === "disposed" || this.state.phase === "blocked") return false;
    if (this.attempt) {
      this.pendingWake = true;
      // Safari may deliver foreground before overdue timers after a frozen page.
      if (this.expired(this.attempt)) this.lost(this.timeoutError(this.attempt));
      return false;
    }
    if (this.now() - this.lastHintAt < 5_000) {
      if (this.state.phase === "backoff") {
        this.pendingWake = true;
        const eligibleAt = this.lastHintAt + 5_000;
        if (eligibleAt < this.retryAt) this.scheduleRetry(eligibleAt - this.now());
      }
      return false;
    }
    this.lastHintAt = this.now();
    return true;
  }
  dispose(): void {
    if (this.state.phase === "disposed") return;
    this.cancelRetry();
    this.cancelStability();
    this.pendingWake = false;
    this.state = { phase: "disposed", binding: null, error: null, recovering: false };
    this.retire(new Error("Connection owner is disposed"), () => this.input.invalidate());
    this.input.changed();
  }
}
