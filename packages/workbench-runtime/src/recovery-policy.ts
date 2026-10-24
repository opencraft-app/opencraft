import { advanceRecoveryProgress, type RecoveryProgress, type RecoveryStage } from "./recovery-observation";

/** Recovery scheduling only. Session/Replica keep data and authority ownership. */
export type RecoveryDemand = "visible" | "open" | "cache";
export interface RecoveryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  now?(): number;
}
export interface RecoveryTask {
  readonly key: object;
  demand(): RecoveryDemand;
  run(): Promise<void>;
  retryable(error: unknown): boolean;
  readonly propagateFailure?: boolean;
}
interface Work { task: RecoveryTask; attempt: number; retryTicket: number; propagateFailure: boolean; resolve(error?: unknown): void; promise: Promise<void> }
const rank = { visible: 0, open: 1, cache: 2 } as const;
const delays = [500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
let episodeSequence = 0;

/** One owner per Host, independent of DOM retention and physical transport. */
export class ConversationRecoveryOwner {
  private notify() { try { this.input.changed?.(); } catch { /* Diagnostics cannot affect recovery. */ } }
  private connectionProgress: RecoveryProgress | undefined;
  private historyProgress = new WeakMap<object, RecoveryProgress>();
  getProgress(key?: object): RecoveryProgress | undefined {
    return key === undefined ? this.connectionProgress : this.historyProgress.get(key);
  }
  private observe(stage: RecoveryStage, key?: object, options: { startAttempt?: boolean; retryAt?: number; error?: unknown } = {}) {
    if (this.disposed) return;
    const value = advanceRecoveryProgress(this.getProgress(key), {
      recoveryId: this.episode?.id ?? `recovery-${this.now().toString(36)}-${++episodeSequence}`,
      now: this.now(), stage, ...options,
    });
    if (key === undefined) this.connectionProgress = value;
    else this.historyProgress.set(key, value);
    this.notify();
  }
  connectionStage(stage: "connecting" | "initializing") {
    if (!this.episode) this.begin("connecting");
    if (this.connectionProgress?.stage === stage) return;
    this.observe(stage, undefined, { startAttempt: stage === "connecting" });
    this.stage(stage);
  }
  connectionFailed(error: unknown) { this.observe("failed", undefined, { error }); }
  private generation = 0;
  private work = new Map<object, Work>();
  private timers = new Map<object, unknown>();
  private active = new Set<object>();
  private disposed = false;
  private connected = true;
  private stages = 0;
  private episode: { id: string; start: number; requests: number; bytes: number; projectionMs: number; extraConversations: Set<object> } | null = null;
  constructor(private readonly input: {
    hostId: string; clock: RecoveryClock;
    delaysMs?: readonly number[]; concurrency?: number;
    /** Default history backoff spreads reconnect storms; test schedules stay exact. */
    jitter?: boolean;
    random?: () => number;
    changed?(): void;
    log?(event: Readonly<Record<string, string | number>>): void;
  }) {}
  get observing() { return this.episode !== null; }
  private now() { return this.input.clock.now?.() ?? Date.now(); }
  begin(reason: string) {
    if (["transport-unavailable", "waiting", "connecting", "manual-block"].includes(reason)) this.connected = false;
    if (this.episode === null) this.episode = {
      id: `recovery-${this.now().toString(36)}-${++episodeSequence}`, start: this.now(),
      requests: 0, bytes: 0, projectionMs: 0, extraConversations: new Set(),
    };
    if (reason === "connecting") this.connectionStage("connecting");
    else { this.stage(reason); if (reason === "manual-block") this.observe("blocked"); }
  }
  stage(stage: string, fields: Record<string, string | number> = {}) {
    if (!this.episode) return;
    const event = { hostId: this.input.hostId, recoveryId: this.episode.id, stage,
      elapsedMs: Math.max(0, this.now() - this.episode.start), ...fields };
    try { if (this.input.log) this.input.log(event); else console.log("[appserver-recovery]", event); } catch { /* Diagnostics cannot affect recovery. */ }
  }
  requestStarted() { if (this.episode) this.episode.requests++; }
  response(bytes = 0) { if (this.episode) this.episode.bytes += bytes; }
  scheduled() { this.settle(); }
  async span<T>(stage: string, run: () => Promise<T>): Promise<T> {
    const episode = this.episode, start = this.now(); this.stages++;
    try { const result = await run(); if (this.episode === episode) this.stage(stage, { durationMs: this.now() - start }); return result; }
    catch (error) { if (this.episode === episode) this.stage(stage + "-failed", { durationMs: this.now() - start }); throw error; }
    finally { this.stages--; this.settle(); }
  }
  private settle() {
    if (!this.connected || this.work.size || this.stages || !this.episode) return;
    this.stage("settled", { requests: this.episode.requests, responseBytes: this.episode.bytes,
      projectionMs: this.episode.projectionMs, extraConversations: this.episode.extraConversations.size });
    this.episode = null;
  }
  projection(duration: number) { if (this.episode) this.episode.projectionMs += duration; }
  /** Observation only: ConnectionLifecycleOwner owns admission and timers. */
  hostReady() {
    this.connected = true;
    this.connectionProgress = undefined;
    this.notify();
    this.stage("host-ready");
  }
  connectionBackoff(attempt: number, delayMs: number) {
    this.begin("waiting");
    this.stage("backoff", { attempt, delayMs });
    this.observe("backoff", undefined, { retryAt: this.now() + delayMs });
  }
  connectionBlocked() { this.begin("manual-block"); }
  invalidate() {
    this.generation++;
    for (const timer of this.timers.values()) this.input.clock.clearTimeout(timer);
    this.timers.clear();
    for (const work of this.work.values()) work.resolve();
    this.work.clear();
    this.historyProgress = new WeakMap();
    this.notify();
    // In-flight operations are fenced by the runtime's connection revision.
    this.active.clear();
  }
  remove(key: object) {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.input.clock.clearTimeout(timer);
    this.timers.delete(key);
    this.work.get(key)?.resolve(); this.work.delete(key);
    this.historyProgress.delete(key);
    this.notify();
  }
  recover(task: RecoveryTask, immediate = false): Promise<void> {
    if (this.disposed || task.demand() === "cache") return Promise.resolve();
    const previous = this.work.get(task.key);
    if (previous) {
      previous.propagateFailure ||= task.propagateFailure === true;
      if (immediate) {
        // A user retry replaces the queued policy, but shares any active read.
        previous.task = task;
        previous.retryTicket++;
        const timer = this.timers.get(task.key);
        if (timer !== undefined) {
          this.input.clock.clearTimeout(timer);
          this.timers.delete(task.key);
          previous.attempt = 0;
        }
      }
      this.pump();
      return previous.promise;
    }
    let resolve!: (error?: unknown) => void;
    const promise = new Promise<void>((done, reject) => { resolve = error => error === undefined ? done() : reject(error); });
    if (!this.episode) this.begin("resources");
    // A new work item must not inherit a completed failure from an older episode.
    this.historyProgress.delete(task.key);
    this.observe("queued", task.key);
    this.work.set(task.key, { task, attempt: 0, retryTicket: 0, propagateFailure: task.propagateFailure === true, resolve, promise });
    this.pump();
    return promise;
  }
  private pump() {
    if (this.disposed) return;
    const pending = [...this.work.values()].filter(w => !this.active.has(w.task.key) && !this.timers.has(w.task.key))
      .sort((a, b) => rank[a.task.demand()] - rank[b.task.demand()]);
    for (const work of pending) {
      if (this.active.size >= (this.input.concurrency ?? 2)) break;
      if (work.task.demand() === "cache") { this.remove(work.task.key); continue; }
      // Reserve a slot for a newly visible conversation. Background recovery
      // has concurrency one, so a navigation cannot wait behind hidden work.
      if (work.task.demand() !== "visible" && this.active.size > 0) break;
      // Hidden work waits for visible recovery to settle, including failure.
      if (work.task.demand() !== "visible" && [...this.active].some(key => this.work.get(key)?.task.demand() === "visible")) break;
      const key = work.task.key, generation = this.generation;
      this.active.add(key);
      this.observe("history", key, { startAttempt: true });
      this.stage("history-started", { demand: work.task.demand(), attempt: this.getProgress(key)!.attempt });
      const started = this.now(), demand = work.task.demand();
      if (demand !== "visible" && this.episode) this.episode.extraConversations.add(key);
      void Promise.resolve().then(() => {
        if (generation !== this.generation || this.work.get(key) !== work || this.disposed) return;
        return work.task.run();
      }).then(() => {
        if (generation !== this.generation || this.work.get(key) !== work) return;
        this.stage("history-authoritative", { demand, durationMs: this.now() - started });
        work.resolve(); this.work.delete(key);
        this.historyProgress.delete(key); this.notify();
      }, error => {
        if (generation !== this.generation || this.work.get(key) !== work) return;
        this.stage("history-failed", { demand, durationMs: this.now() - started });
        this.observe("failed", key, { error });
        if (work.attempt < 3 && work.task.retryable(error)) {
          const schedule = this.input.delaysMs;
          const base = (schedule ?? delays)[Math.min(work.attempt++, 6)] ?? 5_000;
          const delayMs = this.jitteredDelay(base, schedule === undefined);
          this.observe("backoff", key, { retryAt: this.now() + delayMs });
          this.stage("history-backoff", { demand, delayMs, attempt: this.getProgress(key)!.attempt });
          const ticket = ++work.retryTicket;
          this.timers.set(key, this.input.clock.setTimeout(() => {
            if (generation !== this.generation || this.work.get(key) !== work || ticket !== work.retryTicket) return;
            this.timers.delete(key); this.pump();
          }, delayMs));
        } else { work.resolve(work.propagateFailure ? error : undefined); this.work.delete(key); }
      }).finally(() => {
        if (generation !== this.generation) return;
        this.active.delete(key); this.pump();
        this.settle();
      });
    }
  }
  private jitteredDelay(delayMs: number, useDefaultSchedule: boolean): number {
    if (!useDefaultSchedule || this.input.jitter === false) return delayMs;
    const random = Math.min(1, Math.max(0, this.input.random?.() ?? Math.random()));
    return Math.max(1, Math.round(delayMs * (0.8 + random * 0.4)));
  }
  dispose() { this.disposed = true; this.invalidate(); }
}

/**
 * Presentation independent policy for revalidating a visible conversation.
 * Platform adapters report foreground and connectivity changes. The Host
 * runtime remains the only authority for the resulting history.
 */
export interface ConversationReturnProbe {
  background(now: number): void;
  foreground(now: number): boolean;
  offline(): void;
  online(now: number): boolean;
}

export function createConversationReturnProbe(input: {
  readonly minimumBackgroundMs?: number;
  readonly minimumProbeIntervalMs?: number;
} = {}): ConversationReturnProbe {
  const minimumBackgroundMs = input.minimumBackgroundMs ?? 15_000;
  const minimumProbeIntervalMs = input.minimumProbeIntervalMs ?? 5_000;
  let backgroundAt: number | null = null;
  let disconnected = false;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  const admit = (now: number) => {
    if (now - lastProbeAt < minimumProbeIntervalMs) return false;
    lastProbeAt = now;
    return true;
  };
  return {
    background(now) { backgroundAt = now; },
    foreground(now) {
      const duration = backgroundAt === null ? 0 : Math.max(0, now - backgroundAt);
      backgroundAt = null;
      if (disconnected || duration < minimumBackgroundMs) return false;
      return admit(now);
    },
    offline() { disconnected = true; },
    online(now) {
      if (!disconnected) return false;
      disconnected = false;
      return admit(now);
    },
  };
}
