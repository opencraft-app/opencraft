import { Service } from "@deepseek-ai/cordis";

const DEFAULT_EDIT_TTL_MS = 20_000;
const DEFAULT_DISCONNECT_TTL_MS = 20_000;
const ACTIVITY_CONTINUITY_MS = 15 * 60_000;

const GUARDED_THREAD_METHODS = new Set([
  "thread/archive",
  "thread/fork",
  "thread/metadata/update",
  "thread/name/set",
  "thread/unarchive",
  "turn/interrupt",
]);

function principalFor(connection) {
  return connection.identity ?? {
    id: "node:root",
    username: "root",
  };
}

export function formatEditAge(editedAtMs, now = Date.now()) {
  const elapsedMs = Math.max(0, now - editedAtMs);
  if (elapsedMs < 60_000) return "不到 1 min";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)} min`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)} h`;
  return `${Math.floor(elapsedMs / 86_400_000)} d`;
}

export function editWarningMessage(edit, now = Date.now()) {
  return `此会话于 ${formatEditAge(edit.editedAtMs, now)} 前被 ${edit.editorUsername} 编辑。`;
}

export class ThreadActivityTracker {
  constructor({ continuityMs = ACTIVITY_CONTINUITY_MS } = {}) {
    this.continuityMs = continuityMs;
    this.streaks = new Map();
  }

  observe(lease, now = Date.now()) {
    const previous = this.streaks.get(lease.threadId);
    const continuous = previous?.holderPrincipalId === lease.holderPrincipalId &&
      now - previous.lastActivityAtMs <= this.continuityMs;
    const streak = {
      threadId: lease.threadId,
      holderPrincipalId: lease.holderPrincipalId,
      holderUsername: lease.holderUsername,
      activeSinceMs: continuous ? previous.activeSinceMs : now,
      lastActivityAtMs: now,
    };
    this.streaks.set(lease.threadId, streak);
    lease.activeSinceMs = streak.activeSinceMs;
    return streak;
  }
}

export class ThreadWriteLeaseTable {
  constructor({ editTtlMs = DEFAULT_EDIT_TTL_MS, disconnectTtlMs = DEFAULT_DISCONNECT_TTL_MS } = {}) {
    this.editTtlMs = editTtlMs;
    this.disconnectTtlMs = disconnectTtlMs;
    this.leases = new Map();
  }

  sweep(now = Date.now()) {
    const expired = [];
    for (const [threadId, lease] of this.leases) {
      if (lease.expiresAtMs != null && lease.expiresAtMs <= now) {
        this.leases.delete(threadId);
        expired.push(lease);
      }
    }
    return expired;
  }

  acquire(threadId, connection, phase = "editing", now = Date.now(), leaseKey = threadId) {
    this.sweep(now);
    const current = this.leases.get(leaseKey);
    if (current && current.connection !== connection) return { acquired: false, lease: current };
    const principal = principalFor(connection);
    const lease = current ?? {
      threadId,
      leaseKey,
      holderPrincipalId: principal.id,
      holderUsername: principal.username,
      connection,
      connectionId: connection.connectionId ?? null,
      acquiredAtMs: now,
    };
    lease.phase = phase;
    lease.threadId = threadId;
    lease.lastActivityAtMs = now;
    lease.expiresAtMs = phase === "editing" ? now + this.editTtlMs : null;
    this.leases.set(leaseKey, lease);
    return { acquired: true, lease };
  }

  heartbeat(threadId, connection, now = Date.now(), leaseKey = threadId) {
    this.sweep(now);
    const lease = this.leases.get(leaseKey);
    if (!lease || lease.connection !== connection) return { renewed: false, lease };
    lease.lastActivityAtMs = now;
    if (lease.phase === "editing") lease.expiresAtMs = now + this.editTtlMs;
    return { renewed: true, lease };
  }

  release(threadId, connection = null, leaseKey = threadId) {
    const lease = this.leases.get(leaseKey);
    if (!lease || (connection && lease.connection !== connection)) return null;
    this.leases.delete(leaseKey);
    return lease;
  }

  disconnect(connection, now = Date.now()) {
    const changed = [];
    for (const lease of this.leases.values()) {
      if (lease.connection !== connection) continue;
      lease.phase = "disconnected";
      lease.lastActivityAtMs = now;
      lease.expiresAtMs = now + this.disconnectTtlMs;
      changed.push(lease);
    }
    return changed;
  }

  get(threadId, now = Date.now(), leaseKey = threadId) {
    this.sweep(now);
    return this.leases.get(leaseKey) ?? null;
  }

  list(now = Date.now()) {
    this.sweep(now);
    return [...this.leases.values()];
  }
}

export class ThreadWriteLeaseService extends Service {
  constructor(ctx) {
    super(ctx, "threadWriteLease");
    this.table = new ThreadWriteLeaseTable();
    this.activityTracker = new ThreadActivityTracker();
    this.fallbackEdits = new Map();
    this.ensureSchema();
    const register = (method, handler) => ctx.effect(() => ctx.appServer.register(method, handler));
    register("hypernode/threadWriteLease/acquire", (params, connection) => {
      const result = this.acquire(params.threadId, connection, "editing");
      if (!result.acquired) throw this.errorFor(result.lease);
      return { lease: this.publicLease(result.lease) };
    });
    register("hypernode/threadWriteLease/heartbeat", (params, connection) => {
      const result = this.heartbeat(params.threadId, connection);
      if (!result.renewed) {
        if (result.lease) throw this.errorFor(result.lease);
        const error = new Error("thread write lease is not held by this connection");
        error.code = -32062;
        error.data = { kind: "threadWriteLeaseNotHeld", threadId: params.threadId };
        throw error;
      }
      this.recordEdit(result.lease);
      this.changed(result.lease);
      return { lease: this.publicLease(result.lease) };
    });
    register("hypernode/threadWriteLease/release", (params, connection) => {
      const released = this.release(params.threadId, connection);
      return { released: released !== null };
    });
    register("hypernode/threadWriteLease/read", (params) => ({
      lease: this.publicLease(this.table.get(params.threadId, Date.now(), this.leaseKey(params.threadId))),
      lastEdit: this.readLastEdit(params.threadId),
    }));
    register("hypernode/threadActivity/list", (_params, connection) => ({
      threads: this.activeThreads(null, Date.now(), connection.identity?.id ?? null),
    }));
    ctx.effect(() => ctx.appServer.intercept((message, connection) => this.intercept(message, connection)));
    ctx.effect(() => ctx.appServer.onClose((connection) => {
      for (const lease of this.table.disconnect(connection)) {
        this.recordEdit(lease);
        this.changed(lease);
      }
    }));
  }

  intercept(message, connection) {
    if (message == null) {
      for (const expired of this.table.sweep()) this.changed(null, expired.threadId);
      return false;
    }
    for (const expired of this.table.sweep()) this.changed(null, expired.threadId);
    if (!message?.method) return false;
    const threadId = message.params?.threadId;
    if (typeof threadId !== "string") return false;
    if (message.method === "thread/read" || message.method === "thread/resume") {
      this.queueEditWarning(threadId, connection);
    }
    // Mock/system threads still execute inside Hypernode's own workspace and
    // therefore use the resource writer lock. Transparent Codex threads are
    // governed exclusively by ThreadExecutionService's account identity CAS.
    if (message.method === "turn/start" && !this.ctx.threadManager.isTransparentCodex(threadId)) {
      const result = this.acquire(threadId, connection, "running");
      if (result.acquired) return false;
      connection.socket.send({ id: message.id, error: this.conflict(result.lease) });
      return true;
    }
    if (!GUARDED_THREAD_METHODS.has(message.method)) return false;
    const lease = this.table.get(threadId, Date.now(), this.leaseKey(threadId));
    if (!lease || lease.connection === connection) {
      if (lease) this.table.heartbeat(threadId, connection, Date.now(), this.leaseKey(threadId));
      return false;
    }
    connection.socket.send({ id: message.id, error: this.conflict(lease) });
    return true;
  }

  acquire(threadId, connection, phase = "running") {
    if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required");
    const result = this.table.acquire(threadId, connection, phase, Date.now(), this.leaseKey(threadId));
    if (result.acquired) {
      connection.threadWriteLease = this;
      this.activityTracker.observe(result.lease);
      this.recordEdit(result.lease);
      this.changed(result.lease);
      this.warnOtherConnections(result.lease);
    }
    return result;
  }

  release(threadId, connection = null) {
    const released = this.table.release(threadId, connection, this.leaseKey(threadId));
    if (released) {
      this.recordEdit(released, Date.now());
      this.changed(null, threadId);
    }
    return released;
  }

  releaseThread(threadId) {
    const lease = this.table.get(threadId, Date.now(), this.leaseKey(threadId));
    if (!lease || lease.threadId !== threadId) return null;
    return this.release(threadId);
  }

  heartbeat(threadId, connection) {
    const now = Date.now();
    const result = this.table.heartbeat(threadId, connection, now, this.leaseKey(threadId));
    if (result.renewed) this.activityTracker.observe(result.lease, now);
    return result;
  }

  leaseKey(threadId) {
    return this.ctx.workspaceView?.leaseKey(threadId) ?? `thread:${threadId}`;
  }

  activity(threadId, connection = null) {
    const lease = this.table.get(threadId, Date.now(), this.leaseKey(threadId));
    if (!lease || (connection && lease.connection !== connection)) return;
    const now = Date.now();
    lease.lastActivityAtMs = now;
    this.activityTracker.observe(lease, now);
    this.recordEdit(lease);
  }

  conflict(lease) {
    const expiresInMs = lease.expiresAtMs == null ? null : Math.max(0, lease.expiresAtMs - Date.now());
    return {
      code: -32061,
      message: `${lease.holderUsername} 正在写入此会话`,
      data: {
        kind: "threadWriteLeaseHeld",
        threadId: lease.threadId,
        holderPrincipalId: lease.holderPrincipalId,
        holderUsername: lease.holderUsername,
        phase: lease.phase,
        expiresInMs,
      },
    };
  }

  errorFor(lease) {
    const conflict = this.conflict(lease);
    const error = new Error(conflict.message);
    error.code = conflict.code;
    error.data = conflict.data;
    return error;
  }

  publicLease(lease) {
    if (!lease) return null;
    return {
      threadId: lease.threadId,
      workspaceViewId: lease.leaseKey?.startsWith("workspace:") ? lease.leaseKey.slice("workspace:".length) : null,
      holderPrincipalId: lease.holderPrincipalId,
      holderUsername: lease.holderUsername,
      connectionId: lease.connectionId,
      phase: lease.phase,
      acquiredAtMs: lease.acquiredAtMs,
      lastActivityAtMs: lease.lastActivityAtMs,
      expiresAtMs: lease.expiresAtMs,
      activeSinceMs: lease.activeSinceMs ?? lease.acquiredAtMs,
    };
  }

  changed(lease, threadId = lease?.threadId) {
    this.ctx.appServer.broadcastNotification("hypernode/threadWriteLease/changed", {
      threadId,
      lease: this.publicLease(lease),
    });
  }

  ensureSchema() {
    if (!this.ctx.storage.available) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_thread_last_edits (
        thread_id TEXT PRIMARY KEY,
        editor_principal_id TEXT NOT NULL,
        editor_username TEXT NOT NULL,
        edited_at_ms INTEGER NOT NULL
      )
    `);
  }

  recordEdit(lease, editedAtMs = lease.lastActivityAtMs ?? Date.now()) {
    const edit = {
      threadId: lease.threadId,
      editorPrincipalId: lease.holderPrincipalId,
      editorUsername: lease.holderUsername,
      editedAtMs,
    };
    this.fallbackEdits.set(edit.threadId, edit);
    if (this.ctx.storage.available) {
      this.ctx.storage.sql.exec(`
        INSERT INTO do_thread_last_edits(thread_id, editor_principal_id, editor_username, edited_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          editor_principal_id = excluded.editor_principal_id,
          editor_username = excluded.editor_username,
          edited_at_ms = excluded.edited_at_ms
      `, edit.threadId, edit.editorPrincipalId, edit.editorUsername, edit.editedAtMs);
    }
    return edit;
  }

  readLastEdit(threadId) {
    if (!this.ctx.storage.available) return this.fallbackEdits.get(threadId) ?? null;
    const row = this.ctx.storage.sql.exec(`
      SELECT thread_id AS threadId, editor_principal_id AS editorPrincipalId,
        editor_username AS editorUsername, edited_at_ms AS editedAtMs
      FROM do_thread_last_edits WHERE thread_id = ?
    `, threadId).toArray()[0];
    return row ?? null;
  }

  queueEditWarning(threadId, connection) {
    const edit = this.readLastEdit(threadId);
    if (!edit) return;
    const now = Date.now();
    const previous = connection.lastEditWarnings?.get(threadId);
    if (previous?.editedAtMs === edit.editedAtMs && now - previous.shownAtMs < 30_000) return;
    if (!connection.lastEditWarnings) connection.lastEditWarnings = new Map();
    connection.lastEditWarnings.set(threadId, { editedAtMs: edit.editedAtMs, shownAtMs: now });
    this.ctx.appServer.notifyAfter(connection, "warning", {
      threadId,
      message: editWarningMessage(edit, now),
    });
  }

  warnOtherConnections(lease) {
    for (const connection of this.ctx.appServer.connections) {
      if (!connection.initialized || connection === lease.connection) continue;
      this.queueEditWarning(lease.threadId, connection);
      this.ctx.appServer.flushNotifications(connection);
    }
  }

  activeThreads(excludeThreadId = null, now = Date.now(), actorPrincipalId = undefined) {
    return this.table.list(now)
      .filter((lease) => lease.threadId !== excludeThreadId)
      .filter((lease) => actorPrincipalId === undefined ||
        this.ctx.threadManager.visibleTo(lease.threadId, actorPrincipalId))
      .map((lease) => {
        const thread = this.ctx.threadManager.find(lease.threadId);
        return {
          threadId: lease.threadId,
          name: thread?.name ?? lease.threadId,
          preview: thread?.preview ?? "",
          holderUsername: lease.holderUsername,
          phase: lease.phase,
          lastLeaseActivityAtMs: lease.lastActivityAtMs,
          lastConversationAtMs: Number.isFinite(thread?.updatedAt) ? thread.updatedAt * 1000 : null,
        };
      })
      .sort((left, right) => right.lastLeaseActivityAtMs - left.lastLeaseActivityAtMs);
  }

  renderActiveThreads(excludeThreadId = null, now = Date.now(), actorPrincipalId = undefined) {
    const threads = this.activeThreads(excludeThreadId, now, actorPrincipalId);
    if (threads.length === 0) return "当前没有其他带写入租约的会话。";
    const lines = ["当前带写入租约的会话："];
    for (const thread of threads) {
      const leaseAge = formatEditAge(thread.lastLeaseActivityAtMs, now);
      const conversationAge = thread.lastConversationAtMs == null
        ? "未知"
        : `${formatEditAge(thread.lastConversationAtMs, now)}前`;
      lines.push(
        `- ${thread.name} · ${thread.holderUsername} · ${thread.phase} · ` +
        `租约活动 ${leaseAge}前 · 上一次对话 ${conversationAge}`,
      );
    }
    return lines.join("\n");
  }
}

ThreadWriteLeaseService.inject = ["appServer", "storage", "threadManager", "workspaceView"];
