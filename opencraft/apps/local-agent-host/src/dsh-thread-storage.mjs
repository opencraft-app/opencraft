/** Process-scoped volatility, shared by the native persistence and execution adapters. */
export class VolatileSessions {
  ids = new Set();
  entries = new Map();
  mark(id) { this.ids.add(String(id)); }
  has(id) { return this.ids.has(String(id)); }
  // Keep the tombstone: a late projection/disposal callback must never write to disk.
  forget(id) { this.entries.delete(String(id)); }
  read(id) { const value = this.entries.get(String(id)); return value ? structuredClone(value) : undefined; }
  append(meta, events) {
    const key = String(meta.id), current = this.entries.get(key) ?? { meta: structuredClone(meta), events: [], revision: `volatile:${key}:0` };
    for (const event of events) {
      if (event.seq !== current.events.length) throw new Error("Volatile session append must be contiguous");
      current.events.push(structuredClone(event));
    }
    current.revision = `volatile:${key}:${current.events.length}`;
    this.entries.set(key, current);
  }
}
export const volatileSessions = new VolatileSessions();

/** Route the public PersistenceBackend primitives; leave native coordinator validation intact. */
export function routeSessionPersistence(Base, sessions = volatileSessions) {
  return class OpenCraftSessionPersistence extends Base {
    async loadStored(id, signal) { return sessions.has(id) ? sessions.read(id) : super.loadStored(id, signal); }
    async readStoredRevision(id, signal) { return sessions.has(id) ? sessions.read(id)?.revision : super.readStoredRevision(id, signal); }
    async loadStoredFrom(id, fromSeq, signal) {
      if (!sessions.has(id)) {
        if (typeof super.loadStoredFrom === "function") return super.loadStoredFrom(id, fromSeq, signal);
        const whole = await super.loadStored(id, signal);
        return whole && { meta: whole.meta, events: whole.events.filter(e => e.seq >= fromSeq) };
      }
      const value = sessions.read(id); return value && { meta: value.meta, events: value.events.filter(e => e.seq >= fromSeq) };
    }
    async appendBatch(meta, events, materialized) {
      if (sessions.has(meta.id)) return sessions.append(meta, events);
      return super.appendBatch(meta, events, materialized);
    }
    async commitRepair(meta, torn, closers) {
      if (sessions.has(meta.id)) {
        if (torn !== undefined) throw new Error("Volatile sessions cannot have a torn disk tail");
        return sessions.append(meta, closers);
      }
      return super.commitRepair(meta, torn, closers);
    }
    locate(meta) { return sessions.has(meta.id) ? undefined : super.locate(meta); }
    async readRaw(id, signal) { return sessions.has(id) ? undefined : super.readRaw(id, signal); }
  };
}
export function routeProjectionCache(Base, sessions = volatileSessions) {
  return class OpenCraftProjectionCache extends Base {
    async put(id, identity, rows) { if (!sessions.has(id)) return super.put(id, identity, rows); }
  };
}
