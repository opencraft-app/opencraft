import { openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";
import type { CapabilitySession } from "./index.js";
const schema = `CREATE TABLE capability_bindings(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,thread_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(server_id,thread_id)) STRICT;`;
const executionSchema = `CREATE TABLE execution_capability_bindings (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 session_json TEXT, UNIQUE(server_id,thread_id)
) STRICT;`;
/** A preallocated credential is bound once, after the engine assigns its Thread ID.
 * No model arguments, credentials or call payloads are stored here. */
export class CapabilityBindings {
  private readonly managed;
  constructor(path: string) {
    this.managed = openManagedDatabase({ path, legacyPolicy: "reject",
      migrations: [{ version: 1, name: "session-capability-bindings", sql: schema },
        { version: 2, name: "execution-capability-bindings", sql: executionSchema }], validateSchema: createSchemaValidator(schema + executionSchema) });
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
  prepareExecution(id: string, session: CapabilitySession): void {
    this.managed.database.prepare("INSERT INTO execution_capability_bindings VALUES(?,?,?,NULL)").run(id, session.serverId, session.threadId);
  }
  execution(id: string): { scope: CapabilitySession; session: CapabilitySession | null } | null {
    const row = this.managed.database.prepare("SELECT * FROM execution_capability_bindings WHERE id=?").get(id);
    return row ? { scope: { serverId: String(row.server_id), threadId: String(row.thread_id) },
      session: row.session_json === null ? null : JSON.parse(String(row.session_json)) } : null;
  }
  executionId(scope: CapabilitySession): string | null {
    const row = this.managed.database.prepare("SELECT id FROM execution_capability_bindings WHERE server_id=? AND thread_id=?").get(scope.serverId, scope.threadId);
    return row ? String(row.id) : null;
  }
  bindExecution(id: string, session: CapabilitySession): void {
    const prior = this.execution(id);
    if (!prior || prior.scope.serverId !== session.serverId || prior.scope.threadId !== session.threadId
      || prior.session && JSON.stringify(prior.session) !== JSON.stringify(session)) throw new Error("Execution capability binding changed");
    this.managed.database.prepare("UPDATE execution_capability_bindings SET session_json=? WHERE id=?").run(JSON.stringify(session), id);
  }
  removeExecution(id: string): void { this.managed.database.prepare("DELETE FROM execution_capability_bindings WHERE id=?").run(id); }
  close() { this.managed.database.close(); }
}
