import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";
import type { CapabilitySession } from "./index.js";
const schema = `CREATE TABLE capability_bindings(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,thread_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(server_id,thread_id)) STRICT;`;
/** A preallocated credential is bound once, after the engine assigns its Thread ID.
 * No model arguments, credentials or call payloads are stored here. */
export class CapabilityBindings {
  private readonly managed;
  constructor(path: string) {
    this.managed = openManagedDatabase({ path, legacyPolicy: "reject",
      migrations: [{ version: 1, name: "session-capability-bindings", sql: schema }], validateSchema: createSchemaValidator(schema) });
  }
  get outcome() { return this.managed.outcome; }
  bind(id: string, session: CapabilitySession): void {
    this.managed.database.prepare("INSERT INTO capability_bindings VALUES(?,?,?,?)").run(id, session.serverId, session.threadId, Date.now());
  }
  get(id: string): CapabilitySession | null {
    const row = this.managed.database.prepare("SELECT server_id,thread_id FROM capability_bindings WHERE id=?").get(id);
    return row ? { serverId: String(row.server_id), threadId: String(row.thread_id) } : null;
  }
  id(session: CapabilitySession): string | null {
    const row = this.managed.database.prepare("SELECT id FROM capability_bindings WHERE server_id=? AND thread_id=?").get(session.serverId, session.threadId);
    return row ? String(row.id) : null;
  }
  close() { this.managed.database.close(); }
}
