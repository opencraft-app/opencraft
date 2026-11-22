import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const keyOf = (hostId, threadId) => JSON.stringify([hostId, threadId]);
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
/** Durable projection of acknowledged engine lifecycle events. It owns resource
 * admission and cleanup, never the engine's archive flag or conversation history.
 * A failed owner remains pending across reconnects and process restarts.
 *
 * The journal is written asynchronously, one write at a time. `rows` holds only
 * committed records; owners run only for committed records. A close intent
 * fences its conversation from the moment it is observed until it is durable. */
export class ConversationResourceLifecycle {
  /** Opens a journal-backed lifecycle. Use the constructor with a null path for memory only. */
  static async open(path, owners, options = {}) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let saved;
    try { saved = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lifecycle = new ConversationResourceLifecycle(path, owners, { ...options, saved });
    try {
      const replay = options.replayOwners ?? [];
      if (!Array.isArray(replay) || replay.some(name => !Object.hasOwn(owners, name))) throw Error('Invalid resource replay owners');
      if (replay.length) await lifecycle.commit(rows => {
        let changed = false; const next = new Map(rows);
        for (const [key,row] of rows) if (row.state !== 'active') {
          const pending = [...new Set([...row.pending,...replay])];
          if (pending.length !== row.pending.length) {changed = true; next.set(key,{...row,pending});}
        }
        return changed ? next : null;
      });
      return lifecycle;
    } catch (error) { await lifecycle.close(); throw error; }
  }

  constructor(path, owners, { retryMs = 5000, diagnose = () => {}, saved, dependencies = {} } = {}) {
    this.path = path; this.owners = owners; this.diagnose = diagnose;
    this.dependencies = {};
    for (const [name,after] of Object.entries(dependencies)) {
      if (!Object.hasOwn(owners,name) || !Array.isArray(after) || after.some(dep => typeof dep !== 'string' || !Object.hasOwn(owners,dep))) throw Error('Invalid resource owner dependency');
      this.dependencies[name] = [...new Set(after)];
    }
    const visited = new Set(), visiting = new Set();
    const visit = name => {if (visiting.has(name)) throw Error('Cyclic resource owner dependency'); if (visited.has(name)) return; visiting.add(name); for(const dep of this.dependencies[name] ?? []) visit(dep); visiting.delete(name);visited.add(name);};
    for(const name of Object.keys(owners)) visit(name);
    this.poisoned = false; this.reconciliations = new Map();
    this.hostRevisions = new Map();
    this.rows = new Map(); this.pendingKeys = new Set(); this.flights = new Map(); this.closed = false;
    // Records observed but not yet durable, and the keys they fence.
    this.intended = new Map(); this.writing = Promise.resolve();
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.rows)) throw Error('Invalid conversation resource journal');
      for (const row of saved.rows) {
        if (!valid(row.hostId) || !valid(row.threadId) || !['archived', 'deleted', 'active'].includes(row.state)
          || !Number.isSafeInteger(row.generation) || row.generation < 1 || !Array.isArray(row.pending)
          || row.pending.some(name => typeof name !== 'string' || !Object.hasOwn(owners, name) || typeof owners[name] !== 'function')) throw Error('Invalid conversation resource record');
        const key = keyOf(row.hostId, row.threadId);
        this.rows.set(key, row);
        if (row.pending.length) this.pendingKeys.add(key);
        else this.pendingKeys.delete(key);
      }
    }
    this.timer = setInterval(() => this.retry(), retryMs); this.timer.unref();
  }
  /** Commits a change computed from the committed rows when its turn comes. */
  commit(change) {
    const run = this.writing.then(async () => {
      if (this.poisoned) throw Error('Conversation resource journal unavailable');
      const rows = change(this.rows);
      if (!rows) return;
      try { await this.write(rows); } catch (error) { this.poisoned = true; throw error; }
    });
    this.writing = run.catch(() => {});
    return run;
  }
  /** Records a new generation for `key` and fences it until the write settles. */
  intend(key, row) {
    this.intended.set(key, row);
    return this.commit(rows => new Map(rows).set(key, row))
      .finally(() => { if (this.intended.get(key) === row) this.intended.delete(key); });
  }
  installRows(rows) {
    this.rows = rows;
    // A disposable index of the installed journal, never another authority.
    // Rebuild only on state writes, not on every idle retry timer tick.
    this.pendingKeys = new Set([...rows].filter(([, row]) => row.pending.length).map(([key]) => key));
  }
  async write(rows) {
    if (!this.path) { this.installRows(rows); return; }
    const temp = this.path + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, rows: [...rows.values()] })); await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temp, this.path); this.installRows(rows);
      const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally {
      if (handle !== undefined) await handle.close();
      try { await unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  assertActive(hostId, threadId) {
    if (!threadId) return; // Unbound, human-owned resources have a different lifetime.
    const key = keyOf(hostId, threadId), row = this.rows.get(key);
    if (this.closed || this.poisoned || this.intended.has(key) || row && (row.state !== 'active' || row.pending.length || this.flights.has(key)))
      throw Object.assign(Error('Conversation resources are unavailable until lifecycle cleanup completes'), { code: 'THREAD_RESOURCES_UNAVAILABLE', retryable: (this.intended.get(key) ?? row)?.state === 'active' });
  }
  observe(hostId, threadId, state) {
    if (this.closed) throw Error('Conversation resource lifecycle closed');
    if (!valid(hostId) || !valid(threadId) || !['archived', 'deleted', 'active'].includes(state)) throw Error('Invalid conversation lifecycle');
    const key = keyOf(hostId, threadId), prior = this.intended.get(key) ?? this.rows.get(key);
    // Notifications and successful replies commonly report the same transition.
    if (prior?.state === 'deleted' || prior?.state === state) return this.drain(key);
    const row = { hostId, threadId, state, generation: (prior?.generation ?? 0) + 1,
      pending: Object.keys(this.owners) };
    return this.intend(key, row).then(() => this.drain(key));
  }
  /** Rebuild missing close intents from metadata only. Never infer deletion from
   * absence. A concurrent native notification wins over an older list page. */
  reconcileArchived(hostId, list) {
    if (this.closed) return Promise.resolve();
    if (this.reconciliations.has(hostId)) return this.reconciliations.get(hostId);
    const run = (async () => {
      let cursor = null; const cursors = new Set();
      do {
        // Installed journals and their records are replaced, never edited in
        // place. Retain the page-admission view instead of copying all Hosts
        // and historical rows just to compare generations for this page.
        const beforePage = this.rows, intendedBefore = new Map(this.intended);
        const page = await list(cursor);
        if (this.closed) return;
        if (!Array.isArray(page?.data)) throw Error('Invalid archived conversation catalog');
        for (const item of page.data) {
          if (!valid(item.id) || item.ephemeral === true) continue;
          const key = keyOf(hostId, item.id);
          const generation = row => row?.generation ?? 0;
          if (generation(this.intended.get(key) ?? this.rows.get(key)) !== generation(intendedBefore.get(key) ?? beforePage.get(key))) continue;
          await this.observe(hostId, item.id, 'archived');
        }
        cursor = page.nextCursor ?? null;
        if (cursor !== null && (typeof cursor !== 'string' || cursors.has(cursor))) throw Error('Invalid archive pagination');
        cursors.add(cursor);
      } while (cursor !== null && !this.closed);
      return !this.closed;
    })().catch(() => { this.diagnose({ code: 'RESOURCE_RECONCILIATION_FAILED', hostId }); return false; }).finally(() => this.reconciliations.delete(hostId));
    this.reconciliations.set(hostId, run); return run;
  }
  invalidateHost(hostId) { this.hostRevisions.set(hostId, this.hostRevision(hostId) + 1); }
  hostRevision(hostId) { return this.hostRevisions.get(hostId) ?? 0; }
  resourceLinked(hostId, threadId) {
    const key = keyOf(hostId, threadId), row = this.intended.get(key) ?? this.rows.get(key);
    if (!row || row.state === 'active' || this.closed) return;
    void this.intend(key, { ...row, generation: row.generation + 1, pending: Object.keys(this.owners) })
      .then(() => this.drain(key), () => this.diagnose({ code: 'RESOURCE_JOURNAL_FAILED', hostId, threadId }));
  }
  retry() { for (const key of this.pendingKeys) void this.drain(key); }
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
        const jobs = new Map();
        const runOwner = name => {
          if (!jobs.has(name)) jobs.set(name,Promise.resolve().then(async () => {
            for (const dependency of this.dependencies[name] ?? []) if (pending.includes(dependency)) await runOwner(dependency);
            return this.owners[name](row);
          }));
          return jobs.get(name);
        };
        const results = await Promise.allSettled(pending.map(runOwner));
        if (this.closed) return;
        const current = this.rows.get(key);
        if (current.generation !== row.generation) continue; // old ACK cannot clear a new close intent
        const failed = pending.filter((_, i) => results[i].status === 'rejected');
        // Failed owners remain durably pending already. With no progress, a
        // retry must not serialize/fsync the entire journal again. Partial or
        // successful acknowledgements still persist before admission.
        if (failed.length !== pending.length) {
          await this.commit(rows => {
            const latest = rows.get(key);
            // A newer close intent committed meanwhile keeps all of its owners pending.
            return latest?.generation === row.generation ? new Map(rows).set(key, { ...latest, pending: failed }) : null;
          });
          if (this.rows.get(key)?.generation !== row.generation) continue;
        }
        if (failed.length) this.diagnose({ hostId: row.hostId, threadId: row.threadId, pending: failed });
        return;
      }
    })().catch(() => this.diagnose({ code: 'RESOURCE_CLEANUP_FAILED' })).finally(() => this.flights.delete(key));
    this.flights.set(key, run); return run;
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled([...this.flights.values(), ...this.reconciliations.values(), this.writing]);
  }
}
