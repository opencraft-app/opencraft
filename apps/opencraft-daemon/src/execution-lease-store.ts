import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";

export type ExecutionPrincipal = NonNullable<TransportSubmissionContext["executionPrincipal"]>;
export type ExecutionInputKind = "start" | "queue" | "steer" | "system";
export interface ExecutionSubmission {
  readonly principal: ExecutionPrincipal | null;
  readonly ownership: "human" | "unowned" | "unknown";
}
export interface ExecutionLease extends ExecutionSubmission {
  readonly threadId: string;
  readonly inputId: string;
  readonly executionId: string;
  readonly generation: number;
  readonly turnId: string | null;
  readonly engineIncarnation: string | null;
  readonly admittedAtMs: number;
  readonly endedAtMs: number | null;
}
export type ExecutionLeaseResolution =
  | { readonly status: "active" | "expired" | "unowned"; readonly lease: ExecutionLease }
  | { readonly status: "unknown" };

/** Native original input IDs exclude both the dedicated steer item and Pi's
 * userMessage projection of steering. Displayed authors are never consulted. */
export function originalExecutionInputIds(turn: { items?: readonly unknown[] }): string[] {
  return (turn.items ?? []).flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (item.type !== "userMessage" || item.__opencraftMessageKind === "steering") return [];
    const id = item.clientId ?? item.clientUserMessageId ?? item.client_id;
    return typeof id === "string" && id ? [id] : [];
  });
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid execution identity");
  return value;
}
export function snapshotExecutionSubmission(context: TransportSubmissionContext): ExecutionSubmission {
  const principal = context.executionPrincipal;
  if (!principal) return Object.freeze({ principal: null, ownership: context.sender ? "unknown" : "unowned" });
  text(principal.provider); text(principal.subject);
  if (!Number.isFinite(context.validUntil) || context.validUntil! <= Date.now()) throw new Error("Execution identity expired");
  return Object.freeze({ principal: Object.freeze({ provider: principal.provider, subject: principal.subject,
    ...(principal.loginName ? { loginName: text(principal.loginName) } : {}) }), ownership: "human" });
}
function submission(row: Record<string, unknown>): ExecutionSubmission {
  const p = row.principal_json === null ? null : JSON.parse(String(row.principal_json)) as ExecutionPrincipal;
  return { principal: p ? Object.freeze({ ...p }) : null, ownership: row.ownership as ExecutionSubmission["ownership"] };
}
const SELECT = `SELECT l.*,s.principal_json,s.ownership,s.admission FROM execution_leases l
  JOIN execution_submissions s ON s.thread_id=l.thread_id AND s.input_id=l.input_id`;
function lease(row: Record<string, unknown>): ExecutionLease {
  return Object.freeze({ ...submission(row), threadId: String(row.thread_id), inputId: String(row.input_id),
    executionId: String(row.execution_id), generation: Number(row.generation), turnId: row.turn_id as string | null,
    engineIncarnation: row.engine_incarnation as string | null, admittedAtMs: Number(row.admitted_at_ms),
    endedAtMs: row.ended_at_ms === null ? null : Number(row.ended_at_ms) });
}
function resolution(row: Record<string, unknown> | undefined): ExecutionLeaseResolution {
  if (!row || row.state === "pending" || row.state === "unknown" || row.ownership === "unknown" || row.admission !== "accepted") return { status: "unknown" };
  const value = lease(row);
  if (row.state !== "active") return { status: "expired", lease: value };
  return { status: row.ownership === "unowned" ? "unowned" : "active", lease: value };
}

/** Read-only broker port. The caller selects a trusted Host DB, never a Renderer path. */
export class ExecutionLeaseReader {
  constructor(protected readonly db: DatabaseSync) {}
  resolve(input: { threadId: string; executionId: string; generation?: number }): ExecutionLeaseResolution {
    const row = this.db.prepare(`${SELECT} WHERE l.thread_id=? AND l.execution_id=?`).get(text(input.threadId), text(input.executionId));
    if (row && input.generation !== undefined && row.generation !== input.generation) return { status: "unknown" };
    return resolution(row);
  }
  /** Timestamp and incarnation MUST come from the broker's attested native job ancestry.
   * A whole uncertainty interval must fit exactly one execution; boundaries fail closed.
   * This does not authorize arbitrary same-UID callers or a supplied thread string. */
  resolveJobOrigin(input: { threadId: string; engineIncarnation: string; startedAtMs: number; uncertaintyMs: number }): ExecutionLeaseResolution {
    const { startedAtMs: at, uncertaintyMs: error } = input;
    text(input.threadId); text(input.engineIncarnation);
    if (!Number.isFinite(at) || !Number.isFinite(error) || error < 0 || error > 1000) return { status: "unknown" };
    const rows = this.db.prepare(`${SELECT} WHERE l.thread_id=? AND l.state!='rejected' AND l.admitted_at_ms<=?
      AND (l.ended_at_ms IS NULL OR l.ended_at_ms>=?)`).all(input.threadId, at + error, at - error);
    if (rows.length !== 1) return { status: "unknown" };
    const row = rows[0]!;
    if (row.engine_incarnation !== input.engineIncarnation || Number(row.admitted_at_ms) >= at - error
      || (row.ended_at_ms !== null && Number(row.ended_at_ms) <= at + error)) return { status: "unknown" };
    return resolution(row);
  }
}

/** Borrows the Host owner's managed connection; never migrates/closes it. */
export class ExecutionLeaseStore extends ExecutionLeaseReader {
  capture(threadId: string, inputId: string, value: ExecutionSubmission, admission: "pending" | "accepted" = "accepted", kind: ExecutionInputKind = "start"): void {
    text(threadId); text(inputId);
    if (!["human", "unowned", "unknown"].includes(value.ownership) || (value.ownership === "human") !== (value.principal !== null))
      throw new Error("Invalid execution ownership");
    if (value.principal) { text(value.principal.provider); text(value.principal.subject); }
    const existing = this.getSubmission(threadId, inputId);
    if (existing) {
      if (existing.ownership !== value.ownership || existing.principal?.provider !== value.principal?.provider
        || existing.principal?.subject !== value.principal?.subject || (this.inputKind(threadId, inputId) === "steer") !== (kind === "steer")) throw new Error("Submission execution principal is immutable");
      return; // A renamed display label cannot change or invalidate the original binding.
    }
    this.db.prepare(`INSERT INTO execution_submissions(thread_id,input_id,principal_json,ownership,submitted_at_ms,admission,input_kind) VALUES(?,?,?,?,?,?,?)`)
      .run(threadId, inputId, value.principal ? JSON.stringify(value.principal) : null, value.ownership, Date.now(), admission, kind);
  }
  private inputKind(threadId: string, inputId: string): ExecutionInputKind | null {
    const row = this.db.prepare("SELECT input_kind FROM execution_submissions WHERE thread_id=? AND input_id=?").get(threadId, inputId);
    return row ? row.input_kind as ExecutionInputKind : null;
  }
  getSubmission(threadId: string, inputId: string): ExecutionSubmission | null {
    const row = this.db.prepare("SELECT * FROM execution_submissions WHERE thread_id=? AND input_id=?").get(threadId, inputId);
    return row ? submission(row) : null;
  }
  begin(threadId: string, inputId: string, engineIncarnation?: string): string {
    text(threadId); text(inputId);
    // Explicit internal starts have no employee authority. No last-sender lookup.
    if (!this.getSubmission(threadId, inputId)) this.capture(threadId, inputId, { principal: null, ownership: "unowned" }, "accepted", "system");
    if (this.inputKind(threadId, inputId) === "steer") throw new Error("A steer cannot acquire an execution lease");
    const pending = this.db.prepare("SELECT execution_id FROM execution_leases WHERE thread_id=? AND input_id=? AND (state='pending' OR turn_id IS NOT NULL) ORDER BY generation LIMIT 1").get(threadId, inputId);
    if (pending) return String(pending.execution_id);
    const executionId = randomUUID();
    this.db.prepare(`INSERT INTO execution_leases(execution_id,thread_id,input_id,generation,state,admitted_at_ms,engine_incarnation)
      VALUES(?,?,?,(SELECT COALESCE(MAX(generation),0)+1 FROM execution_leases WHERE thread_id=?),'pending',?,?)`)
      .run(executionId, threadId, inputId, threadId, Date.now(), engineIncarnation ?? null);
    return executionId;
  }
  started(threadId: string, turnId: string, inputId?: string, engineIncarnation?: string): void {
    if (!threadId || !turnId) return;
    if (!inputId) { this.observedStart(threadId, turnId, engineIncarnation); return; }
    if (this.inputKind(threadId, inputId) === "steer") return;
    this.db.exec("SAVEPOINT execution_lease_binding");
    try {
      this.bindExactInput(threadId, turnId, inputId, engineIncarnation);
      this.db.exec("RELEASE execution_lease_binding");
    } catch (error) {
      this.db.exec("ROLLBACK TO execution_lease_binding; RELEASE execution_lease_binding"); throw error;
    }
  }
  private bindExactInput(threadId: string, turnId: string, inputId: string, incarnation?: string): void {
    let existing = this.db.prepare("SELECT * FROM execution_leases WHERE thread_id=? AND turn_id=?").get(threadId, turnId);
    const placeholder = existing?.input_id === `native:${turnId}`;
    incarnation ??= typeof existing?.engine_incarnation === "string" ? existing.engine_incarnation : undefined;
    if (existing && !placeholder) {
      if (existing.input_id !== inputId) { this.outcome(threadId, inputId, true); return; }
      if (incarnation && existing.engine_incarnation !== null && existing.engine_incarnation !== incarnation) { this.suspend(threadId); return; }
      this.db.prepare("UPDATE execution_leases SET state=CASE WHEN ended_at_ms IS NULL THEN 'active' ELSE state END,engine_incarnation=COALESCE(engine_incarnation,?) WHERE execution_id=?")
        .run(incarnation ?? null, existing.execution_id!);
      return;
    }
    const pending = this.db.prepare("SELECT * FROM execution_leases WHERE thread_id=? AND input_id=? AND turn_id IS NULL AND ended_at_ms IS NULL AND state IN ('pending','unknown') ORDER BY generation").all(threadId, inputId);
    if (pending.length > 1) return; // No guess between uncertain attempts.
    let target: (typeof pending)[number] | undefined = pending[0];
    if (!target) {
      if (!placeholder) {
        const id = this.begin(threadId, inputId, incarnation);
        target = this.db.prepare("SELECT * FROM execution_leases WHERE execution_id=?").get(id);
        if (target?.turn_id !== null) return;
      } else target = existing;
    }
    if (!target || (incarnation && target.engine_incarnation !== null && target.engine_incarnation !== incarnation)) return;
    const endedAt = existing?.ended_at_ms ?? null;
    if (placeholder && existing!.execution_id !== target.execution_id) {
      // Retire an unbound observation, retaining the original pre-send lease,
      // generation, incarnation and process-birth interval across Gateway loss.
      this.db.prepare("UPDATE execution_leases SET turn_id=NULL,state='rejected',ended_at_ms=admitted_at_ms WHERE execution_id=?")
        .run(existing!.execution_id!);
    }
    this.db.prepare("UPDATE execution_leases SET state='ended',ended_at_ms=? WHERE thread_id=? AND execution_id!=? AND turn_id IS NOT NULL AND state IN ('active','unknown') AND ended_at_ms IS NULL")
      .run(Date.now(), threadId, target.execution_id!);
    this.db.prepare("UPDATE execution_leases SET input_id=?,turn_id=?,engine_incarnation=COALESCE(engine_incarnation,?),state=?,ended_at_ms=? WHERE execution_id=?")
      .run(inputId, turnId, incarnation ?? null, endedAt === null ? "active" : "ended", endedAt, target.execution_id!);
  }
  confirmQueued(threadId: string, inputId: string, nativeCreatedAt: unknown): void {
    // A duplicate native queue receipt from before this capture cannot backfill
    // a missing historical principal from the employee replaying it today.
    this.db.prepare("UPDATE execution_submissions SET admission=CASE WHEN ?>=submitted_at_ms THEN 'accepted' ELSE 'unknown' END WHERE thread_id=? AND input_id=? AND admission='pending'")
      .run(typeof nativeCreatedAt === "number" && Number.isFinite(nativeCreatedAt) ? nativeCreatedAt : -1, threadId, inputId);
  }
  bindQueue(threadId: string, queueId: string, inputId: string): void {
    const existing = this.db.prepare("SELECT input_id FROM execution_queue_inputs WHERE thread_id=? AND queue_id=?").get(threadId, queueId);
    if (existing && existing.input_id !== inputId) throw new Error("Queue submission identity is immutable");
    this.db.prepare("INSERT OR IGNORE INTO execution_queue_inputs(thread_id,queue_id,input_id) VALUES(?,?,?)").run(text(threadId), text(queueId), text(inputId));
  }
  queuedInput(threadId: string, queueId: string): string | null {
    const row = this.db.prepare("SELECT input_id FROM execution_queue_inputs WHERE thread_id=? AND queue_id=?").get(threadId, queueId);
    return row ? String(row.input_id) : null;
  }
  observedStart(threadId: string, turnId: string, incarnation?: string): void {
    const existing = this.db.prepare("SELECT * FROM execution_leases WHERE thread_id=? AND turn_id=?").get(threadId, turnId);
    if (existing) {
      if (existing.input_id !== `native:${turnId}`) this.started(threadId, turnId, String(existing.input_id), incarnation);
      else if (incarnation && existing.engine_incarnation === null)
        this.db.prepare("UPDATE execution_leases SET engine_incarnation=? WHERE execution_id=?").run(incarnation, existing.execution_id!);
      return;
    }
    // A notification does not identify which start/queue won admission. Never
    // match a Turn to a pending request merely because it is the only one.
    const inputId = `native:${turnId}`;
    this.capture(threadId, inputId, { principal: null, ownership: "unknown" }, "accepted", "system");
    const id = this.begin(threadId, inputId, incarnation);
    this.db.prepare("UPDATE execution_leases SET turn_id=? WHERE execution_id=? AND state='pending'").run(turnId, id);
  }
  observedInput(threadId: string, turnId: string, inputId: string): void {
    const kind = this.inputKind(threadId, inputId);
    if (kind === "steer") return;
    if (!kind) this.capture(threadId, inputId, { principal: null,
      ownership: /^(schedule:|goal:|recovery:)/u.test(inputId) ? "unowned" : "unknown" }, "accepted", "system");
    this.started(threadId, turnId, inputId);
  }
  outcome(threadId: string, inputId: string, rejected: boolean): void {
    this.db.prepare("UPDATE execution_leases SET state=?,ended_at_ms=? WHERE thread_id=? AND input_id=? AND state='pending'")
      .run(rejected ? "rejected" : "unknown", rejected ? Date.now() : null, threadId, inputId);
  }
  suspend(threadId?: string): void {
    this.db.prepare(`UPDATE execution_leases SET state='unknown' WHERE ended_at_ms IS NULL AND state IN ('active','pending')${threadId ? " AND thread_id=?" : ""}`)
      .run(...(threadId ? [threadId] : []));
  }
  unsettledThreads(): string[] {
    return this.db.prepare("SELECT DISTINCT thread_id FROM execution_leases WHERE ended_at_ms IS NULL AND state IN ('active','pending','unknown')").all().map(row => String(row.thread_id));
  }
  reconcile(threadId: string, turns: readonly { id: string; status: string; items?: readonly unknown[] }[], engineIncarnation?: string): void {
    for (const turn of turns) {
      const inputs = originalExecutionInputIds(turn);
      if (turn.status === "inProgress" || inputs.length) {
        this.observedStart(threadId, turn.id, engineIncarnation);
        // Only the original native user input can resolve an admission gap.
        if (inputs.length) this.observedInput(threadId, turn.id, inputs[0]!);
      }
      if (["completed", "interrupted", "failed"].includes(turn.status)) this.finished(threadId, turn.id);
    }
  }
  finished(threadId: string, turnId: string): void {
    this.db.prepare("UPDATE execution_leases SET state='ended',ended_at_ms=? WHERE thread_id=? AND turn_id=? AND state IN ('active','unknown','pending')")
      .run(Date.now(), threadId, turnId);
  }
}

export type NativeExecutionState = "active" | "finished" | "unknown";
export type JobOriginQuery = Parameters<ExecutionLeaseReader["resolveJobOrigin"]>[0];

/** Personal credentials require current native execution evidence as well as
 * persisted identity. A missed completion during Gateway downtime is not a lease. */
export class LiveExecutionLeaseReader {
  constructor(private readonly reader: ExecutionLeaseReader,
    private readonly inspect: (lease: ExecutionLease) => Promise<NativeExecutionState>) {}
  async resolveJobOrigin(input: JobOriginQuery): Promise<ExecutionLeaseResolution> {
    const before = this.reader.resolveJobOrigin(input);
    if (before.status !== "active") return before;
    let state: NativeExecutionState;
    try { state = await this.inspect(before.lease); } catch { return { status: "unknown" }; }
    if (state === "unknown") return { status: "unknown" };
    if (state === "finished") return { status: "expired", lease: before.lease };
    // Re-read after the asynchronous boundary. Never follow a successor Turn,
    // changed process origin or a lease closed while the native read was pending.
    const after = this.reader.resolveJobOrigin(input);
    if (after.status !== "active") return after;
    return after.lease.executionId === before.lease.executionId && after.lease.generation === before.lease.generation
      ? after : { status: "unknown" };
  }
}
