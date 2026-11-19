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
  private bytes = 0;
  private readonly presentationRevisions=new Map<string,number>();
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
  publish(rows: Map<string, unknown>): void { this.rows = rows; this.bytes=[...rows].reduce((n,[key,row])=>n+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(row)),0); this.valid = true; }
  invalidate(): void { this.valid = false; }
  get<T>(key: string, readDuringWrite: () => T): T {
    if (this.closed) throw new Error("Permission repository is closed");
    // Read-your-writes belongs to the storage mutation, never the delivery path.
    if (writeDepth || this.options.enabled === false) return readDuringWrite();
    if (!this.valid) throw new Error("Permission projection is unavailable");
    return this.rows.get(key) as T;
  }
  /** A committed newly allocated identity can fill a missing slot, never replace an
   * existing permission/generation. Existing identities still use owner mutations. */
  seedMissing(key: string, row: unknown): void {
    if (this.closed || !this.valid || this.options.enabled === false || this.rows.has(key)) return;
    const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(row));
    if(this.rows.size>=(this.options.entries??100_000)||this.bytes+size>(this.options.bytes??32*1024*1024)) {
      this.invalidate();throw Error('Permission projection exceeds its memory budget');
    }
    this.rows.set(key, row);this.bytes+=size;
  }
  /** A committed revocation only removes authority; late publication cannot restore it. */
  retireCredential(id:string):void {
    const key=JSON.stringify(['credential',id]);
    if(this.closed||!this.valid||this.options.enabled===false)return;
    const row=this.rows.get(key) as Record<string,unknown>|undefined;
    if(row)this.rows.set(key,{...row,enabled:0});
    else this.seedMissing(key,{id,enabled:0});
  }
  /** Trusted committed display-name projection only; cannot change identity, grants or generation. */
  updateActorName(id:string,displayName:string,revision:number):void {
    if(this.closed||!this.valid||this.options.enabled===false)return;
    const key=JSON.stringify(['actor',id]),row=this.rows.get(key) as Record<string,unknown>|undefined;
    if(!row||row.kind!=='session'||revision<=(this.presentationRevisions.get(id)??-1))return;
    const next={...row,display_name:displayName},delta=Buffer.byteLength(JSON.stringify(next))-Buffer.byteLength(JSON.stringify(row));
    if(this.bytes+delta>(this.options.bytes??32*1024*1024))throw Error('Permission projection exceeds its memory budget');
    this.rows.set(key,next);this.bytes+=delta;this.presentationRevisions.set(id,revision);
  }
  close(): void { this.closed = true; this.valid = false; this.rows.clear();this.presentationRevisions.clear(); dirty.delete(this); this.group.delete(this); }
}
