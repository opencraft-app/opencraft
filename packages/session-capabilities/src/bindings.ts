import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import type { CapabilitySession } from "./index.js";

/** A preallocated credential is bound once, after the engine assigns its Thread ID.
 * No model arguments, credentials or call payloads are stored here. */
export class CapabilityBindings {
  private readonly managed;
  constructor(path: ServerDatabaseSource) {
    this.managed = openServerRepository(path, "session-capabilities");
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
  close() { this.managed.close(); }
}
