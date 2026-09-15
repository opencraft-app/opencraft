import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ThreadExecutionJournal, ThreadExecutionTable } from "./hypernode/execution-authority.js";
import { ThreadWriteLeaseTable } from "./hypernode/write-lease.js";
import type { DshEvent } from "./dsh-client.js";
import { ThreadQueueStore } from "./hypernode/thread-queue.js";

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
  private readonly database: DatabaseSync;
  private readonly disconnected = new WeakSet<object>();
  private readonly editing = new Map<string, { owner: DshExecutionOwner; count: number }>();
  constructor(path: string, bootId?: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`CREATE TABLE IF NOT EXISTS opencraft_execution_inputs (
      execution_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, native_rpc_id TEXT NOT NULL UNIQUE,
      client_message_id TEXT, actor_id TEXT NOT NULL
    )`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS opencraft_queue_inputs (
      native_rpc_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      request_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_username TEXT NOT NULL, connection_id TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    )`);
    if (path !== ":memory:") chmodSync(path, 0o600);
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
    const execution = this.table.get(threadId);
    if (!execution || execution.connection !== owner || (turnId && execution.turnId !== turnId)) {
      throw new Error("Execution authority does not belong to this connection/Turn");
    }
    return execution;
  }
  async withWriteLease<T>(threadId: string, owner: DshExecutionOwner, operation: () => Promise<T>): Promise<T> {
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
  disconnect(owner: DshExecutionOwner): void { this.disconnected.add(owner); this.leases.disconnect(owner); }
  close(): void { this.database.close(); }
}
