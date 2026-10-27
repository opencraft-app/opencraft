import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { DshClientError, type DshEvent, type DshStreamEnvelope } from "./dsh-client.js";
const BASELINE = `CREATE TABLE dsh_session_generations (
      logical_id TEXT NOT NULL, native_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
      seed_seq INTEGER NOT NULL, seed_turn INTEGER NOT NULL, prior_seq INTEGER NOT NULL, prior_turn INTEGER NOT NULL,
      PRIMARY KEY(logical_id,generation)
    );
    CREATE TABLE dsh_pending_generations (native_id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, intent TEXT)`;

export interface DshSessionGeneration {
  logicalId: string; nativeId: string; generation: number;
  seedThroughSeq: number; seedThroughTurn: number; previousLastSeq: number; previousLastTurn: number;
}

/** Durable presentation identity is independent of the engine seed identity.
 * Native seed is model context, not newly authored chat history.
 */
export class DshSessionRouting {
  private readonly db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({
      path, migrations: [{ version: 1, name: "session-routing", sql: BASELINE }],
      legacyMigration: {
        accepts: (fingerprint, objects) =>
          createMissingLegacyObjects(BASELINE).accepts(fingerprint, objects)
          || createMissingLegacyObjects(BASELINE.replace(", intent TEXT", "")).accepts(fingerprint, objects),
        migrate: database => {
          database.exec(BASELINE.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
          if (!database.prepare("PRAGMA table_info(dsh_pending_generations)").all().some(column => column.name === "intent")) {
            database.exec("ALTER TABLE dsh_pending_generations ADD COLUMN intent TEXT");
          }
        },
      },
    });
    this.db = managed.database;
    this.outcome = managed.outcome;
  }
  private decode(row: any): DshSessionGeneration {
    return { logicalId: row.logical_id, nativeId: row.native_id, generation: row.generation,
      seedThroughSeq: row.seed_seq, seedThroughTurn: row.seed_turn, previousLastSeq: row.prior_seq, previousLastTurn: row.prior_turn };
  }
  current(logicalId: string): DshSessionGeneration {
    const row = this.db.prepare("SELECT * FROM dsh_session_generations WHERE logical_id=? ORDER BY generation DESC LIMIT 1").get(logicalId);
    return row ? this.decode(row) : { logicalId, nativeId: logicalId, generation: 0, seedThroughSeq: -1, seedThroughTurn: 0, previousLastSeq: -1, previousLastTurn: 0 };
  }
  forkCoordinates(logicalId: string, lastTurn?: number, beforeTurn?: number): { nativeId: string; lastTurn: number | undefined; beforeTurn: number | undefined } {
    const boundary = lastTurn ?? beforeTurn;
    const generations = this.generations(logicalId);
    const generation = boundary === undefined ? this.current(logicalId)
      : [...generations].reverse().find(generation => generation.generation === 0 || boundary > generation.previousLastTurn) ?? generations[0]!;
    const offset = generation.generation === 0 ? 0 : generation.previousLastTurn - generation.seedThroughTurn;
    return { nativeId: generation.nativeId, lastTurn: lastTurn === undefined ? undefined : lastTurn - offset,
      beforeTurn: beforeTurn === undefined ? undefined : beforeTurn - offset };
  }
  generations(logicalId: string): DshSessionGeneration[] {
    const rows = this.db.prepare("SELECT * FROM dsh_session_generations WHERE logical_id=? ORDER BY generation").all(logicalId);
    return rows.length ? rows.map(row => this.decode(row)) : [this.current(logicalId)];
  }
  native(logicalId: string): string { return this.current(logicalId).nativeId; }
  stage(logicalId: string, nativeId: string, intent?: { expectedNativeId: string; generation: number; previousLastSeq: number; previousLastTurn: number }): void {
    this.db.prepare("INSERT INTO dsh_pending_generations(native_id,logical_id,intent) VALUES(?,?,?) ON CONFLICT(native_id) DO UPDATE SET intent=excluded.intent").run(nativeId, logicalId, intent ? JSON.stringify(intent) : null);
  }
  pending(): Array<{ logicalId: string; nativeId: string; intent: { expectedNativeId: string; generation: number; previousLastSeq: number; previousLastTurn: number } | null }> {
    return this.db.prepare("SELECT * FROM dsh_pending_generations").all().map((row: any) => ({ logicalId: row.logical_id, nativeId: row.native_id, intent: row.intent ? JSON.parse(row.intent) : null }));
  }
  reconcile(logicalId: string, checkpoint: { sessionId: string; generation: number; seedThroughSeq?: number; seedThroughTurn?: number }): boolean {
    const pending = this.pending().find(value => value.logicalId === logicalId && value.nativeId === checkpoint.sessionId);
    if (!pending) return false;
    if (!pending.intent || checkpoint.generation !== pending.intent.generation ||
        checkpoint.seedThroughSeq === undefined || checkpoint.seedThroughTurn === undefined) throw new Error("Incomplete generation publication evidence");
    this.publish(pending.intent.expectedNativeId, { logicalId, nativeId: pending.nativeId, generation: checkpoint.generation,
      seedThroughSeq: checkpoint.seedThroughSeq, seedThroughTurn: checkpoint.seedThroughTurn,
      previousLastSeq: pending.intent.previousLastSeq, previousLastTurn: pending.intent.previousLastTurn });
    return true;
  }
  hidden(nativeId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM dsh_pending_generations WHERE native_id=?").get(nativeId);
  }
  logical(nativeId: string): string {
    const row = this.db.prepare("SELECT logical_id FROM dsh_session_generations WHERE native_id=?").get(nativeId);
    return typeof row?.logical_id === "string" ? row.logical_id : nativeId;
  }
  publish(expectedNativeId: string, next: DshSessionGeneration): void {
    for (const value of [next.generation, next.seedThroughTurn, next.previousLastTurn]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid generation routing coordinate");
    for (const value of [next.seedThroughSeq, next.previousLastSeq]) if (!Number.isSafeInteger(value) || value < -1) throw new Error("Invalid generation routing watermark");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.current(next.logicalId);
      if (current.nativeId !== expectedNativeId || next.generation !== current.generation + 1 || next.nativeId === expectedNativeId) throw new Error("Generation routing authority changed");
      const insert = this.db.prepare("INSERT INTO dsh_session_generations VALUES(?,?,?,?,?,?,?)");
      if (current.generation === 0 && this.generations(next.logicalId)[0]?.nativeId === current.logicalId) {
        this.db.prepare("INSERT OR IGNORE INTO dsh_session_generations VALUES(?,?,?,?,?,?,?)").run(current.logicalId, current.nativeId, 0, -1, 0, -1, 0);
      }
      insert.run(next.logicalId, next.nativeId, next.generation, next.seedThroughSeq, next.seedThroughTurn, next.previousLastSeq, next.previousLastTurn);
      this.db.prepare("DELETE FROM dsh_pending_generations WHERE native_id=?").run(next.nativeId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  event(nativeId: string, event: DshEvent): DshEvent | null {
    const row = this.db.prepare("SELECT * FROM dsh_session_generations WHERE native_id=?").get(nativeId);
    if (!row) return event;
    return this.eventInGeneration(this.decode(row), event);
  }
  /** A history read already owns this immutable generation; no per-event SQL. */
  eventInGeneration(generation: DshSessionGeneration, event: DshEvent): DshEvent | null {
    if (generation.generation === 0) return event;
    if (event.seq <= generation.seedThroughSeq) return null;
    const offset = generation.previousLastSeq - generation.seedThroughSeq;
    const raw = event as DshEvent & { sourceEventSeqs?: number[]; surfaceOp?: any };
    const data = { ...(event.data as Record<string, unknown>) };
    if (typeof data.turn === "number") data.turn += generation.previousLastTurn - generation.seedThroughTurn;
    return { ...raw, seq: raw.seq + offset, data,
      ...(raw.sourceEventSeqs ? { sourceEventSeqs: raw.sourceEventSeqs.map(seq => seq + offset) } : {}),
      ...(raw.surfaceOp && typeof raw.surfaceOp === "object" ? { surfaceOp: { ...raw.surfaceOp, start: raw.surfaceOp.start + offset, end: raw.surfaceOp.end + offset } } : {}),
    };
  }
  /** Validate the bridge's native cut against the route captured before awaiting it. */
  resolveHistoryHead(generation: DshSessionGeneration, value: unknown): { nextSeq: number } | undefined {
    const current = this.current(generation.logicalId);
    if (current.nativeId !== generation.nativeId || current.generation !== generation.generation)
      throw new DshClientError("DSH_GENERATION_CHANGED", "DSH generation changed during describe; retry required", true);
    if (!value || typeof value !== "object") return undefined;
    const head = value as { sessionId?: unknown; nextSeq?: unknown };
    if (head.sessionId !== generation.nativeId || !Number.isSafeInteger(head.nextSeq) || Number(head.nextSeq) < 0)
      return undefined;
    if (generation.generation > 0 && Number(head.nextSeq) <= generation.seedThroughSeq) return undefined;
    const nextSeq = Number(head.nextSeq) + (generation.generation === 0 ? 0 : generation.previousLastSeq - generation.seedThroughSeq);
    return Number.isSafeInteger(nextSeq) && nextSeq >= 0 ? { nextSeq } : undefined;
  }
  frame(frame: DshStreamEnvelope): DshStreamEnvelope | null {
    const nativeId = frame.payload.sessionId;
    if (typeof nativeId !== "string") return frame;
    if (this.hidden(nativeId)) return null;
    const logicalId = this.logical(nativeId);
    if (this.native(logicalId) !== nativeId) return null; // Retired native producer.
    const payload: Record<string, unknown> = { ...frame.payload, sessionId: logicalId };
    if (payload.type === "session/event") {
      const event = this.event(nativeId, payload.event as DshEvent);
      if (!event) return null;
      payload.event = event;
    }
    return { ...frame, payload };
  }
  close(): void { this.db.close(); }
}
