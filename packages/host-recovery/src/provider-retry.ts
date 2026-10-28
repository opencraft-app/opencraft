import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";
import type { TurnRecoveryNotice } from "@opencraft/appserver-protocol";
import { PROVIDER_RETRY_LIMIT, providerRetryDecision, type ProviderFailure } from "./provider-retry-policy.js";

const schema = "CREATE TABLE provider_retries (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;";
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
/** Engine-owned durable queue. It continues accepted failed turns; it never owns user prompts. */
export class ProviderTurnRetry {
  private readonly managed;
  readonly outcome;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(directory: string, private readonly port: ProviderRetryPort, private readonly now = Date.now, private readonly random = Math.random, private readonly admissionOpen = () => true) {
    this.managed = openManagedDatabase({ path: join(directory, "provider-turn-retry.sqlite"),
      migrations: [{ version: 1, name: "provider-turn-retry", sql: schema }], legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(schema) });
    this.outcome = this.managed.outcome;
  }
  snapshot(threadId: string): ProviderRetry | null {
    const row = this.managed.database.prepare("SELECT value FROM provider_retries WHERE thread_id=?").get(threadId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  private put(row: ProviderRetry): void {
    this.managed.database.prepare("INSERT INTO provider_retries VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value").run(row.threadId, JSON.stringify(row));
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
    return (this.managed.database.prepare("SELECT thread_id FROM provider_retries WHERE json_extract(value,'$.state') IN ('waiting','preparing','dispatching','running')").all() as { thread_id: string }[]).map(row => row.thread_id);
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
  wake(delay = 0): void {
    if (this.closed || !this.admissionOpen()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.recover(); }, delay);
    this.timer.unref();
  }
  recover(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.flight ??= this.run().finally(() => { this.flight = null; this.schedule(); });
  }
  private schedule(): void {
    if (this.closed || !this.admissionOpen()) return;
    const rows = this.pendingThreadIds().map(id => this.snapshot(id)!);
    if (!rows.length) return;
    // Native completions provide the normal path; polling reconciles a missed terminal receipt.
    const waits = rows;
    if (waits.length) this.wake(Math.max(1000, Math.min(...waits.map(row => row.state === "waiting" ? row.retryAt - this.now() : 30_000))));
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
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      await this.flight;
      this.managed.database.close();
    })();
  }
}
