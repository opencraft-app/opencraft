import { openServerRepository, type ServerDatabaseSource } from "@opencraft/storage-node/server-repository";
import type { CapabilitySession } from "./index.js";
/** The binding reads and writes `SessionCapabilityMcp` uses, synchronous for its callers. */
export interface CapabilityBindingStore {
  bind(id: string, session: CapabilitySession): void;
  get(id: string): CapabilitySession | null;
  id(session: CapabilitySession): string | null;
  prepareExecution(id: string, session: CapabilitySession): void;
  execution(id: string): { scope: CapabilitySession; session: CapabilitySession | null } | null;
  executionId(scope: CapabilitySession): string | null;
  bindExecution(id: string, session: CapabilitySession): void;
  removeExecution(id: string): void;
}

/** Every stored binding, as the owner hands it to a projection. */
export interface CapabilityBindingSnapshot {
  readonly bindings: readonly (readonly [id: string, serverId: string, threadId: string])[];
  readonly executions: readonly (readonly [id: string, serverId: string, threadId: string, sessionJson: string | null])[];
}

/** One write, replayed in order by the owner of the bindings. */
export type CapabilityBindingWrite =
  | readonly ["bind", string, CapabilitySession]
  | readonly ["prepareExecution", string, CapabilitySession]
  | readonly ["bindExecution", string, CapabilitySession]
  | readonly ["removeExecution", string];

/** A preallocated credential is bound once, after the engine assigns its Thread ID.
 * No model arguments, credentials or call payloads are stored here. */
export class CapabilityBindings implements CapabilityBindingStore {
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
  snapshot(): CapabilityBindingSnapshot {
    const db = this.managed.database;
    return {
      bindings: db.prepare("SELECT id,server_id,thread_id FROM capability_bindings").all()
        .map(row => [String(row.id), String(row.server_id), String(row.thread_id)] as const),
      executions: db.prepare("SELECT id,server_id,thread_id,session_json FROM execution_capability_bindings").all()
        .map(row => [String(row.id), String(row.server_id), String(row.thread_id), row.session_json === null ? null : String(row.session_json)] as const),
    };
  }
  apply(write: CapabilityBindingWrite): void {
    switch (write[0]) {
      case "bind": return this.bind(write[1], write[2]);
      case "prepareExecution": return this.prepareExecution(write[1], write[2]);
      case "bindExecution": return this.bindExecution(write[1], write[2]);
      case "removeExecution": return this.removeExecution(write[1]);
      default: throw new Error("Unknown capability binding write");
    }
  }
  close() { this.managed.close(); }
}
