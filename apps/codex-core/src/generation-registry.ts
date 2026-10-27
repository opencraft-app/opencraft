import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep, dirname, basename } from "node:path";
import { generationDirectory } from "./generation-files.js";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";

export interface GenerationDefinition {
  readonly id: string;
  readonly endpoint: string;
  readonly runtimeDataDirectory: string;
  readonly executable: string;
  readonly bundle: string;
  readonly node: string;
  readonly cwd: string;
  readonly executionUid?: number;
  readonly executionGid?: number;
  /** Only for explicitly adopting an independently running owner. */
  readonly externalUnit?: string;
}
export type GenerationState = "candidate" | "ready" | "active" | "draining" | "retiring" | "retired" | "discarded";
export interface GenerationRecord extends GenerationDefinition {
  readonly state: GenerationState;
  readonly incarnation: number;
}
export interface GenerationTicket {
  readonly ownerEpoch: string;
  readonly generationId: string;
  readonly incarnation: number;
  readonly admissionEpoch: number;
  readonly threadId?: string;
  readonly claimId?: string;
}
const SCHEMA = `
CREATE TABLE generations (
 id TEXT PRIMARY KEY, definition TEXT NOT NULL,
 runtime_root TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL, incarnation INTEGER NOT NULL
) STRICT;
CREATE TABLE admission (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation_id TEXT, epoch INTEGER NOT NULL) STRICT;
INSERT INTO admission VALUES(1,NULL,0);
CREATE TABLE thread_routes (thread_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id), epoch INTEGER NOT NULL) STRICT;
CREATE TABLE creation_claims (id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id), epoch INTEGER NOT NULL, state TEXT NOT NULL, thread_id TEXT) STRICT;
CREATE TABLE routing_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

export const CODEX_GENERATION_MIGRATIONS = [{ version: 1, name: "codex-generation-routing", sql: SCHEMA },
  { version: 2, name: "orchestration-creation-incarnation", sql: "ALTER TABLE creation_claims ADD COLUMN incarnation INTEGER" }];

/** One durable routing writer. It stores identities and fences, never user input. */
export class CodexGenerationRegistry {
  readonly ownerEpoch = randomUUID();
  readonly outcome: DatabaseOutcome;
  private readonly database: DatabaseSync;
  private readonly lock: DatabaseSync;
  private closed = false;
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("Generation registry directory must be absolute");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(join(realpathSync(directory), ".codex-routing-owner.sqlite"));
    try {
      this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      const managed = openManagedDatabase({ path: join(directory, "codex-generations.sqlite"),
        legacyPolicy: "reject", migrations: CODEX_GENERATION_MIGRATIONS });
      this.database = managed.database; this.outcome = managed.outcome;
      this.database.exec("PRAGMA foreign_keys=ON");
      chmodSync(join(directory, ".codex-routing-owner.sqlite"), 0o600);
      chmodSync(join(directory, "codex-generations.sqlite"), 0o600);
    } catch (error) { this.lock.close(); throw error; }
  }
  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  register(definition: GenerationDefinition): GenerationRecord {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(definition.id)
      || ![definition.endpoint, definition.runtimeDataDirectory, definition.executable, definition.bundle, definition.node, definition.cwd].every(isAbsolute)) {
      throw new Error("Invalid generation definition");
    }
    const executionUid = definition.executionUid ?? process.getuid!(), executionGid = definition.executionGid ?? process.getgid!();
    if (![executionUid, executionGid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid generation execution identity");
    generationDirectory(definition.runtimeDataDirectory, executionUid, executionGid);
    generationDirectory(dirname(definition.endpoint), executionUid, executionGid);
    const normalized = { ...definition, executionUid, executionGid, endpoint: join(realpathSync(dirname(definition.endpoint)), basename(definition.endpoint)), runtimeDataDirectory: realpathSync(definition.runtimeDataDirectory) };
    if (basename(normalized.endpoint) === "native.sock") throw new Error("Generation control and native socket must differ");
    const home = join(normalized.runtimeDataDirectory, "runtime"); generationDirectory(home, executionUid, executionGid);
    if (realpathSync(home) !== home) throw new Error("Generation HOME must not alias another directory");
    for (const prior of this.list()) {
      if (prior.id !== definition.id && dirname(prior.endpoint) === dirname(normalized.endpoint)) throw new Error("Generations need separate native socket directories");
      const priorHome = join(prior.runtimeDataDirectory, "runtime");
      if (prior.id !== definition.id && (home.startsWith(priorHome + sep) || priorHome.startsWith(home + sep))) throw new Error("Generation HOMEs must not overlap");
    }
    const existing = this.get(definition.id);
    if (existing) {
      const { state: _state, incarnation: _incarnation, ...prior } = existing;
      if (JSON.stringify(prior) !== JSON.stringify(normalized)) throw new Error("Generation identity is immutable until retired");
      return existing;
    }
    this.database.prepare("INSERT INTO generations VALUES(?,?,?,?,'candidate',0)")
      .run(definition.id, JSON.stringify(normalized), normalized.runtimeDataDirectory, normalized.endpoint);
    return this.get(definition.id)!;
  }
  get(id: string): GenerationRecord | null {
    const row = this.database.prepare("SELECT definition,state,incarnation FROM generations WHERE id=?").get(id);
    return row ? { ...JSON.parse(String(row.definition)), state: String(row.state) as GenerationState, incarnation: Number(row.incarnation) } : null;
  }
  list(): GenerationRecord[] {
    return this.database.prepare("SELECT id FROM generations ORDER BY id").all().map(row => this.get(String(row.id))!);
  }
  ready(id: string): GenerationRecord {
    const prior = this.get(id);
    if (!prior || prior.state !== "candidate") throw new Error("Generation must be a candidate before becoming ready");
    this.database.prepare("UPDATE generations SET state='ready',incarnation=incarnation+1 WHERE id=?").run(id);
    return this.get(id)!;
  }
  current(): { generation: GenerationRecord; epoch: number } {
    const row = this.database.prepare("SELECT generation_id,epoch FROM admission WHERE singleton=1").get()!;
    const generation = row.generation_id === null ? null : this.get(String(row.generation_id));
    if (!generation || generation.state !== "active") throw new Error("No generation is accepting new Threads");
    return { generation, epoch: Number(row.epoch) };
  }
  activate(id: string, expectedEpoch: number): number {
    return this.transaction(() => {
      const admission = this.database.prepare("SELECT generation_id,epoch FROM admission WHERE singleton=1").get()!;
      if (Number(admission.epoch) !== expectedEpoch) throw new Error("Generation admission epoch changed");
      const next = this.get(id);
      if (!next || !["ready", "active", "draining"].includes(next.state)) throw new Error("Generation is not ready");
      if (admission.generation_id === id) return expectedEpoch;
      // Every previously admitted HOME follows future upgrades, including cold reopened HOMEs.
      this.database.prepare("UPDATE generations SET state='draining' WHERE state='active' OR (state='ready' AND incarnation>1)").run();
      this.database.prepare("UPDATE generations SET state='active' WHERE id=?").run(id);
      this.database.prepare("UPDATE admission SET generation_id=?,epoch=epoch+1 WHERE singleton=1").run(id);
      return expectedEpoch + 1;
    });
  }
  epoch(): number { return Number(this.database.prepare("SELECT epoch FROM admission WHERE singleton=1").get()!.epoch); }
  creationTicket(operationId: string, allowRejected = false): GenerationTicket | null {
    const row = this.database.prepare("SELECT * FROM creation_claims WHERE id=?").get(`orchestration:${operationId}`);
    if (!row) return null;
    const generation = this.get(String(row.generation_id));
    if (!generation || row.incarnation !== generation.incarnation || row.state === "rejected" && !allowRejected) throw new Error("Orchestration creation outcome is unconfirmed in this incarnation");
    return { ownerEpoch: this.ownerEpoch, generationId: generation.id, incarnation: generation.incarnation, admissionEpoch: Number(row.epoch), claimId: String(row.id) };
  }
  acceptCreation(generationId?: string, operationId?: string): GenerationTicket {
    return this.transaction(() => {
      if (operationId) {
        if (operationId.length > 256 || /[\x00-\x20]/u.test(operationId)) throw new Error("Invalid orchestration creation identity");
        const prior = this.creationTicket(operationId,true);
        if (prior) { if (generationId && generationId !== prior.generationId) throw new Error("Orchestration creation belongs to another generation"); return prior; }
      }
      const current = this.current(), generation = generationId ? this.get(generationId) : current.generation;
      if (!generation || !["active", "ready", "draining"].includes(generation.state)) throw new Error("Generation is not accepting execution");
      const claimId = operationId ? `orchestration:${operationId}` : randomUUID();
      this.database.prepare("INSERT INTO creation_claims(id,generation_id,epoch,state,thread_id,incarnation) VALUES(?,?,?,'accepted',NULL,?)").run(claimId, generation.id, current.epoch, generation.incarnation);
      return { ownerEpoch: this.ownerEpoch, generationId: generation.id, incarnation: generation.incarnation, admissionEpoch: current.epoch, claimId };
    });
  }
  markSent(ticket: GenerationTicket): void {
    if (!this.valid(ticket) || !ticket.claimId) throw new Error("Stale generation admission");
    this.database.prepare("UPDATE creation_claims SET state='sent' WHERE id=? AND state='accepted'").run(ticket.claimId);
  }
  rejectUnsent(ticket: GenerationTicket): void {
    if (ticket.claimId) this.database.prepare("DELETE FROM creation_claims WHERE id=? AND state='accepted'").run(ticket.claimId);
  }
  resolveCreation(ticket: GenerationTicket, threadId: string, ephemeral = false): void {
    if (!ticket.claimId || !this.valid(ticket)) throw new Error("Stale generation creation result");
    this.transaction(() => {
      this.bind(threadId, ticket.generationId, ticket.admissionEpoch);
      if (ephemeral) this.markNonpersistent(threadId, "ephemeral");
      this.database.prepare("UPDATE creation_claims SET state='resolved',thread_id=? WHERE id=?").run(threadId, ticket.claimId!);
    });
  }
  resolveRejectedCreation(ticket: GenerationTicket): void {
    if (ticket.claimId && this.valid(ticket)) this.database.prepare("UPDATE creation_claims SET state='rejected' WHERE id=?").run(ticket.claimId);
  }
  private bind(threadId: string, generationId: string, epoch: number): void {
    if (!threadId) throw new Error("Missing Thread identity");
    const prior = this.database.prepare("SELECT generation_id FROM thread_routes WHERE thread_id=?").get(threadId);
    if (prior && prior.generation_id !== generationId) throw new Error("Thread identity exists in another generation");
    if (!prior) this.database.prepare("INSERT INTO thread_routes VALUES(?,?,?)").run(threadId, generationId, epoch);
  }
  discover(threadId: string, generationId: string): GenerationTicket {
    const generation = this.get(generationId);
    if (!generation) throw new Error("Unknown generation");
    this.bind(threadId, generationId, this.epoch());
    return this.route(threadId)!;
  }
  route(threadId: string): GenerationTicket | null {
    const row = this.database.prepare("SELECT generation_id,epoch FROM thread_routes WHERE thread_id=?").get(threadId);
    if (!row) return null;
    const generation = this.get(String(row.generation_id))!;
    return { ownerEpoch: this.ownerEpoch, generationId: generation.id, incarnation: generation.incarnation, admissionEpoch: Number(row.epoch), threadId };
  }
  valid(ticket: GenerationTicket): boolean {
    if (this.closed || ticket.ownerEpoch !== this.ownerEpoch) return false;
    const generation = this.get(ticket.generationId);
    if (!generation || generation.incarnation !== ticket.incarnation || !["ready", "active", "draining"].includes(generation.state)) return false;
    if (ticket.threadId) {
      const route = this.route(ticket.threadId);
      if (!route || route.generationId !== ticket.generationId || route.admissionEpoch !== ticket.admissionEpoch) return false;
    }
    return true;
  }
  unresolvedCreations(id: string): number {
    return Number(this.database.prepare("SELECT count(*) AS n FROM creation_claims WHERE generation_id=? AND state IN ('accepted','sent')").get(id)!.n);
  }
  fenceRetirement(id: string, incarnation: number): void {
    const generation = this.get(id);
    if (!generation || generation.state !== "draining" || generation.incarnation !== incarnation || this.unresolvedCreations(id)) throw new Error("Generation is not drained");
    this.database.prepare("UPDATE generations SET state='retiring' WHERE id=?").run(id);
  }
  retire(id: string, incarnation: number): void {
    const generation = this.get(id);
    if (!generation || !["draining", "retiring"].includes(generation.state) || generation.incarnation !== incarnation || this.unresolvedCreations(id)) throw new Error("Generation is not drained");
    this.database.prepare("UPDATE generations SET state='retired' WHERE id=?").run(id);
  }
  replaceRetired(id: string, replacement: Pick<GenerationDefinition, "executable" | "bundle" | "node">): GenerationRecord {
    const generation = this.get(id);
    if (!generation || generation.state !== "retired") throw new Error("Only a retired HOME can change runtime payload");
    const { state: _state, incarnation: _incarnation, externalUnit: _unit, ...definition } = generation;
    const next = { ...definition, ...replacement };
    if (![next.executable, next.bundle, next.node].every(isAbsolute)) throw new Error("Runtime payload paths must be absolute");
    this.database.prepare("UPDATE generations SET definition=?,state='candidate' WHERE id=?").run(JSON.stringify(next), id);
    return this.get(id)!;
  }
  discard(id: string): void {
    const generation = this.get(id);
    if (!generation || generation.state !== "candidate" || this.unresolvedCreations(id)) throw new Error("Only an unadmitted candidate can be discarded");
    this.database.prepare("UPDATE generations SET state='discarded' WHERE id=?").run(id);
  }
  metadata(key: string): unknown {
    const row = this.database.prepare("SELECT value FROM routing_metadata WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : null;
  }
  setMetadata(key: string, value: unknown): void {
    this.database.prepare("INSERT INTO routing_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  routes(): { threadId: string; generationId: string }[] {
    return this.database.prepare("SELECT thread_id,generation_id FROM thread_routes ORDER BY thread_id").all().map(row => ({ threadId: String(row.thread_id), generationId: String(row.generation_id) }));
  }
  threadIds(generationId: string): string[] {
    return this.database.prepare("SELECT thread_id FROM thread_routes WHERE generation_id=? ORDER BY thread_id").all(generationId).map(row => String(row.thread_id));
  }
  markNonpersistent(threadId: string, reason: "ephemeral" | "deleted"): void { this.setMetadata(`thread-retention:${threadId}`, reason); }
  isNonpersistent(threadId: string): boolean { return this.metadata(`thread-retention:${threadId}`) !== null; }
  durableThreadIds(generationId: string): string[] { return this.threadIds(generationId).filter(id => !this.isNonpersistent(id)); }
  runtimeChanged(id: string): GenerationRecord {
    const row = this.get(id);
    if (!row || !["ready", "active", "draining"].includes(row.state)) throw new Error("Generation has no live incarnation");
    this.database.prepare("UPDATE generations SET incarnation=incarnation+1 WHERE id=?").run(id);
    return this.get(id)!;
  }
  close(): void { if (!this.closed) { this.closed = true; this.database.close(); this.lock.close(); } }
}
