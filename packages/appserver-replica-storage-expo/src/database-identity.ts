const formerNames: Readonly<Record<string, string>> = {
  "opencraft-appserver-replica.db": "vela-appserver-replica.db",
  "opencraft-workbench-replica.db": "vela-workbench-replica.db",
};

export interface ReplicaDatabaseIdentityPort {
  exists(name: string): boolean | Promise<boolean>;
  /** A consistent SQLite snapshot, including committed WAL data. */
  snapshot(name: string): Promise<Uint8Array>;
  /** Install a complete file without replacing a destination that already exists. */
  install(name: string, snapshot: Uint8Array): Promise<void>;
}

/** One native application owns the private database directory and this gate. */
export function createReplicaDatabaseIdentityMigration(port: ReplicaDatabaseIdentityPort) {
  const pending = new Map<string, Promise<void>>();
  return function prepare(name: string): Promise<void> {
    const former = formerNames[name];
    if (former === undefined) return Promise.resolve();
    const existing = pending.get(name);
    if (existing) return existing;
    const operation = (async () => {
      if (await port.exists(name) || !await port.exists(former)) return;
      const snapshot = await port.snapshot(former);
      // Refuse a corrupt/incomplete snapshot before any current file is installed.
      const header = "SQLite format 3\0";
      if (snapshot.length < 100 || [...header].some((character, index) => snapshot[index] !== character.charCodeAt(0))) {
        throw new Error("Invalid Replica database snapshot");
      }
      try { await port.install(name, snapshot); }
      catch (error) { if (!await port.exists(name)) throw error; }
    })().finally(() => { pending.delete(name); });
    pending.set(name, operation);
    return operation;
  };
}
