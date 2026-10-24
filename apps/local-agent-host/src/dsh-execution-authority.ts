import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { ThreadExecutionJournal, ThreadExecutionTable } from "./hypernode/execution-authority.js";
import { ThreadWriteLeaseTable } from "./hypernode/write-lease.js";
import type { DshEvent } from "./dsh-client.js";
import { ThreadQueueStore } from "./hypernode/thread-queue.js";

export const DSH_EXECUTION_BASELINE = `
CREATE TABLE opencraft_execution_inputs (
  execution_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, native_rpc_id TEXT NOT NULL UNIQUE,
  client_message_id TEXT, actor_id TEXT NOT NULL
);
CREATE TABLE opencraft_queue_inputs (
  native_rpc_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
  request_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_username TEXT NOT NULL, connection_id TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE hypernode_thread_execution_epochs (
  thread_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL
);
CREATE TABLE hypernode_turn_execution_attempts (
  execution_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  request_id TEXT,
  turn_id TEXT,
  actor_user_id TEXT,
  actor_username TEXT,
  account_identity TEXT,
  execution_profile_json TEXT,
  runtime_id TEXT,
  native_turn_id TEXT,
  state TEXT NOT NULL,
  owner_boot_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  terminal_at_ms INTEGER,
  terminal_reason TEXT
);
CREATE INDEX hypernode_turn_execution_thread_epoch
ON hypernode_turn_execution_attempts(thread_id, epoch);
CREATE TABLE hypernode_thread_queue_submissions (
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  client_user_message_id TEXT NOT NULL,
  actor_user_id TEXT,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(thread_id, submission_id),
  UNIQUE(thread_id, client_user_message_id)
);
CREATE INDEX hypernode_thread_queue_pending
ON hypernode_thread_queue_submissions(thread_id, state, position);
CREATE INDEX hypernode_thread_queue_actor
ON hypernode_thread_queue_submissions(actor_user_id, state);
CREATE TABLE hypernode_thread_queue_state (
  thread_id TEXT PRIMARY KEY,
  paused_reason TEXT,
  updated_at_ms INTEGER NOT NULL
);
`.trim();

export interface DshExecutionOwner {
  readonly connectionId: string;
  readonly identity: { readonly id: string; readonly username: string };
}
export interface DshAdmission {
  readonly threadId: string;
  readonly epoch: number;
  readonly executionId: string;
  readonly connection: DshExecutionOwner;
  readonly requestId: string | number;
}

/** Source-owned execution/lease policy; SQLite is only a local storage port. */
export class DshExecutionAuthority {
  readonly table = new ThreadExecutionTable();
  readonly leases = new ThreadWriteLeaseTable();
  readonly journal: ThreadExecutionJournal;
  readonly queueStore: ThreadQueueStore;
  readonly recoveredOrphans: readonly any[];
  readonly outcome: DatabaseOutcome;
  private readonly database: DatabaseSync;
  private readonly disconnected = new WeakSet<object>();
  private readonly editing = new Map<string, { owner: DshExecutionOwner; count: number }>();
  constructor(path: string, bootId?: string) {
    const managed = openManagedDatabase({
      path,
      migrations: [{ version: 1, name: "executions", sql: DSH_EXECUTION_BASELINE }],
      legacyMigration: createMissingLegacyObjects(DSH_EXECUTION_BASELINE),
    });
    this.database = managed.database;
    this.outcome = managed.outcome;
    const storage = {
      available: true,
      sql: { exec: (sql: string, ...args: any[]) => {
        const statement = this.database.prepare(sql);
        if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { toArray: () => statement.all(...args) };
        statement.run(...args);
        return { toArray: () => [] };
      } },
      transactionSync: (operation: () => void) => {
        this.database.exec("BEGIN IMMEDIATE");
        try { operation(); this.database.exec("COMMIT"); }
        catch (error) { this.database.exec("ROLLBACK"); throw error; }
      },
    };
    this.journal = new ThreadExecutionJournal(storage, { ...(bootId ? { bootId } : {}) });
    this.queueStore = new ThreadQueueStore(storage);
    this.recoveredOrphans = this.journal.fencePreviousBoot();
    for (const entry of this.journal.loadEpochs()) this.table.seedEpoch(entry.threadId, entry.epoch);
  }
  claim(threadId: string, owner: DshExecutionOwner, requestId: string | number): DshAdmission {
    this.assertConnected(owner);
    return this.claimExecution(threadId, owner, requestId);
  }
  /** A proven native continuation outlives its originating socket. Only the
   * admission gate may call this after validating a Goal or owned job proof. */
  claimContinuation(threadId: string, owner: DshExecutionOwner, requestId: string | number): DshAdmission {
    return this.claimExecution(threadId, owner, requestId);
  }
  claimGoalContinuation(threadId: string, owner: DshExecutionOwner, requestId: string | number): DshAdmission {
    return this.claimContinuation(threadId, owner, requestId);
  }
  private claimExecution(threadId: string, owner: DshExecutionOwner, requestId: string | number): DshAdmission {
    const lease = this.leases.acquire(threadId, owner, "executing");
    if (!lease.acquired) throw new Error("Thread write lease belongs to another connection");
    const result = this.table.claim(threadId, {
      userId: owner.identity.id, username: owner.identity.username, accountIdentity: owner.identity.id,
    }, owner, requestId);
    if (!result.acquired) throw new Error("Thread already has an admitted execution");
    try { this.journal.claim(result.execution); }
    catch (error) {
      this.table.finish(threadId, { connection: owner, epoch: result.execution.epoch });
      this.leases.release(threadId, owner);
      throw error;
    }
    return result.execution;
  }
  nativeStarted(admission: DshAdmission, turnId: string, nativeTurnId: string): boolean {
    const execution = this.table.bindTurn(admission.threadId, admission.connection, turnId, admission.epoch);
    if (!execution) return false;
    if (!this.table.markNativeStarted(admission.threadId, admission.connection, nativeTurnId, admission.epoch)) return false;
    this.journal.update(execution, "running");
    return true;
  }
  rememberInput(admission: DshAdmission, rpcId: string, clientMessageId?: string): void {
    this.database.prepare("INSERT INTO opencraft_execution_inputs VALUES (?, ?, ?, ?, ?)").run(
      admission.executionId, admission.threadId, rpcId, clientMessageId ?? null, admission.connection.identity.id,
    );
  }
  /** Durable occurrence identity; absence is the only safe permission to submit. */
  scheduleInput(threadId: string, clientMessageId: string) {
    const row = this.database.prepare(`SELECT e.state, e.turn_id FROM opencraft_execution_inputs i
      JOIN hypernode_turn_execution_attempts e ON e.execution_id=i.execution_id
      WHERE i.thread_id=? AND i.client_message_id=? ORDER BY e.started_at_ms DESC LIMIT 1`).get(threadId, clientMessageId);
    return row ? { state: String(row.state), turnId: typeof row.turn_id === "string" ? row.turn_id : undefined } : null;
  }
  projectInput(threadId: string, event: DshEvent): DshEvent {
    if (event.type !== "user/message") return event;
    const data = event.data as Record<string, any> | null;
    if (!data || typeof data.source?.rpcId !== "string") return event;
    const queued = this.database.prepare("SELECT consumed FROM opencraft_queue_inputs WHERE thread_id=? AND native_rpc_id=?").get(threadId, data.source.rpcId);
    if (queued?.consumed === 0) this.consumeQueueInput(data.source.rpcId);
    const row = this.database.prepare(
      "SELECT client_message_id FROM opencraft_execution_inputs WHERE thread_id = ? AND native_rpc_id = ?",
    ).get(threadId, data.source.rpcId) ?? this.database.prepare(
      "SELECT client_message_id FROM opencraft_queue_inputs WHERE thread_id = ? AND native_rpc_id = ?",
    ).get(threadId, data.source.rpcId);
    if (typeof row?.client_message_id !== "string") return event;
    return { ...event, data: { ...data, source: { ...data.source, rpcId: row.client_message_id } } };
  }
  queueInput(rpcId: string, threadId: string, owner: DshExecutionOwner, requestId: string | number, clientMessageId: string) {
    this.database.prepare("INSERT INTO opencraft_queue_inputs VALUES(?,?,?,?,?,?,?,0)").run(
      rpcId, threadId, clientMessageId, String(requestId), owner.identity.id, owner.identity.username, owner.connectionId,
    );
  }
  queuedInputs() {
    return this.database.prepare("SELECT * FROM opencraft_queue_inputs WHERE consumed=0").all().map((row: any) => ({
      rpcId: row.native_rpc_id, threadId: row.thread_id, requestId: row.request_id, clientMessageId: row.client_message_id,
      owner: { connectionId: row.connection_id, identity: { id: row.owner_id, username: row.owner_username } },
    }));
  }
  consumeQueueInput(rpcId: string) {
    const row = this.database.prepare("SELECT thread_id, client_message_id FROM opencraft_queue_inputs WHERE native_rpc_id=?").get(rpcId);
    if (row) {
      const submission = this.queueStore.findByClientId(String(row.thread_id), String(row.client_message_id));
      if (submission) this.queueStore.markDispatched(String(row.thread_id), submission.id);
    }
    this.database.prepare("UPDATE opencraft_queue_inputs SET consumed=1 WHERE native_rpc_id=?").run(rpcId);
  }
  assertOwner(threadId: string, owner: DshExecutionOwner, turnId?: string): DshAdmission {
    this.assertConnected(owner);
    const execution = this.table.get(threadId);
    if (!execution || execution.connection !== owner || (turnId && execution.turnId !== turnId)) {
      throw new Error("Execution authority does not belong to this connection/Turn");
    }
    return execution;
  }
  async withWriteLease<T>(threadId: string, owner: DshExecutionOwner, operation: () => Promise<T>): Promise<T> {
    this.assertConnected(owner);
    const execution = this.table.get(threadId);
    if (execution) {
      this.assertOwner(threadId, owner);
      return operation();
    }
    const acquired = this.leases.acquire(threadId, owner, "editing");
    if (!acquired.acquired) throw new Error("Thread write lease belongs to another connection");
    const hold = this.editing.get(threadId) ?? { owner, count: 0 };
    if (hold.owner !== owner) throw new Error("Thread editing lease changed");
    hold.count++;
    this.editing.set(threadId, hold);
    try { return await operation(); }
    finally {
      if (--hold.count === 0) {
        this.editing.delete(threadId);
        if (!this.table.get(threadId)) this.leases.release(threadId, owner);
      }
    }
  }
  finish(admission: DshAdmission, state: "completed" | "failed" | "interrupted" | "orphaned", reason: string): boolean {
    const current = this.table.get(admission.threadId);
    if (!current || current.epoch !== admission.epoch || current.connection !== admission.connection) return false;
    this.journal.terminal(current, state, reason);
    this.table.finish(admission.threadId, { connection: admission.connection, epoch: admission.epoch });
    this.leases.release(admission.threadId, admission.connection);
    return true;
  }
  reconnect(threadId: string, owner: DshExecutionOwner): boolean {
    const execution = this.table.get(threadId);
    if (!execution || execution.connection === owner) return false;
    const previous = execution.connection as DshExecutionOwner;
    if (!this.disconnected.has(previous) || previous.identity.id !== owner.identity.id) return false;
    const lease = this.leases.get(threadId);
    if (lease && lease.connection !== previous) throw new Error("Thread lease changed during reconnect");
    this.leases.release(threadId, previous);
    if (!this.leases.acquire(threadId, owner, "executing").acquired) throw new Error("Unable to reclaim disconnected execution lease");
    execution.connection = owner;
    this.journal.update(execution, execution.state);
    return true;
  }
  assertConnected(owner: DshExecutionOwner): void {
    if (this.disconnected.has(owner)) throw new Error("Execution authority owner has disconnected");
  }
  disconnect(owner: DshExecutionOwner): void { this.disconnected.add(owner); this.leases.disconnect(owner); }
  close(): void { this.database.close(); }
}
