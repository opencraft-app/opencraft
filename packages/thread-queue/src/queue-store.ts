import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inputExecutionEnded, type InputDeliveryReceipt } from "@opencraft/appserver-protocol";
import { InputDeliveryStore } from "./delivery-store.js";

export type QueueState = "queued" | "dispatching" | "steering" | "unknown" | "delivered" | "discarded" | "closed";

export interface QueuedSubmission<S> {
  readonly id: string;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly input: readonly unknown[];
  readonly position: number;
  readonly createdAt: number;
  readonly state: QueueState;
  readonly targetTurnId: string | null;
  readonly pausedReason: string | null;
  readonly executionSubmission: S | null;
  readonly delivery?: InputDeliveryReceipt;
}

/** What an engine attaches to queued inputs, and which inputs their owner reconciles. */
export interface ThreadQueueOptions<S> {
  /** Convert inputs left mid-dispatch by a previous process to unknown. Default true. */
  readonly recoverPending?: boolean;
  /**
   * Record per-input submission metadata inside the add transaction. `existing` is
   * the earlier row when the same client message is queued again.
   */
  readonly capture?: (
    threadId: string,
    clientId: string,
    submission: S | undefined,
    existing: QueuedSubmission<S> | null,
  ) => void;
  /** Read the metadata `capture` recorded. */
  readonly submission?: (threadId: string, clientId: string) => S | null;
  /**
   * Client message IDs starting with this prefix belong to an owner that
   * reconciles their unknown outcome itself; users cannot retry them and they
   * block reordering while unsettled.
   */
  readonly ownerReconciledPrefix?: string;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function parseInput(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new Error("Queued input must be a nonempty array of user input objects");
  }
  return value;
}

/**
 * Durable per-thread input queue with delivery receipts. The database owner
 * creates `opencraft_host_queue`, `opencraft_input_delivery` and
 * `opencraft_turn_delivery`; this class only reads and writes them.
 */
export class ThreadQueueStore<S = never> {
  readonly deliveries: InputDeliveryStore;
  private readonly owned: string;
  private readonly prefix: string | undefined;

  constructor(
    protected readonly db: DatabaseSync,
    private readonly options: ThreadQueueOptions<S> = {},
  ) {
    const prefix = options.ownerReconciledPrefix;
    // Interpolated into LIKE: letters, digits and separators only, never wildcards.
    if (prefix !== undefined && !/^[A-Za-z0-9.:-]+$/u.test(prefix)) throw new Error("Invalid owner-reconciled prefix");
    this.prefix = prefix;
    this.owned = prefix === undefined ? "0" : `client_id LIKE '${prefix}%'`;
    this.deliveries = new InputDeliveryStore(db);
    if (options.recoverPending !== false)
      this.atomic(() => {
        for (const row of db
          .prepare("SELECT thread_id,client_id FROM opencraft_host_queue WHERE state='dispatching'")
          .all())
          this.deliveries.admission(String(row.thread_id), String(row.client_id), "unknown");
        db.prepare(
          "UPDATE opencraft_host_queue SET state='unknown', paused_reason='steer-delivery-unconfirmed', updated_at_ms=? WHERE state='dispatching'",
        ).run(Date.now());
      });
  }

  private ownerReconciled(clientId: string): boolean {
    return this.prefix !== undefined && clientId.startsWith(this.prefix);
  }

  protected atomic<T>(write: () => T): T {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      if (ownsTransaction) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private project(row: Record<string, unknown>): QueuedSubmission<S> {
    const threadId = requiredText(row.thread_id, "thread id"),
      clientId = requiredText(row.client_id, "client message id");
    const targetTurnId = typeof row.target_turn_id === "string" ? row.target_turn_id : null;
    return {
      id: requiredText(row.id, "queue id"),
      threadId,
      clientUserMessageId: clientId,
      input: parseInput(JSON.parse(requiredText(row.input_json, "queue input"))),
      position: Number(row.position),
      createdAt: Number(row.created_at_ms),
      state: row.state as QueueState,
      targetTurnId,
      pausedReason: typeof row.paused_reason === "string" ? row.paused_reason : null,
      delivery: this.deliveries.receipt(threadId, clientId, targetTurnId),
      executionSubmission: this.options.submission?.(threadId, clientId) ?? null,
    };
  }
  protected row(threadId: string, id: string): QueuedSubmission<S> | null {
    const row = this.db.prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND id=?").get(threadId, id);
    return row ? this.project(row) : null;
  }

  find(threadId: string, id: string): QueuedSubmission<S> | null {
    return this.row(threadId, id);
  }

  findByClientId(threadId: string, clientId: string): QueuedSubmission<S> | null {
    const row = this.db
      .prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND client_id=?")
      .get(threadId, clientId);
    return row ? this.project(row) : null;
  }

  add(threadId: string, clientId: string, input: readonly unknown[], submission?: S): QueuedSubmission<S> {
    return this.atomic(() => {
      requiredText(threadId, "thread id");
      requiredText(clientId, "client message id");
      parseInput(input);
      const existing = this.findByClientId(threadId, clientId);
      if (existing) {
        if (JSON.stringify(existing.input) !== JSON.stringify(input))
          throw new Error("Client message id already belongs to different input");
        this.options.capture?.(threadId, clientId, submission, existing);
        return { ...existing, executionSubmission: this.options.submission?.(threadId, clientId) ?? null };
      }
      this.options.capture?.(threadId, clientId, submission, null);
      const now = Date.now();
      const position =
        Number(
          (
            this.db
              .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM opencraft_host_queue WHERE thread_id=?")
              .get(threadId) as { position: number }
          ).position,
        ) + 1;
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO opencraft_host_queue(id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state) VALUES(?,?,?,?,?,?,?,'queued')",
        )
        .run(id, threadId, clientId, JSON.stringify(input), position, now, now);
      this.deliveries.register(threadId, clientId);
      return this.row(threadId, id)!;
    });
  }

  list(threadId: string, receiptTurnIds?: readonly string[]): QueuedSubmission<S>[] {
    const open =
      "SELECT * FROM opencraft_host_queue WHERE thread_id=? AND state IN ('queued','dispatching','steering','unknown')";
    const closed =
      receiptTurnIds?.length === 0
        ? " UNION ALL SELECT * FROM opencraft_host_queue WHERE thread_id=? AND state='closed' AND paused_reason='delivery-retry-requested'"
        : " UNION ALL SELECT * FROM opencraft_host_queue WHERE thread_id=? AND state='closed'" +
          (receiptTurnIds === undefined ? "" : ` AND target_turn_id IN (${receiptTurnIds.map(() => "?").join(",")})`);
    return this.db
      .prepare(open + closed + " ORDER BY position,created_at_ms,id")
      .all(threadId, ...(closed ? [threadId, ...(receiptTurnIds ?? [])] : []))
      .map((row) => this.project(row));
  }

  observationCount(threadId: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM opencraft_host_queue WHERE thread_id=? AND ((state IN ('queued','dispatching','unknown') AND NOT EXISTS (SELECT 1 FROM opencraft_turn_delivery t WHERE t.thread_id=opencraft_host_queue.thread_id AND t.turn_id=opencraft_host_queue.target_turn_id)) OR (state='closed' AND paused_reason='delivery-retry-requested'))",
        )
        .get(threadId)!.n,
    );
  }

  maintenanceCounts(): { queued: number; inFlightKeys: string[]; unknown: number } {
    const row = this.db
      .prepare(
        "SELECT sum(state='queued') AS queued, sum(state='unknown' OR (state='closed' AND paused_reason='delivery-retry-requested')) AS unknown FROM opencraft_host_queue WHERE NOT EXISTS (SELECT 1 FROM opencraft_turn_delivery t WHERE t.thread_id=opencraft_host_queue.thread_id AND t.turn_id=opencraft_host_queue.target_turn_id) OR (state='closed' AND paused_reason='delivery-retry-requested')",
      )
      .get()!;
    const sending = this.db
      .prepare(
        "SELECT thread_id, client_id FROM opencraft_host_queue WHERE state IN ('dispatching','steering') AND NOT EXISTS (SELECT 1 FROM opencraft_turn_delivery t WHERE t.thread_id=opencraft_host_queue.thread_id AND t.turn_id=opencraft_host_queue.target_turn_id)",
      )
      .all();
    return {
      queued: Number(row.queued),
      unknown: Number(row.unknown),
      inFlightKeys: sending.map((input) => JSON.stringify(["input", input.thread_id, input.client_id])),
    };
  }

  pendingThreads(): string[] {
    return this.db
      .prepare(
        "SELECT DISTINCT thread_id FROM opencraft_host_queue WHERE ((state IN ('queued','dispatching','steering','unknown') AND NOT EXISTS (SELECT 1 FROM opencraft_turn_delivery t WHERE t.thread_id=opencraft_host_queue.thread_id AND t.turn_id=opencraft_host_queue.target_turn_id)) OR (state='closed' AND paused_reason='delivery-retry-requested'))",
      )
      .all()
      .map((row) => requiredText(row.thread_id, "thread id"));
  }

  /** Settled input history for one thread (delivered vs discarded rows). */
  inputOutcomes(threadId: string): { delivered: number; discarded: number } {
    const row = this.db
      .prepare(
        "SELECT coalesce(sum(state IN ('delivered','closed')),0) AS delivered, coalesce(sum(state='discarded'),0) AS discarded FROM opencraft_host_queue WHERE thread_id=?",
      )
      .get(threadId)!;
    return { delivered: Number(row.delivered), discarded: Number(row.discarded) };
  }

  firstUnsettled(threadId: string): QueuedSubmission<S> | null {
    return this.list(threadId, []).find((row) => !inputExecutionEnded(row.delivery)) ?? null;
  }

  firstAwaitingAdmission(threadId: string): QueuedSubmission<S> | null {
    const row = this.db
      .prepare(
        `SELECT * FROM opencraft_host_queue WHERE thread_id=? AND (state IN ('queued','dispatching') OR (state='unknown' AND COALESCE(paused_reason,'')!='execution-interrupted' AND (${this.owned} OR paused_reason='execution-fault-unconfirmed')))
      AND NOT EXISTS (SELECT 1 FROM opencraft_turn_delivery t WHERE t.thread_id=opencraft_host_queue.thread_id AND t.turn_id=opencraft_host_queue.target_turn_id)
      ORDER BY position,created_at_ms,id LIMIT 1`,
      )
      .get(threadId);
    return row ? this.project(row) : null;
  }

  update(threadId: string, id: string, input: readonly unknown[]): QueuedSubmission<S> | null {
    parseInput(input);
    const result = this.db
      .prepare(
        "UPDATE opencraft_host_queue SET input_json=?,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'",
      )
      .run(JSON.stringify(input), Date.now(), threadId, id);
    return result.changes === 1 ? this.row(threadId, id) : null;
  }

  delete(threadId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'",
        )
        .run(Date.now(), threadId, id).changes === 1
    );
  }

  reorder(threadId: string, ids: readonly string[]): void {
    const unsettled = this.list(threadId, []);
    if (
      unsettled.some(
        (row) =>
          row.state === "dispatching" ||
          (row.state === "unknown" &&
            (this.ownerReconciled(row.clientUserMessageId) || row.pausedReason === "execution-fault-unconfirmed")),
      )
    )
      throw new Error("Reconcile in-flight delivery before reordering this queue");
    const queued = unsettled.filter((row) => row.state === "queued");
    if (
      ids.length !== queued.length ||
      new Set(ids).size !== ids.length ||
      queued.some((row) => !ids.includes(row.id))
    ) {
      throw new Error("Queue order must contain each queued item exactly once");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        "UPDATE opencraft_host_queue SET position=?,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'",
      );
      for (const [index, id] of ids.entries()) update.run(index + 1, Date.now(), threadId, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(threadId: string, id: string, targetTurnId: string | null): QueuedSubmission<S> | null {
    return this.atomic(() => {
      if (
        targetTurnId &&
        this.db
          .prepare("SELECT 1 FROM opencraft_turn_delivery WHERE thread_id=? AND turn_id=?")
          .get(threadId, targetTurnId)
      )
        return null;
      const result = this.db
        .prepare(
          "UPDATE opencraft_host_queue SET state='dispatching',target_turn_id=?,paused_reason=NULL,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'",
        )
        .run(targetTurnId, Date.now(), threadId, id);
      if (result.changes === 1) this.deliveries.attempting(threadId, this.row(threadId, id)!.clientUserMessageId);
      return result.changes === 1 ? this.row(threadId, id) : null;
    });
  }

  settle(
    threadId: string,
    id: string,
    state: "queued" | "steering" | "unknown" | "delivered" | "discarded",
    reason: string | null = null,
    turnId: string | null = null,
  ): boolean {
    return this.atomic(() => {
      const row = this.row(threadId, id);
      if (!row) return false;
      const changed =
        this.db
          .prepare(
            "UPDATE opencraft_host_queue SET state=CASE WHEN state='closed' THEN 'closed' ELSE ? END,paused_reason=CASE WHEN state='closed' THEN NULL WHEN ?='unknown' AND paused_reason IN ('execution-fault-unconfirmed','execution-interrupted') THEN paused_reason ELSE ? END,target_turn_id=CASE WHEN state='closed' THEN target_turn_id WHEN ?='queued' THEN NULL ELSE COALESCE(?,target_turn_id) END,updated_at_ms=? WHERE thread_id=? AND id=? AND state IN ('dispatching','steering','unknown','closed')",
          )
          .run(state, state, reason, state, turnId, Date.now(), threadId, id).changes === 1;
      if (changed && state === "delivered")
        this.db
          .prepare("UPDATE opencraft_host_queue SET state='delivered' WHERE thread_id=? AND id=?")
          .run(threadId, id);
      if (changed && state !== "discarded")
        this.deliveries.admission(
          threadId,
          row.clientUserMessageId,
          state === "steering" || state === "delivered" ? "accepted" : state === "unknown" ? "unknown" : "rejected",
        );
      return changed;
    });
  }

  /** Unknown work is retained. Only confirmed source exit permits later, explicit new inputs. */
  interruptExecution(threadId: string, recovered: boolean): void {
    this.atomic(() => {
      if (!recovered)
        for (const row of this.db
          .prepare(
            "SELECT client_id FROM opencraft_host_queue WHERE thread_id=? AND state IN ('dispatching','steering','unknown')",
          )
          .all(threadId))
          this.deliveries.admission(threadId, String(row.client_id), "unknown");
      if (recovered)
        this.db
          .prepare(
            "UPDATE opencraft_host_queue SET paused_reason='execution-interrupted',updated_at_ms=? WHERE thread_id=? AND state='unknown' AND paused_reason='execution-fault-unconfirmed'",
          )
          .run(Date.now(), threadId);
      else
        this.db
          .prepare(
            "UPDATE opencraft_host_queue SET state='unknown',paused_reason='execution-fault-unconfirmed',updated_at_ms=? WHERE thread_id=? AND state IN ('dispatching','steering','unknown') AND COALESCE(paused_reason,'') NOT IN ('execution-fault-unconfirmed','execution-interrupted')",
          )
          .run(Date.now(), threadId);
    });
  }

  requestRetry(threadId: string, id: string, expectedTurnId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE opencraft_host_queue SET paused_reason='delivery-retry-requested',updated_at_ms=? WHERE thread_id=? AND id=? AND state='unknown' AND target_turn_id=? AND NOT (${this.owned}) AND COALESCE(paused_reason,'')!='execution-fault-unconfirmed'`,
        )
        .run(Date.now(), threadId, id, expectedTurnId).changes === 1
    );
  }

  /** Consume an explicit retry only after exact terminal proof and final history absence.
   * The caller performs the history read; the transaction rechecks durable custody. */
  resumeRequestedRetry(threadId: string, id: string): boolean {
    return this.atomic(() => {
      const row = this.row(threadId, id);
      if (!row || row.pausedReason !== "delivery-retry-requested" || this.ownerReconciled(row.clientUserMessageId))
        return false;
      if (row.delivery?.nativeAdmission === "accepted" || row.delivery?.context === "recorded") {
        this.db
          .prepare(
            "UPDATE opencraft_host_queue SET paused_reason=NULL,updated_at_ms=? WHERE thread_id=? AND id=? AND paused_reason='delivery-retry-requested'",
          )
          .run(Date.now(), threadId, id);
        return false;
      }
      if (!inputExecutionEnded(row.delivery)) return false;
      const changed =
        this.db
          .prepare(
            "UPDATE opencraft_host_queue SET state='queued',paused_reason=NULL,target_turn_id=NULL,updated_at_ms=? WHERE thread_id=? AND id=? AND state IN ('closed','unknown') AND paused_reason='delivery-retry-requested'",
          )
          .run(Date.now(), threadId, id).changes === 1;
      if (changed) this.deliveries.attempting(threadId, row.clientUserMessageId);
      return changed;
    });
  }

  discardUnknown(threadId: string, id: string, expectedTurnId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND id=? AND state='unknown' AND target_turn_id=?",
        )
        .run(Date.now(), threadId, id, expectedTurnId).changes === 1
    );
  }

  discardThread(threadId: string): number {
    return Number(
      this.db
        .prepare(
          "UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND state IN ('queued','dispatching','steering','unknown','closed')",
        )
        .run(Date.now(), threadId).changes,
    );
  }
}
