import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { REMOTE_RESOURCE_LIMIT, resourceKey, validateResourceRecord,
  type ClientResourceKey, type ClientResourceRecord, type ClientResourcePersistence } from "./client-resources.js";

const BASELINE = `CREATE TABLE client_resources (
  identity TEXT PRIMARY KEY NOT NULL, namespace TEXT NOT NULL, authority TEXT NOT NULL,
  revision INTEGER NOT NULL, version INTEGER NOT NULL, saved_at INTEGER NOT NULL, value_json TEXT NOT NULL
) STRICT;
CREATE INDEX client_resources_remote ON client_resources(authority, saved_at);`;

/** Separate fixed Main-owned database. Neither preferences nor Host/extension authority. */
export class SqliteClientResources implements ClientResourcePersistence {
  private readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({ path,
      migrations: [{ version: 1, name: "client-resources", sql: BASELINE }] });
    this.database = managed.database;
    this.outcome = managed.outcome;
  }
  async read(key: ClientResourceKey): Promise<ClientResourceRecord | null> {
    const row = this.database.prepare("SELECT revision, version, saved_at, value_json FROM client_resources WHERE identity=?").get(resourceKey(key));
    if (!row) return null;
    const record = { revision: Number(row.revision), version: Number(row.version), savedAt: Number(row.saved_at), value: JSON.parse(String(row.value_json)) };
    validateResourceRecord(record, record.revision);
    return record;
  }
  async compareAndSet(key: ClientResourceKey, revision: number, record: Omit<ClientResourceRecord, "revision">): Promise<boolean> {
    const identity = resourceKey(key);
    validateResourceRecord(record, revision);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT revision, version FROM client_resources WHERE identity=?").get(identity);
      if (Number(current?.revision ?? 0) !== revision) { this.database.exec("ROLLBACK"); return false; }
      if (current && Number(current.version) > record.version) throw new Error("Client resource format downgrade rejected");
      this.database.prepare(`INSERT INTO client_resources VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(identity) DO UPDATE SET revision=excluded.revision,version=excluded.version,saved_at=excluded.saved_at,value_json=excluded.value_json`)
        .run(identity, key.namespace, key.authority, revision + 1, record.version, record.savedAt, JSON.stringify(record.value));
      // Bounded disposable copies across all accounts; originals are never an eviction candidate.
      this.database.prepare(`DELETE FROM client_resources WHERE identity IN
        (SELECT identity FROM client_resources WHERE authority='remote' ORDER BY saved_at DESC,identity LIMIT -1 OFFSET ?)`)
        .run(REMOTE_RESOURCE_LIMIT);
      this.database.exec("COMMIT");
      return true;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  async clearRemoteNamespace(namespace: string) {
    if (typeof namespace !== "string") throw new TypeError("Invalid client resource namespace");
    this.database.prepare("DELETE FROM client_resources WHERE namespace=? AND authority='remote'").run(namespace);
  }
  close() { this.database.close(); }
}
