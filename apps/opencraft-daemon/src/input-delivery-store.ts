import type { DatabaseSync } from "node:sqlite";
import type { InputDeliveryReceipt } from "@opencraft/appserver-protocol";

/** Additive v17. Existing queue rows remain the unique message/content owner. */
export const INPUT_DELIVERY_SCHEMA = `
ALTER TABLE opencraft_host_queue RENAME TO opencraft_host_queue_v16;
DROP INDEX opencraft_host_queue_order;
DROP INDEX opencraft_host_queue_state;
CREATE TABLE opencraft_host_queue (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL, input_json TEXT NOT NULL,
  position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed')),
  target_turn_id TEXT, paused_reason TEXT, UNIQUE(thread_id,client_id)
) STRICT;
INSERT INTO opencraft_host_queue SELECT * FROM opencraft_host_queue_v16;
DROP TABLE opencraft_host_queue_v16;
CREATE INDEX opencraft_host_queue_order ON opencraft_host_queue(thread_id,position,created_at_ms);
CREATE INDEX opencraft_host_queue_state ON opencraft_host_queue(state,thread_id);
CREATE INDEX opencraft_host_queue_turn ON opencraft_host_queue(thread_id,target_turn_id,state);
CREATE TABLE opencraft_input_delivery (
  thread_id TEXT NOT NULL, client_id TEXT NOT NULL,
  native_admission TEXT NOT NULL CHECK(native_admission IN ('pending','accepted','unknown','rejected')),
  context_state TEXT NOT NULL CHECK(context_state IN ('unobserved','recorded')),
  revision INTEGER NOT NULL, PRIMARY KEY(thread_id,client_id),
  FOREIGN KEY(thread_id,client_id) REFERENCES opencraft_host_queue(thread_id,client_id)
) STRICT;
CREATE TABLE opencraft_turn_delivery (
  thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','interrupted','failed')),
  observed_at_ms INTEGER NOT NULL, PRIMARY KEY(thread_id,turn_id)
) STRICT;
INSERT INTO opencraft_input_delivery(thread_id,client_id,native_admission,context_state,revision)
SELECT thread_id,client_id,CASE WHEN state IN ('steering','delivered') THEN 'accepted'
  WHEN state IN ('dispatching','unknown') THEN 'unknown' ELSE 'pending' END,'unobserved',1
FROM opencraft_host_queue;
`;

export class InputDeliveryStore {
  constructor(private readonly db: DatabaseSync) {}

  register(threadId: string, clientId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO opencraft_input_delivery VALUES(?,?,'pending','unobserved',1)",
      )
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

  admission(
    threadId: string,
    clientId: string,
    value: InputDeliveryReceipt["nativeAdmission"],
  ): void {
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
    if (
      !turnId ||
      turnId === "unknown" ||
      !["completed", "interrupted", "failed"].includes(outcome)
    )
      return false;
    // First terminal observation is immutable. Later stale frames never resurrect it.
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed =
        this.db
          .prepare(
            "INSERT OR IGNORE INTO opencraft_turn_delivery VALUES(?,?,?,?)",
          )
          .run(threadId, turnId, outcome, Date.now()).changes === 1;
      this.db
        .prepare(
          `UPDATE opencraft_host_queue SET state='closed',paused_reason=NULL,updated_at_ms=?
        WHERE thread_id=? AND target_turn_id=? AND state IN ('dispatching','steering','unknown')`,
        )
        .run(Date.now(), threadId, turnId);
      if (ownsTransaction) this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      if (ownsTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  receipt(
    threadId: string,
    clientId: string,
    targetTurnId: string | null,
  ): InputDeliveryReceipt {
    const input = this.db
      .prepare(
        "SELECT * FROM opencraft_input_delivery WHERE thread_id=? AND client_id=?",
      )
      .get(threadId, clientId);
    const terminal = targetTurnId
      ? this.db
          .prepare(
            "SELECT outcome FROM opencraft_turn_delivery WHERE thread_id=? AND turn_id=?",
          )
          .get(threadId, targetTurnId)
      : undefined;
    return {
      version: 1,
      custody: "accepted",
      nativeAdmission: (input?.native_admission ??
        "pending") as InputDeliveryReceipt["nativeAdmission"],
      context: (input?.context_state ??
        "unobserved") as InputDeliveryReceipt["context"],
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
