import {
  ExecutionLeaseStore,
  executionLeaseFromRow,
  executionLeaseSelect,
  type ExecutionLease,
} from "./execution-lease-store.js";

/** WorkspaceHost-only extensions on the Durable Object's storage connection. */
export class WorkspaceExecutionLeaseStore extends ExecutionLeaseStore {
  /** This store's execution environment is confirmed gone. End its live leases while preserving uncertain outcomes and all input receipts. */
  retireLostExecutions(): void {
    this.db
      .prepare(
        `UPDATE execution_leases SET state='unknown',ended_at_ms=?,ended_at_boot_ms=?
      WHERE ended_at_ms IS NULL AND state IN ('active','pending','unknown')`,
      )
      .run(Date.now(), this.bootClock()?.at ?? null);
  }
  /** A reattaching owner must still verify the native Turn and engine incarnation. */
  unsettledLease(threadId: string): ExecutionLease | null {
    const rows = this.db
      .prepare(
        `${executionLeaseSelect} WHERE l.thread_id=? AND l.ended_at_ms IS NULL
      AND l.state IN ('active','pending','unknown') LIMIT 2`,
      )
      .all(threadId);
    const row = rows.length === 1 ? rows[0] : undefined;
    return row?.admission === "accepted" ? executionLeaseFromRow(row) : null;
  }
}
