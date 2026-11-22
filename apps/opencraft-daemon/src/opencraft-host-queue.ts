import { ThreadQueueStore, type QueuedSubmission } from "@opencraft/thread-queue";
import { ExecutionLeaseStore, type ExecutionSubmission } from "./execution-lease-store.js";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type { QueueState } from "@opencraft/thread-queue";
export type HostQueuedSubmission = QueuedSubmission<ExecutionSubmission>;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
  return value;
}

function parseInput(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Queued input must be a nonempty array of user input objects");
  }
  return value;
}

/**
 * The legacy Codex Host's queue: the shared thread queue over the Host state
 * database, with execution-lease capture, collaboration-owned inputs and the
 * one-time import of Codex's own native queue.
 */
export class OpenCraftHostQueue extends ThreadQueueStore<ExecutionSubmission> {
  private readonly owner: OpenCraftHostStateDatabase | null;
  readonly outcome: DatabaseOutcome | undefined;

  constructor(dataDirectory: string, database?: DatabaseSync, options: {recoverPending?: boolean} = {}) {
    const owner = database === undefined ? new OpenCraftHostStateDatabase(dataDirectory) : null;
    const db = database ?? owner!.database;
    super(db, {
      ...options,
      ownerReconciledPrefix: "actor-input:",
      capture: (threadId, clientId, submission, existing) => {
        const value = submission ?? { principal: null, ownership: "unowned" };
        new ExecutionLeaseStore(db).capture(threadId, clientId,
          existing && !existing.executionSubmission ? { principal: null, ownership: "unknown" } : value, "accepted", "queue");
      },
      submission: (threadId, clientId) => new ExecutionLeaseStore(db).getSubmission(threadId, clientId),
    });
    this.owner = owner;
    this.outcome = owner?.outcome;
  }

  close(): void { this.owner?.close(); }

  migrateNativeQueue(nativeDirectory: string): number {
    const path = join(nativeDirectory, "queue_1.sqlite");
    if (!existsSync(path)) return 0;
    const native = new DatabaseSync(path);
    try {
      const table = native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queued_items'").get();
      if (!table) return 0;
      const columns = native.prepare("PRAGMA table_info(queued_items)").all().map(row => String(row.name));
      const hasSteering = columns.includes("steering_turn_id");
      const rows = native.prepare(`SELECT id,thread_id,payload_json,queue_order,created_at_ms${hasSteering ? ",steering_turn_id" : ""} FROM queued_items ORDER BY thread_id,queue_order`).all();
      if (rows.length === 0) return 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const insert = this.db.prepare("INSERT OR IGNORE INTO opencraft_host_queue(id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state,target_turn_id,paused_reason) VALUES(?,?,?,?,?,?,?,?,?,?)");
        for (const row of rows) {
          const payload = JSON.parse(requiredText(row.payload_json, "native queue payload")) as { UserInput?: { content?: unknown; client_id?: unknown } };
          const user = payload.UserInput;
          const content = parseInput(user?.content);
          const clientId = requiredText(user?.client_id, "native queue client id");
          const targetTurnId = typeof row.steering_turn_id === "string" ? row.steering_turn_id : null;
          const state = targetTurnId ? "unknown" : "queued";
          insert.run(requiredText(row.id, "native queue id"), requiredText(row.thread_id, "native thread id"), clientId,
            JSON.stringify(content), Number(row.queue_order), Number(row.created_at_ms), Date.now(), state, targetTurnId,
            targetTurnId ? "steer-delivery-unconfirmed" : null);
          const imported = this.row(String(row.thread_id), String(row.id));
          if (!imported || imported.clientUserMessageId !== clientId || JSON.stringify(imported.input) !== JSON.stringify(content)) {
            throw new Error("Native queue migration conflict; refusing to start Codex");
          }
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      native.exec("BEGIN IMMEDIATE");
      try {
        const remove = native.prepare("DELETE FROM queued_items WHERE id=? AND payload_json=?");
        for (const row of rows) {
          if (remove.run(row.id as string, row.payload_json as string).changes !== 1) throw new Error("Native queue changed during migration");
        }
        native.exec("COMMIT");
      } catch (error) { native.exec("ROLLBACK"); throw error; }
      return rows.length;
    } finally { native.close(); }
  }
}
