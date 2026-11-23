import type { SqlDatabase } from "@opencraft/sql";
import type { InputDeliveryReceipt } from "@opencraft/appserver-protocol";

/**
 * Per-input delivery facts beside a thread queue: native admission, context
 * observation and the first terminal outcome of the turn an input targeted.
 * The owner of the database creates `opencraft_input_delivery` and
 * `opencraft_turn_delivery` in its own migrations.
 */
export class InputDeliveryStore {
  constructor(private readonly db: SqlDatabase) {}

  register(threadId: string, clientId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO opencraft_input_delivery VALUES(?,?,'pending','unobserved',1)")
      .run(threadId, clientId);
  }

  attempting(threadId: string, clientId: string): void {
    this.register(threadId, clientId);
    this.db
      .prepare(
        "UPDATE opencraft_input_delivery SET native_admission='pending',revision=revision+1 WHERE thread_id=? AND client_id=? AND native_admission!='accepted'",
      )
      .run(threadId, clientId);
  }

  admission(threadId: string, clientId: string, value: InputDeliveryReceipt["nativeAdmission"]): void {
    this.register(threadId, clientId);
    // A late timeout cannot undo a positive receipt, nor can a late ACK reopen a Turn.
    this.db
      .prepare(
        `UPDATE opencraft_input_delivery SET native_admission=?,revision=revision+1
      WHERE thread_id=? AND client_id=? AND native_admission!=?
      AND (native_admission!='accepted' OR ?='accepted')`,
      )
      .run(value, threadId, clientId, value, value);
  }

  recorded(threadId: string, clientId: string): void {
    this.register(threadId, clientId);
    this.db
      .prepare(
        `UPDATE opencraft_input_delivery SET native_admission='accepted',context_state='recorded',revision=revision+1
      WHERE thread_id=? AND client_id=? AND context_state!='recorded'`,
      )
      .run(threadId, clientId);
  }

  finish(threadId: string, turnId: string, outcome: string): boolean {
    if (!turnId || turnId === "unknown" || !["completed", "interrupted", "failed"].includes(outcome)) return false;
    // First terminal observation is immutable. Later stale frames never resurrect it.
    return this.db.transaction(() => {
      const changed =
        this.db
          .prepare("INSERT OR IGNORE INTO opencraft_turn_delivery VALUES(?,?,?,?)")
          .run(threadId, turnId, outcome, Date.now()).changes === 1;
      this.db
        .prepare(
          `UPDATE opencraft_host_queue SET state='closed',paused_reason=CASE WHEN paused_reason='delivery-retry-requested' THEN paused_reason ELSE NULL END,updated_at_ms=?
        WHERE thread_id=? AND target_turn_id=? AND state IN ('dispatching','steering','unknown')`,
        )
        .run(Date.now(), threadId, turnId);
      return changed;
    });
  }

  receipt(threadId: string, clientId: string, targetTurnId: string | null): InputDeliveryReceipt {
    const input = this.db
      .prepare("SELECT * FROM opencraft_input_delivery WHERE thread_id=? AND client_id=?")
      .get(threadId, clientId);
    const terminal = targetTurnId
      ? this.db
          .prepare("SELECT outcome FROM opencraft_turn_delivery WHERE thread_id=? AND turn_id=?")
          .get(threadId, targetTurnId)
      : undefined;
    return {
      version: 1,
      custody: "accepted",
      nativeAdmission: (input?.native_admission ?? "pending") as InputDeliveryReceipt["nativeAdmission"],
      context: (input?.context_state ?? "unobserved") as InputDeliveryReceipt["context"],
      targetTurnId,
      execution: terminal
        ? (terminal.outcome as InputDeliveryReceipt["execution"])
        : targetTurnId && targetTurnId !== "unknown"
          ? "running"
          : "unbound",
      revision: Number(input?.revision ?? 1) + (terminal ? 1 : 0),
    };
  }
}
