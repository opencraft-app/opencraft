let writeDepth = 0;
const dirty = new Set<PermissionReadCache>();
const owners = new WeakMap<object, Set<PermissionReadCache>>();
/** Only the synchronous storage owner calls this control-plane boundary. */
export function withPermissionWrite<T>(write: () => T, cache: PermissionReadCache): T {
  for (const projection of cache.ownerProjections()) { dirty.add(projection); projection.invalidate(); }
  writeDepth++;
  try {
    const result = write();
    if (result && typeof result === "object" && "then" in result) throw new Error("Permission writes must be synchronous");
    return result;
  }
  finally {
    if (--writeDepth === 0) {
      const pending = [...dirty]; dirty.clear();
      try {
        const snapshots = pending.map(owner => owner.stage());
        pending.forEach((owner, index) => owner.publish(snapshots[index]!));
      } catch (error) { pending.forEach(owner => owner.invalidate()); throw error; }
    }
  }
}

/** Complete owner-published raw-row projection. No SQL or read-through misses on delivery. */
export class PermissionReadCache {
  private rows = new Map<string, unknown>();
  private valid = false;
  private closed = false;
  private readonly group: Set<PermissionReadCache>;
  constructor(private readonly load: () => Iterable<readonly [string, unknown]>,
    private readonly options: { owner?: object; enabled?: boolean; entries?: number; bytes?: number } = {}) {
    if (writeDepth) throw new Error("Cannot initialize a permission projection inside a mutation");
    if (options.enabled !== false) this.publish(this.stage());
    const identity = options.owner ?? {};
    this.group = owners.get(identity) ?? new Set();
    if (options.enabled !== false) { owners.set(identity, this.group); this.group.add(this); }
  }
  ownerProjections(): Iterable<PermissionReadCache> { return this.group; }
  stage(): Map<string, unknown> {
    if (this.closed) throw new Error("Permission repository is closed");
    const rows = new Map<string, unknown>(); let bytes = 0;
    for (const [key, row] of this.load()) {
      bytes += Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(row));
      if (rows.size >= (this.options.entries ?? 100_000) || bytes > (this.options.bytes ?? 32 * 1024 * 1024)) throw new Error("Permission projection exceeds its memory budget");
      rows.set(key, row);
    }
    return rows;
  }
  publish(rows: Map<string, unknown>): void { this.rows = rows; this.valid = true; }
  invalidate(): void { this.valid = false; }
  get<T>(key: string, readDuringWrite: () => T): T {
    if (this.closed) throw new Error("Permission repository is closed");
    // Read-your-writes belongs to the storage mutation, never the delivery path.
    if (writeDepth || this.options.enabled === false) return readDuringWrite();
    if (!this.valid) throw new Error("Permission projection is unavailable");
    return this.rows.get(key) as T;
  }
  close(): void { this.closed = true; this.valid = false; this.rows.clear(); dirty.delete(this); this.group.delete(this); }
}
