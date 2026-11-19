import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const keyOf = (hostId, threadId) => JSON.stringify([hostId, threadId]);
const valid = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
/** Durable projection of acknowledged engine lifecycle events. It owns resource
 * admission and cleanup, never the engine's archive flag or conversation history.
 * A failed owner remains pending across reconnects and process restarts. */
export class ConversationResourceLifecycle {
  constructor(path, owners, { retryMs = 5000, diagnose = () => {} } = {}) {
    this.path = path;
    this.owners = owners;
    this.diagnose = diagnose;
    this.poisoned = false;
    this.reconciliations = new Map();
    this.hostRevisions = new Map();
    this.rows = new Map();
    this.pendingKeys = new Set();
    this.flights = new Map();
    this.closed = false;
    if (path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      let saved;
      try {
        saved = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (saved) {
        if (saved.version !== 1 || !Array.isArray(saved.rows)) throw Error("Invalid conversation resource journal");
        for (const row of saved.rows) {
          if (
            !valid(row.hostId) ||
            !valid(row.threadId) ||
            !["archived", "deleted", "active"].includes(row.state) ||
            !Number.isSafeInteger(row.generation) ||
            row.generation < 1 ||
            !Array.isArray(row.pending) ||
            row.pending.some(
              (name) => typeof name !== "string" || !Object.hasOwn(owners, name) || typeof owners[name] !== "function",
            )
          )
            throw Error("Invalid conversation resource record");
          const key = keyOf(row.hostId, row.threadId);
          this.rows.set(key, row);
          if (row.pending.length) this.pendingKeys.add(key);
          else this.pendingKeys.delete(key);
        }
      }
    }
    this.timer = setInterval(() => this.retry(), retryMs);
    this.timer.unref();
  }
  persist(rows) {
    try {
      return this.write(rows);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  installRows(rows) {
    this.rows = rows;
    // A disposable index of the installed journal, never another authority.
    // Rebuild only on state writes, not on every idle retry timer tick.
    this.pendingKeys = new Set([...rows].filter(([, row]) => row.pending.length).map(([key]) => key));
  }
  write(rows) {
    if (!this.path) {
      this.installRows(rows);
      return;
    }
    const temp = this.path + "." + randomUUID() + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, rows: [...rows.values()] }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
      this.installRows(rows);
      const dir = openSync(dirname(this.path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  assertActive(hostId, threadId) {
    if (!threadId) return; // Unbound, human-owned resources have a different lifetime.
    const row = this.rows.get(keyOf(hostId, threadId));
    if (
      this.closed ||
      this.poisoned ||
      (row && (row.state !== "active" || row.pending.length || this.flights.has(keyOf(hostId, threadId))))
    )
      throw Object.assign(Error("Conversation resources are unavailable until lifecycle cleanup completes"), {
        code: "THREAD_RESOURCES_UNAVAILABLE",
        retryable: row?.state === "active",
      });
  }
  observe(hostId, threadId, state) {
    if (this.closed) throw Error("Conversation resource lifecycle closed");
    if (!valid(hostId) || !valid(threadId) || !["archived", "deleted", "active"].includes(state))
      throw Error("Invalid conversation lifecycle");
    const key = keyOf(hostId, threadId),
      prior = this.rows.get(key);
    // Notifications and successful replies commonly report the same transition.
    if (prior?.state === "deleted" || prior?.state === state) return this.drain(key);
    const row = {
      hostId,
      threadId,
      state,
      generation: (prior?.generation ?? 0) + 1,
      pending: Object.keys(this.owners),
    };
    this.persist(new Map(this.rows).set(key, row));
    return this.drain(key);
  }
  /** Rebuild missing close intents from metadata only. Never infer deletion from
   * absence. A concurrent native notification wins over an older list page. */
  reconcileArchived(hostId, list) {
    if (this.closed) return Promise.resolve();
    if (this.reconciliations.has(hostId)) return this.reconciliations.get(hostId);
    const run = (async () => {
      let cursor = null;
      const cursors = new Set();
      do {
        // Installed journals and their records are replaced, never edited in
        // place. Retain the page-admission view instead of copying all Hosts
        // and historical rows just to compare generations for this page.
        const beforePage = this.rows;
        const page = await list(cursor);
        if (this.closed) return;
        if (!Array.isArray(page?.data)) throw Error("Invalid archived conversation catalog");
        for (const item of page.data) {
          if (!valid(item.id) || item.ephemeral === true) continue;
          const key = keyOf(hostId, item.id);
          if ((this.rows.get(key)?.generation ?? 0) !== (beforePage.get(key)?.generation ?? 0)) continue;
          await this.observe(hostId, item.id, "archived");
        }
        cursor = page.nextCursor ?? null;
        if (cursor !== null && (typeof cursor !== "string" || cursors.has(cursor)))
          throw Error("Invalid archive pagination");
        cursors.add(cursor);
      } while (cursor !== null && !this.closed);
      return !this.closed;
    })()
      .catch(() => {
        this.diagnose({ code: "RESOURCE_RECONCILIATION_FAILED", hostId });
        return false;
      })
      .finally(() => this.reconciliations.delete(hostId));
    this.reconciliations.set(hostId, run);
    return run;
  }
  invalidateHost(hostId) {
    this.hostRevisions.set(hostId, this.hostRevision(hostId) + 1);
  }
  hostRevision(hostId) {
    return this.hostRevisions.get(hostId) ?? 0;
  }
  resourceLinked(hostId, threadId) {
    const key = keyOf(hostId, threadId),
      row = this.rows.get(key);
    if (!row || row.state === "active" || this.closed) return;
    this.persist(
      new Map(this.rows).set(key, { ...row, generation: row.generation + 1, pending: Object.keys(this.owners) }),
    );
    void this.drain(key);
  }
  retry() {
    for (const key of this.pendingKeys) void this.drain(key);
  }
  drain(key) {
    if (this.closed) return Promise.resolve();
    if (this.flights.has(key)) return this.flights.get(key);
    const run = (async () => {
      // Yield before invoking owners: install the flight before any reentrancy.
      await Promise.resolve();
      for (;;) {
        const row = this.rows.get(key);
        if (!row?.pending.length || this.closed) return;
        const pending = [...row.pending];
        const results = await Promise.allSettled(
          pending.map((name) => Promise.resolve().then(() => this.owners[name](row))),
        );
        if (this.closed) return;
        const current = this.rows.get(key);
        if (current.generation !== row.generation) continue; // old ACK cannot clear a new close intent
        const failed = pending.filter((_, i) => results[i].status === "rejected");
        // Failed owners remain durably pending already. With no progress, a
        // retry must not synchronously serialize/fsync the entire journal again.
        // Partial/successful acknowledgements still persist before admission.
        if (failed.length !== pending.length)
          this.persist(new Map(this.rows).set(key, { ...current, pending: failed }));
        if (failed.length) this.diagnose({ hostId: row.hostId, threadId: row.threadId, pending: failed });
        return;
      }
    })()
      .catch(() => this.diagnose({ code: "RESOURCE_CLEANUP_FAILED" }))
      .finally(() => this.flights.delete(key));
    this.flights.set(key, run);
    return run;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.flights.values(), ...this.reconciliations.values()]);
  }
}
