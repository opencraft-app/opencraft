import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ScopedSqlDatabase } from "@opencraft/sql";
import { openManagedDatabase, createSchemaValidator, nodeSqlDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { TurnRecoveryNotice } from "@opencraft/appserver-protocol";
import { boundedWakeTimer, timeoutWakeClock, type OwnerWakeTimer, type OwnerWakeTimerFactory } from "@opencraft/workspace-host";
import { PROVIDER_RETRY_LIMIT, providerRetryDecision, type ProviderFailure } from "./provider-retry-policy.js";

const schema = "CREATE TABLE provider_retries (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;";
/** Published chain (`provider-retry`); the SQL text is checksummed and must never change. */
export const PROVIDER_TURN_RETRY_MIGRATIONS = [{ version: 1, name: "provider-turn-retry", sql: schema }] as const;
export interface ProviderRetry {
  threadId: string; rootTurnId: string; turnId: string; attempts: number;
  state: "waiting" | "preparing" | "dispatching" | "running" | "complete" | "handled" | "exhausted" | "unconfirmed";
  retryAt: number; failure: ProviderFailure; inputId: string | null;
}
export interface ProviderRetryPort {
  serialize<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  inspect(turn: Readonly<ProviderRetry>): Promise<"live" | "finished" | "handled" | "unknown" | { failure: ProviderFailure }>;
  continue(turn: Readonly<ProviderRetry>, current: () => boolean, admit: () => boolean): Promise<string | null>;
  changed(threadId: string): void;
}
/** Shortest owner-clock gap between passes once a pass has settled; a fenced owner re-checks at this cadence. */
const RECHECK_FLOOR_MS = 1000;
/** Re-inspection cadence for an admitted retry whose native terminal receipt may have been missed. */
const RECONCILE_MS = 30_000;
/** Engine-owned durable queue. It continues accepted failed turns; it never owns user prompts.
 * Runtime-neutral domain over the SQL port; the opening owner lends the migrated connection.
 *
 * Owner-driven wake-up (workspace-host-split.md §4.3, as for schedules): once the engine owner first wakes it, every
 * settled pass and every committed failure computes the next pass from durable state — a waiting row's `retryAt`,
 * otherwise the reconcile cadence — and arms the single owner wake-up; an explicit `wake(delay)` can only bring it
 * earlier. Due-ness is decided again from durable state when the pass runs (`retryAt` against the owner clock), so a
 * stale, early or late wake-up never dispatches twice. While admission is fenced nothing announces its reopening,
 * so pending work re-checks every {@link RECHECK_FLOOR_MS} without dispatching. */
export class SqlProviderTurnRetry {
  private readonly timer: OwnerWakeTimer;
  /** The engine owner has woken this owner (initialize); before that nothing is armed. */
  private awake = false;
  /** Owner-clock time of an explicitly requested pass; null when none. */
  private requested: number | null = null;
  private flight: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(private readonly storage: ScopedSqlDatabase, private readonly port: ProviderRetryPort, private readonly now = Date.now, private readonly random = Math.random, private readonly admissionOpen = () => true,
    wakeTimer: OwnerWakeTimerFactory = wake => boundedWakeTimer(timeoutWakeClock(now), wake)) {
    this.timer = wakeTimer(() => this.woken());
  }
  snapshot(threadId: string): ProviderRetry | null {
    const row = this.storage.database.prepare("SELECT value FROM provider_retries WHERE thread_id=?").get(threadId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  private put(row: ProviderRetry): void {
    this.storage.database.prepare("INSERT INTO provider_retries VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value").run(row.threadId, JSON.stringify(row));
    this.port.changed(row.threadId);
  }
  notice(threadId: string): TurnRecoveryNotice | null {
    const row = this.snapshot(threadId);
    if (!row || row.state === "handled") return null;
    return { threadId, rootTurnId: row.rootTurnId, turnId: row.turnId, attempts: Math.max(1, row.attempts), limit: PROVIDER_RETRY_LIMIT,
      state: row.state === "waiting" || row.state === "preparing" ? "scheduled" : row.state === "exhausted" ? "exhausted" : row.state === "unconfirmed" || row.state === "dispatching" ? "unconfirmed" : "continued",
      sourceKind: "system", reason: "provider-failure", ...(row.state === "waiting" ? { retryAt: row.retryAt } : {}) };
  }
  pendingThreadIds(): string[] {
    return (this.storage.database.prepare("SELECT thread_id FROM provider_retries WHERE json_extract(value,'$.state') IN ('waiting','preparing','dispatching','running')").all() as { thread_id: string }[]).map(row => row.thread_id);
  }
  /** Only current native starts can acknowledge our owned dispatch. */
  started(threadId: string, turnId: string): void {
    if (this.closed) return;
    const row = this.snapshot(threadId);
    if (!row) return;
    if (row.state === "dispatching") this.put({ ...row, turnId, state: "running" });
    else if (row.turnId !== turnId) this.handled(threadId);
  }
  failed(threadId: string, turnId: string, failure: ProviderFailure): void {
    if (this.closed || !threadId || !turnId) return;
    const previous = this.snapshot(threadId);
    if (previous?.turnId === turnId && previous.state !== "running") return;
    // Older completions cannot replace a current chain, nor resurrect a user cancellation.
    if (previous && previous.turnId !== turnId && previous.state !== "handled" && previous.state !== "complete") return;
    if (previous?.turnId === turnId && previous.state === "handled") return;
    const continuing = previous?.state === "running" && previous.turnId === turnId;
    const attempts = continuing ? previous.attempts : 0;
    const decision = providerRetryDecision(failure, attempts, this.now(), this.random());
    if (decision.kind === "decline" && decision.reason !== "exhausted") { if (previous) this.handled(threadId); return; }
    this.put({ threadId, rootTurnId: continuing ? previous.rootTurnId : turnId, turnId, attempts,
      state: decision.kind === "retry" ? "waiting" : "exhausted", retryAt: decision.kind === "retry" ? decision.retryAt : this.now(), failure, inputId: null });
    this.wake();
  }
  finished(threadId: string, turnId: string): void {
    if (this.closed) return;
    const row = this.snapshot(threadId);
    if (row?.turnId === turnId && row.state === "running") this.put({ ...row, state: "complete" });
  }
  handled(threadId: string): void {
    if (this.closed) return;
    const row = this.snapshot(threadId);
    if (row && row.state !== "handled") this.put({ ...row, state: "handled" });
  }
  /** Requests a pass `delay` ms from now on the owner clock (engine initialize, reconnect, new evidence). */
  wake(delay = 0): void {
    if (this.closed) return;
    this.awake = true;
    if (!this.admissionOpen()) delay = Math.max(RECHECK_FLOOR_MS, delay);
    const at = this.now() + delay;
    // min() also corrects a request made before the owner clock was set back.
    this.requested = this.requested === null ? at : Math.min(this.requested, at);
    this.rearm();
  }
  recover(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.awake = true;
    return this.flight ??= this.run().finally(() => { this.flight = null; this.rearm(); });
  }
  private woken(): void {
    if (this.closed) return;
    // A running pass may already have read the rows this wake-up was for: run another once it settles.
    if (this.flight) { this.requested = this.now(); return; }
    this.requested = null;
    void this.recover();
  }
  /** Earliest owner-clock time a pass could act, from durable rows plus any explicit request; null when idle. */
  private nextWake(): number | null {
    const rows = this.pendingThreadIds().map(id => this.snapshot(id)).filter(row => row !== null);
    if (!rows.length) return null;
    const now = this.now();
    // Native completions provide the normal path; the reconcile cadence covers a missed terminal receipt.
    const durable = Math.max(now + RECHECK_FLOOR_MS, Math.min(...rows.map(row => row.state === "waiting" ? row.retryAt : now + RECONCILE_MS)));
    const next = this.requested === null ? durable : Math.min(this.requested, durable);
    return this.admissionOpen() ? next : Math.max(next, now + RECHECK_FLOOR_MS);
  }
  /** Settled passes and committed changes re-arm; a running pass re-arms when it settles. */
  private rearm(): void {
    if (this.closed || !this.awake || this.flight) return;
    let next: number | null;
    try { next = this.nextWake(); }
    catch { next = this.now() + RECONCILE_MS; }
    if (next === null) { this.requested = null; this.timer.cancel(); } else this.timer.arm(next);
  }
  private async run(): Promise<void> {
    for (const id of this.pendingThreadIds()) {
      if (this.closed || !this.admissionOpen()) return;
      await this.port.serialize(id, async () => {
        const row = this.snapshot(id);
        if (!row || ["complete", "handled", "exhausted", "unconfirmed"].includes(row.state)) return;
        if (row.state === "waiting" && row.retryAt > this.now()) return;
        const expected = JSON.stringify(row);
        const current = () => !this.closed && this.admissionOpen() && JSON.stringify(this.snapshot(id)) === expected;
        const inspected = await this.port.inspect(row);
        if (!current()) return;
        if (inspected === "unknown" || inspected === "live") return;
        if (inspected === "handled" || inspected === "finished") { this.put({ ...row, state: inspected === "finished" ? "complete" : "handled" }); return; }
        if (inspected.failure.kind === "permanent") { this.handled(id); return; }
        if (row.state === "dispatching") { this.put({ ...row, state: "unconfirmed" }); return; }
        if (row.state === "running") { this.failed(id, row.turnId, inspected.failure); return; }
        if (row.attempts >= PROVIDER_RETRY_LIMIT) { this.put({ ...row, state: "exhausted" }); return; }
        const dispatch: ProviderRetry = { ...row, attempts: row.attempts + 1, state: "preparing", inputId: `provider-retry:${randomUUID()}` };
        this.put(dispatch);
        let submitted = false;
        const canAdmit = () => !this.closed && this.admissionOpen() && this.snapshot(id)?.inputId === dispatch.inputId && this.snapshot(id)?.state === "preparing";
        const admit = () => { if (!canAdmit()) return false; submitted = true; this.put({ ...dispatch, state: "dispatching" }); return true; };
        try {
          const turnId = await this.port.continue(dispatch, canAdmit, admit);
          const latest = this.closed ? null : this.snapshot(id);
          if (!latest || latest.inputId !== dispatch.inputId || latest.state === "handled") return;
          if (turnId && !submitted) throw new Error("Provider retry port returned a turn without admission");
          if (turnId) this.put({ ...latest, turnId, state: latest.state === "complete" || latest.state === "waiting" || latest.state === "exhausted" ? latest.state : "running" });
          else if (latest.state === "preparing") this.put({ ...latest, state: "waiting", retryAt: this.now() + 1000 });
          else this.put({ ...latest, state: "unconfirmed" });
        } catch {
          const latest = this.closed ? null : this.snapshot(id);
          if (!latest || latest.inputId !== dispatch.inputId || latest.state === "handled") return;
          // Preparation failed before the send boundary; it consumes the same bounded budget.
          if (latest.state === "preparing") {
            const attempts = latest.attempts;
            this.put({ ...latest, attempts, state: attempts >= PROVIDER_RETRY_LIMIT ? "exhausted" : "waiting", retryAt: this.now() + 1000 });
          } else if (latest.state === "dispatching") this.put({ ...latest, state: "unconfirmed" });
        }
      }).catch(() => { /* Read-only inspection can be retried; dispatch outcomes stay durable. */ });
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      this.timer.cancel();
      await this.flight;
      this.storage.close();
    })();
  }
}

/** Node owner: opens `provider-turn-retry.sqlite` under the Host directory and lends it to the domain. */
export class ProviderTurnRetry extends SqlProviderTurnRetry {
  readonly outcome: DatabaseOutcome;
  constructor(directory: string, port: ProviderRetryPort, now?: () => number, random?: () => number, admissionOpen?: () => boolean,
    wakeTimer?: OwnerWakeTimerFactory) {
    const managed = openManagedDatabase({ schemaId: "provider-retry", path: join(directory, "provider-turn-retry.sqlite"),
      migrations: PROVIDER_TURN_RETRY_MIGRATIONS, legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(schema) });
    super({ database: nodeSqlDatabase(managed.database), close: () => managed.database.close() }, port, now, random, admissionOpen, wakeTimer);
    this.outcome = managed.outcome;
  }
}
