import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type QueueState = "queued" | "dispatching" | "steering" | "unknown" | "delivered" | "discarded";

export interface HostQueuedSubmission {
  readonly id: string;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly input: readonly unknown[];
  readonly position: number;
  readonly createdAt: number;
  readonly state: QueueState;
  readonly targetTurnId: string | null;
  readonly pausedReason: string | null;
}

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

function fromRow(row: Record<string, unknown>): HostQueuedSubmission {
  return {
    id: requiredText(row.id, "queue id"),
    threadId: requiredText(row.thread_id, "thread id"),
    clientUserMessageId: requiredText(row.client_id, "client message id"),
    input: parseInput(JSON.parse(requiredText(row.input_json, "queue input"))),
    position: Number(row.position),
    createdAt: Number(row.created_at_ms),
    state: row.state as QueueState,
    targetTurnId: typeof row.target_turn_id === "string" ? row.target_turn_id : null,
    pausedReason: typeof row.paused_reason === "string" ? row.paused_reason : null,
  };
}

export class OpenCraftHostQueue {
  private readonly db: DatabaseSync;
  private readonly owner: OpenCraftHostStateDatabase | null;
  readonly outcome: DatabaseOutcome | undefined;

  constructor(dataDirectory: string, database?: DatabaseSync) {
    this.owner = database === undefined ? new OpenCraftHostStateDatabase(dataDirectory) : null;
    this.db = database ?? this.owner!.database;
    this.outcome = this.owner?.outcome;
    this.db.prepare("UPDATE opencraft_host_queue SET state='unknown', paused_reason='steer-delivery-unconfirmed', updated_at_ms=? WHERE state='dispatching'").run(Date.now());
  }

  close(): void { this.owner?.close(); }

  private row(threadId: string, id: string): HostQueuedSubmission | null {
    const row = this.db.prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND id=?").get(threadId, id);
    return row ? fromRow(row) : null;
  }

  find(threadId: string, id: string): HostQueuedSubmission | null { return this.row(threadId, id); }

  findByClientId(threadId: string, clientId: string): HostQueuedSubmission | null {
    const row = this.db.prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND client_id=?").get(threadId, clientId);
    return row ? fromRow(row) : null;
  }

  add(threadId: string, clientId: string, input: readonly unknown[]): HostQueuedSubmission {
    requiredText(threadId, "thread id");
    requiredText(clientId, "client message id");
    parseInput(input);
    const existing = this.findByClientId(threadId, clientId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("Client message id already belongs to different input");
      return existing;
    }
    const now = Date.now();
    const position = Number((this.db.prepare("SELECT COALESCE(MAX(position), 0) AS position FROM opencraft_host_queue WHERE thread_id=?").get(threadId) as { position: number }).position) + 1;
    const id = randomUUID();
    this.db.prepare("INSERT INTO opencraft_host_queue(id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state) VALUES(?,?,?,?,?,?,?,'queued')")
      .run(id, threadId, clientId, JSON.stringify(input), position, now, now);
    return this.row(threadId, id)!;
  }

  list(threadId: string): HostQueuedSubmission[] {
    return this.db.prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND state IN ('queued','dispatching','steering','unknown') ORDER BY position,created_at_ms,id")
      .all(threadId).map(fromRow);
  }

  observationCount(threadId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM opencraft_host_queue WHERE thread_id=? AND state IN ('queued','dispatching','unknown')").get(threadId)!.n);
  }

  pendingThreads(): string[] {
    return this.db.prepare("SELECT DISTINCT thread_id FROM opencraft_host_queue WHERE state IN ('queued','dispatching','steering','unknown')")
      .all().map(row => requiredText(row.thread_id, "thread id"));
  }

  firstUnsettled(threadId: string): HostQueuedSubmission | null { return this.list(threadId)[0] ?? null; }

  firstAwaitingAdmission(threadId: string): HostQueuedSubmission | null {
    const row = this.db.prepare("SELECT * FROM opencraft_host_queue WHERE thread_id=? AND state IN ('queued','dispatching','unknown') ORDER BY position,created_at_ms,id LIMIT 1")
      .get(threadId);
    return row ? fromRow(row) : null;
  }

  update(threadId: string, id: string, input: readonly unknown[]): HostQueuedSubmission | null {
    parseInput(input);
    const result = this.db.prepare("UPDATE opencraft_host_queue SET input_json=?,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'")
      .run(JSON.stringify(input), Date.now(), threadId, id);
    return result.changes === 1 ? this.row(threadId, id) : null;
  }

  delete(threadId: string, id: string): boolean {
    return this.db.prepare("UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'")
      .run(Date.now(), threadId, id).changes === 1;
  }

  reorder(threadId: string, ids: readonly string[]): void {
    const unsettled = this.list(threadId);
    if (unsettled.some(row => row.state === "dispatching" || row.state === "unknown"))
      throw new Error("Reconcile in-flight delivery before reordering this queue");
    const queued = unsettled.filter(row => row.state === "queued");
    if (ids.length !== queued.length || new Set(ids).size !== ids.length || queued.some(row => !ids.includes(row.id))) {
      throw new Error("Queue order must contain each queued item exactly once");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE opencraft_host_queue SET position=?,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'");
      for (const [index, id] of ids.entries()) update.run(index + 1, Date.now(), threadId, id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  claim(threadId: string, id: string, targetTurnId: string | null): HostQueuedSubmission | null {
    const result = this.db.prepare("UPDATE opencraft_host_queue SET state='dispatching',target_turn_id=?,paused_reason=NULL,updated_at_ms=? WHERE thread_id=? AND id=? AND state='queued'")
      .run(targetTurnId, Date.now(), threadId, id);
    return result.changes === 1 ? this.row(threadId, id) : null;
  }

  settle(threadId: string, id: string, state: "queued" | "steering" | "unknown" | "delivered" | "discarded", reason: string | null = null, turnId: string | null = null): boolean {
    return this.db.prepare("UPDATE opencraft_host_queue SET state=?,paused_reason=?,target_turn_id=COALESCE(?,target_turn_id),updated_at_ms=? WHERE thread_id=? AND id=? AND state IN ('dispatching','steering','unknown')")
      .run(state, reason, turnId, Date.now(), threadId, id).changes === 1;
  }

  discardUnknown(threadId: string, id: string, expectedTurnId: string): boolean {
    return this.db.prepare("UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND id=? AND state='unknown' AND target_turn_id=?")
      .run(Date.now(), threadId, id, expectedTurnId).changes === 1;
  }

  discardThread(threadId: string): number {
    return Number(this.db.prepare("UPDATE opencraft_host_queue SET state='discarded',updated_at_ms=? WHERE thread_id=? AND state IN ('queued','dispatching','steering','unknown')")
      .run(Date.now(), threadId).changes);
  }

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
