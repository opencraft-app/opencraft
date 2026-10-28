import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";
import type { TurnRecoveryNotice } from "@opencraft/appserver-protocol";

const schema = `CREATE TABLE interrupted_turns (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;
export const RECOVERY_LIMIT = 3;
export const RECOVERY_PROMPT = "Continue the task interrupted by a service restart. Check the existing results before repeating an interrupted command.";
/** Positive evidence that no execution was accepted, unlike an unknown send. */
export class RecoveryNotSubmitted extends Error {}
export interface RecoveryTurn {
  threadId: string; rootTurnId: string; turnId: string; attempts: number;
  state: "running" | "interrupted" | "preparing" | "dispatching" | "complete" | "handled" | "exhausted" | "unconfirmed";
  inputId: string | null;
  handledReason?: "user_stop" | "user_input";
}
export interface TurnRecoveryPort {
  /** lost requires positive evidence that the execution is no longer live. */
  inspect(turn: Readonly<RecoveryTurn>): Promise<"live" | "lost" | "finished" | "handled" | "unknown">;
  /** Run inside the same per-thread serialization boundary as human mutations. */
  serialize<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
  /** admit must run immediately before the first native execution mutation. */
  continue(turn: Readonly<RecoveryTurn>, current: () => boolean, admit: () => boolean): Promise<string | null>;
  changed(threadId: string, notice: TurnRecoveryNotice | null): void;
  stop?(turn: Readonly<RecoveryTurn>): Promise<void>;
}

/** One writer under the engine owner's existing lease; survives process death.
 * Tracking is opt-in at a proven native start, never a scan of failed history. */
export class InterruptedTurnRecovery {
  private readonly managed;
  readonly outcome;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private flight: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly dispatching = new Set<string>();
  constructor(directory: string, private readonly port: TurnRecoveryPort, private readonly delayMs = 500, private readonly admissionOpen: () => boolean = () => true) {
    this.managed = openManagedDatabase({ path: join(directory, "interrupted-turn-recovery.sqlite"),
      migrations: [{ version: 1, name: "interrupted-turn-recovery", sql: schema }], legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(schema) });
    this.outcome = this.managed.outcome;
  }
  private get(threadId: string): RecoveryTurn | null {
    const row = this.managed.database.prepare("SELECT value FROM interrupted_turns WHERE thread_id=?").get(threadId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  private put(turn: RecoveryTurn): void {
    this.managed.database.prepare("INSERT INTO interrupted_turns VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET value=excluded.value")
      .run(turn.threadId, JSON.stringify(turn));
    this.port.changed(turn.threadId, this.notice(turn.threadId));
  }
  /** Read-only authoritative root lifecycle; notices deliberately omit several live states. */
  snapshot(threadId: string): Readonly<RecoveryTurn> | null { return this.get(threadId); }
  notice(threadId: string): TurnRecoveryNotice | null {
    const row = this.get(threadId);
    if (!row || row.state === "handled" || row.attempts === 0) return null;
    return { threadId, rootTurnId: row.rootTurnId, turnId: row.turnId, attempts: row.attempts, limit: RECOVERY_LIMIT,
      state: row.state === "exhausted" ? "exhausted" : row.state === "running" || row.state === "complete" ? "continued" : "unconfirmed", sourceKind: "system" };
  }
  started(threadId: string, turnId: string, inputId?: string): void {
    if (this.closed || !threadId || !turnId) return;
    const prior = this.get(threadId);
    if (prior?.turnId === turnId) return;
    if (prior?.state === "handled" && this.dispatching.has(threadId) && (!inputId || inputId === prior.inputId)) {
      this.put({ ...prior, turnId }); return;
    }
    // Native notification may precede the acknowledgement of our owned send.
    if (prior?.state === "dispatching") {
      this.put({ ...prior, turnId, state: "running" }); return;
    }
    this.put({ threadId, rootTurnId: turnId, turnId, attempts: 0, state: "running", inputId: null });
  }
  finished(threadId: string, turnId: string): void {
    if (this.closed) return;
    const row = this.get(threadId);
    // Synthetic failure on connection/process loss is not a native completion.
    if (row?.turnId === turnId && row.state === "running") this.put({ ...row, state: "complete" });
  }
  handled(threadId: string, reason: "user_stop" | "user_input" = "user_input"): void {
    if (this.closed) return;
    const row = this.get(threadId);
    if (row) this.put({ ...row, state: "handled", handledReason: reason });
  }
  lost(threadId?: string): void {
    if (this.closed) return;
    for (const row of this.pending()) if ((!threadId || row.threadId === threadId) && row.state === "running") this.put({ ...row, state: "interrupted" });
  }
  /** Read-only lifecycle proof; no change to execution or recovery policy. */
  pendingThreadIds(): string[] { return [...new Set(this.pending().map(row => row.threadId))]; }
  handoffObservation() {
    const rows = this.managed.database.prepare("SELECT value FROM interrupted_turns").all().map(row => JSON.parse(String(row.value)));
    if (rows.some(row => !row || typeof row.threadId !== "string" || !["running", "interrupted", "preparing", "dispatching", "complete", "handled", "exhausted", "unconfirmed"].includes(row.state))) throw new Error("Invalid recovery custody");
    return { flights: this.flight ? 1 : 0, unfinished: rows.filter(row => !["complete", "handled"].includes(row.state)).length };
  }
  private pending(): RecoveryTurn[] {
    return (this.managed.database.prepare("SELECT value FROM interrupted_turns").all() as { value: string }[])
      .map(row => JSON.parse(row.value) as RecoveryTurn).filter(row => ["running", "interrupted", "preparing", "dispatching"].includes(row.state));
  }
  wake(): void {
    if (this.closed || this.timer || !this.admissionOpen()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.recover().catch(() => this.wake());
    }, this.delayMs);
    this.timer.unref();
  }
  recover(): Promise<void> {
    if (this.closed || !this.admissionOpen()) return Promise.resolve();
    return this.flight ??= this.run().finally(() => { this.flight = null; });
  }
  private async run(): Promise<void> {
    for (const candidate of this.pending()) {
      if (this.closed) return;
      await this.port.serialize(candidate.threadId, async () => {
        const row = this.get(candidate.threadId);
        if (!row || !["running", "interrupted", "preparing", "dispatching"].includes(row.state)) return;
        const expected = JSON.stringify(row);
        const current = () => !this.closed && JSON.stringify(this.get(row.threadId)) === expected;
        const state = await this.port.inspect(row);
        if (!current()) return;
        if (state === "live") return;
        if (state === "unknown") { this.wake(); return; }
        if (state === "finished" || state === "handled") { this.put({ ...row, state: state === "finished" ? "complete" : "handled" }); return; }
        // A crash between native acceptance and ACK cannot authorize another send.
        if (row.state === "dispatching") { this.put({ ...row, state: "unconfirmed" }); return; }
        if (row.attempts >= RECOVERY_LIMIT) { this.put({ ...row, state: "exhausted" }); await this.port.stop?.(row); return; }
        const dispatch: RecoveryTurn = { ...row, attempts: row.attempts + 1, state: "preparing", inputId: `restart-recovery:${randomUUID()}` };
        this.put(dispatch);
        this.dispatching.add(row.threadId);
        const canAdmit = () => !this.closed && this.admissionOpen() && this.get(row.threadId)?.inputId === dispatch.inputId && this.get(row.threadId)?.state === "preparing";
        const admit = () => {
          if (!canAdmit()) return false;
          this.put({ ...dispatch, state: "dispatching" }); return true;
        };
        try {
          const turnId = await this.port.continue(dispatch, canAdmit, admit);
          const latest = this.closed ? null : this.get(row.threadId);
          if (!latest || latest.inputId !== dispatch.inputId || latest.state === "handled") return;
          if (turnId) this.put({ ...latest, turnId, state: latest.state === "complete" ? "complete" : "running" });
          else if (latest.state === "preparing") { this.put({ ...latest, state: "interrupted" }); this.wake(); }
          else this.put({ ...latest, state: "unconfirmed" });
        } catch (error) {
          const latest = this.closed ? null : this.get(row.threadId);
          if (latest?.inputId === dispatch.inputId && (latest.state === "preparing" || latest.state === "dispatching" && error instanceof RecoveryNotSubmitted)) {
            this.put({ ...latest, state: "interrupted" }); this.wake();
          } else if (latest?.inputId === dispatch.inputId && latest.state === "dispatching") this.put({ ...latest, state: "unconfirmed" });
        } finally { this.dispatching.delete(row.threadId); }
      }).catch(() => this.wake());
    }
  }
  close(): Promise<void> {
    return this.closing ??= this.dispose();
  }
  private async dispose(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer);
    await this.flight?.catch(() => undefined); this.managed.database.close();
  }
}
