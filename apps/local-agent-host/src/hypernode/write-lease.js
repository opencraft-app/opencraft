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
