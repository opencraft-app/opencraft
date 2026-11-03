import type { DatabaseSync } from "node:sqlite";

// Synchronous read snapshots only: returning a Promise ends the scope before its continuation.
let scope: Map<object, number> | undefined;
export function withPermissionReads<T>(read: () => T): T {
  if (scope) return read();
  scope = new Map();
  try { return read(); } finally { scope = undefined; }
}
/** Trusted permission writers break any enclosing read snapshot, including on rollback. */
export function withPermissionWrite<T>(write: () => T): T {
  scope?.clear();
  try { return write(); } finally { scope?.clear(); }
}
interface VersionState { version?: string; generation: number }
const versions = new WeakMap<object, VersionState>();

/** Caches raw rows, never an authorization decision or its expiration. */
export class PermissionReadCache {
  private readonly dataVersion;
  private readonly schemaVersion;
  private readonly changes;
  private readonly state: VersionState;
  private generation = -1;
  private readonly rows = new Map<string, unknown>();
  private closed = false;
  constructor(private readonly database: DatabaseSync, private readonly identity: object = database,
    private readonly limit = 1024) {
    this.dataVersion = database.prepare("PRAGMA data_version");
    this.schemaVersion = database.prepare("PRAGMA schema_version");
    this.changes = database.prepare("SELECT total_changes() AS changes");
    const state = versions.get(identity) ?? { generation: 0 };
    versions.set(identity, state); this.state = state;
  }
  get<T>(key: string, load: () => T): T {
    if (this.closed) throw new Error("Permission repository is closed");
    if (!scope) return load();
    if (this.database.isTransaction) {
      this.rows.clear(); this.state.version = undefined; scope.delete(this.identity);
      return load();
    }
    let generation = scope.get(this.identity);
    if (generation === undefined) {
      // Read markers before rows: a later external commit invalidates the next scope.
      const version = JSON.stringify([this.dataVersion.get()!.data_version,
        this.schemaVersion.get()!.schema_version, this.changes.get()!.changes]);
      if (version !== this.state.version) { this.state.version = version; this.state.generation++; }
      generation = this.state.generation;
      scope.set(this.identity, generation);
    }
    if (generation !== this.generation) { this.rows.clear(); this.generation = generation; }
    if (this.rows.has(key)) {
      const value = this.rows.get(key) as T;
      this.rows.delete(key); this.rows.set(key, value); return value;
    }
    const value = load();
    if (this.rows.size >= this.limit) this.rows.delete(this.rows.keys().next().value!);
    this.rows.set(key, value); return value;
  }
  close(): void { this.closed = true; this.rows.clear(); scope?.delete(this.identity); }
}
