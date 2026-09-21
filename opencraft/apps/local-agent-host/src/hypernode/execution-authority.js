// Source copy: ref/hypernode/policy/src/services/thread-execution.js
import { randomUUID as uuidV4 } from "node:crypto";
const TERMINAL_EXECUTION_STATES = new Set(["completed", "failed", "interrupted", "orphaned"]);

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

/**
 * Durable control-plane journal for Turn execution attempts.
 *
 * This deliberately stores no socket/connection object and no AppServer item
 * projection.  It is fencing and recovery evidence only; the engine-native
 * ledger remains the authority for model/tool history.
 */
export class ThreadExecutionJournal {
  constructor(storage, { bootId = uuidV4(), now = Date.now } = {}) {
    this.storage = storage;
    this.bootId = bootId;
    this.now = now;
    this.available = storage?.available === true && storage?.sql != null;
    if (this.available) this.initializeSchema();
  }

  initializeSchema() {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_execution_epochs (
        thread_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_turn_execution_attempts (
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
      )
    `);
    this.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_turn_execution_thread_epoch
      ON hypernode_turn_execution_attempts(thread_id, epoch)
    `);
  }

  loadEpochs() {
    if (!this.available) return [];
    return this.storage.sql.exec(`
      SELECT thread_id, epoch FROM hypernode_thread_execution_epochs
    `).toArray().map((row) => ({ threadId: row.thread_id, epoch: row.epoch }));
  }

  nativeHistory(threadId) {
    if (!this.available) return { available: false, attempts: 0, nativeStarts: 0 };
    const row = this.storage.sql.exec(`
      SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN native_turn_id IS NOT NULL AND native_turn_id <> '' THEN 1 ELSE 0 END)
          AS native_starts
      FROM hypernode_turn_execution_attempts
      WHERE thread_id = ?
    `, threadId).toArray()[0];
    return {
      available: true,
      attempts: Number(row?.attempts ?? 0),
      nativeStarts: Number(row?.native_starts ?? 0),
    };
  }

  /**
   * A process restart cannot prove that an in-memory connection or Runtime is
   * still authoritative. Fence every non-terminal attempt from an older boot;
   * DSH/Codex native recovery will independently close or resume its ledger.
   */
  fencePreviousBoot() {
    if (!this.available) return [];
    const rows = this.storage.sql.exec(`
      SELECT execution_id, thread_id, epoch, turn_id, runtime_id, state
      FROM hypernode_turn_execution_attempts
      WHERE state NOT IN ('completed', 'failed', 'interrupted', 'orphaned')
        AND owner_boot_id <> ?
    `, this.bootId).toArray();
    if (rows.length === 0) return [];
    const at = this.now();
    this.storage.transactionSync(() => {
      for (const row of rows) this.storage.sql.exec(`
        UPDATE hypernode_turn_execution_attempts
        SET state = 'orphaned', updated_at_ms = ?, terminal_at_ms = ?,
            terminal_reason = 'policyProcessRestarted'
        WHERE execution_id = ?
      `, at, at, row.execution_id);
    });
    return rows.map((row) => ({
      executionId: row.execution_id,
      threadId: row.thread_id,
      epoch: row.epoch,
      turnId: row.turn_id ?? null,
      runtimeId: row.runtime_id ?? null,
      previousState: row.state,
      state: "orphaned",
    }));
  }

  recoverableOrphans() {
    if (!this.available) return [];
    return this.storage.sql.exec(`
      SELECT execution_id, thread_id, epoch, turn_id, runtime_id, state
      FROM hypernode_turn_execution_attempts
      WHERE state = 'orphaned' AND turn_id IS NOT NULL AND turn_id <> ''
      ORDER BY terminal_at_ms, started_at_ms
    `).toArray().map((row) => ({
      executionId: row.execution_id,
      threadId: row.thread_id,
      epoch: row.epoch,
      turnId: row.turn_id,
      runtimeId: row.runtime_id ?? null,
      state: row.state,
    }));
  }

  claim(execution) {
    if (!this.available) return;
    const at = this.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        INSERT INTO hypernode_thread_execution_epochs(thread_id, epoch) VALUES(?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET epoch = MAX(epoch, excluded.epoch)
      `, execution.threadId, execution.epoch);
      this.storage.sql.exec(`
        INSERT INTO hypernode_turn_execution_attempts(
          execution_id, thread_id, epoch, request_id, turn_id,
          actor_user_id, actor_username, account_identity, execution_profile_json,
          runtime_id, native_turn_id, state, owner_boot_id,
          started_at_ms, updated_at_ms, terminal_at_ms, terminal_reason
        ) VALUES(?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 'admitted', ?, ?, ?, NULL, NULL)
      `,
      execution.executionId, execution.threadId, execution.epoch,
      execution.requestId == null ? null : String(execution.requestId),
      execution.actorUserId ?? null, execution.actorUsername ?? null,
      execution.accountIdentity ?? null, json(execution.executionProfile),
      this.bootId, execution.startedAtMs, at);
    });
  }

  update(execution, state = execution.state ?? "dispatching") {
    if (!this.available) return;
    this.storage.sql.exec(`
      UPDATE hypernode_turn_execution_attempts SET
        turn_id = ?, runtime_id = ?, native_turn_id = ?, state = ?, updated_at_ms = ?
      WHERE execution_id = ? AND epoch = ?
    `,
    execution.turnId ?? null, execution.runtimeId ?? null,
    execution.nativeTurnId ?? null, state, this.now(),
    execution.executionId, execution.epoch);
  }

  terminal(execution, state, reason) {
    if (!this.available) return;
    if (!TERMINAL_EXECUTION_STATES.has(state)) throw new Error(`invalid terminal execution state ${state}`);
    const at = this.now();
    this.storage.sql.exec(`
      UPDATE hypernode_turn_execution_attempts SET
        state = ?, updated_at_ms = ?, terminal_at_ms = ?, terminal_reason = ?
      WHERE execution_id = ? AND epoch = ?
    `, state, at, at, String(reason ?? state), execution.executionId, execution.epoch);
  }
}

export class ThreadExecutionTable {
  constructor({ createId = uuidV4 } = {}) {
    this.createId = createId;
    this.executions = new Map();
    this.epochs = new Map();
    // The latest runtime incarnation is retained after a turn completes.  It
    // is routing/fencing evidence, not ownership of the durable thread.
    this.runtimeAuthorities = new Map();
  }

  claim(threadId, credential, connection, requestId, now = Date.now(), executionProfile = null) {
    const current = this.executions.get(threadId);
    if (current) return { acquired: false, execution: current };
    const epoch = (this.epochs.get(threadId) ?? 0) + 1;
    this.epochs.set(threadId, epoch);
    const execution = {
      threadId,
      epoch,
      executionId: this.createId(),
      requestId: requestId ?? null,
      turnId: null,
      accountIdentity: credential.accountIdentity,
      actorUserId: credential.userId,
      actorUsername: credential.username,
      executionProfile,
      connection,
      state: "admitted",
      startedAtMs: now,
    };
    this.executions.set(threadId, execution);
    return { acquired: true, execution };
  }

  bindTurn(threadId, connection, turnId, epoch = undefined) {
    const execution = this.executions.get(threadId);
    if (!execution || execution.connection !== connection) return null;
    if (epoch !== undefined && execution.epoch !== epoch) return null;
    if (typeof turnId === "string" && turnId) execution.turnId = turnId;
    // Codex may publish turn/started before the turn/start RPC response. A
    // late response may fill the outer turn id, but can never move a native
    // running attempt backwards to dispatching.
    if (execution.state !== "running") execution.state = "dispatching";
    return execution;
  }

  bindRuntime(threadId, connection, runtimeId, innerThreadId, epoch = undefined, runtimeFingerprint = null) {
    const execution = this.executions.get(threadId);
    if (!execution || execution.connection !== connection) return null;
    if (epoch !== undefined && execution.epoch !== epoch) return null;
    if (typeof runtimeId !== "string" || !runtimeId) return null;
    if (execution.executionProfile?.fingerprint && runtimeFingerprint &&
        execution.executionProfile.fingerprint !== runtimeFingerprint) return null;
    execution.runtimeId = runtimeId;
    execution.innerThreadId = typeof innerThreadId === "string" ? innerThreadId : null;
    const authority = {
      threadId,
      epoch: execution.epoch,
      runtimeId: execution.runtimeId,
      innerThreadId: execution.innerThreadId,
      accountIdentity: execution.accountIdentity,
    };
    if (execution.executionProfile) authority.executionProfile = execution.executionProfile;
    const fingerprint = runtimeFingerprint ?? execution.executionProfile?.fingerprint ?? null;
    if (fingerprint) authority.runtimeFingerprint = fingerprint;
    this.runtimeAuthorities.set(threadId, authority);
    return execution;
  }

  markNativeStarted(threadId, connection, nativeTurnId, epoch = undefined) {
    const execution = this.executions.get(threadId);
    if (!execution || execution.connection !== connection) return null;
    if (epoch !== undefined && execution.epoch !== epoch) return null;
    if (typeof nativeTurnId !== "string" || !nativeTurnId) return null;
    execution.nativeTurnId = nativeTurnId;
    execution.state = "running";
    return execution;
  }

  finish(threadId, { connection = null, requestId = undefined, turnId = undefined, epoch = undefined } = {}) {
    const execution = this.executions.get(threadId);
    if (!execution) return null;
    if (connection && execution.connection !== connection) return null;
    if (epoch !== undefined && execution.epoch !== epoch) return null;
    if (requestId !== undefined && execution.requestId !== requestId) return null;
    if (turnId !== undefined && execution.turnId !== turnId) return null;
    this.executions.delete(threadId);
    return execution;
  }

  get(threadId) {
    return this.executions.get(threadId) ?? null;
  }

  values() {
    return this.executions.values();
  }

  latestEpoch(threadId) {
    return this.epochs.get(threadId) ?? null;
  }

  seedEpoch(threadId, epoch) {
    const value = Number(epoch);
    if (!Number.isSafeInteger(value) || value < 0) return this.latestEpoch(threadId);
    const current = this.epochs.get(threadId) ?? 0;
    if (value > current) this.epochs.set(threadId, value);
    return this.latestEpoch(threadId);
  }

  runtimeAuthority(threadId) {
    return this.runtimeAuthorities.get(threadId) ?? null;
  }

  finishRuntime(runtimeId) {
    if (typeof runtimeId !== "string" || !runtimeId) return [];
    const finished = [];
    for (const [threadId, execution] of this.executions) {
      if (execution.runtimeId !== runtimeId) continue;
      this.executions.delete(threadId);
      finished.push(execution);
    }
    return finished;
  }

  clearThread(threadId) {
    this.executions.delete(threadId);
    this.runtimeAuthorities.delete(threadId);
  }
}
