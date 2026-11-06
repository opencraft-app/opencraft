import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";
const BASELINE = `CREATE TABLE dsh_session_generations (
      logical_id TEXT NOT NULL, native_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL,
      seed_seq INTEGER NOT NULL, seed_turn INTEGER NOT NULL, prior_seq INTEGER NOT NULL, prior_turn INTEGER NOT NULL,
      PRIMARY KEY(logical_id,generation)
    );
    CREATE TABLE dsh_pending_generations (native_id TEXT PRIMARY KEY, logical_id TEXT NOT NULL, intent TEXT)`;

import { DshRoutingProjection, DshRoutingRejection, type DshRoutingSnapshot, type DshSessionGeneration } from "./dsh-routing-projection.js";
export type { DshSessionGeneration } from "./dsh-routing-projection.js";

/** Synchronous SQLite owner. Construct only inside the routing Worker in live Hosts. */
export class DshSessionRouting extends DshRoutingProjection {
  private readonly db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  private closed = false;
  constructor(path: string) {
    super();
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
    try { this.replaceSnapshot(this.snapshot()); } catch (error) { this.db.close(); throw error; }
  }
  protected override assertReadable(): void { if (this.closed) throw new Error("DSH routing storage is closed"); }
  private decode(row: any): DshSessionGeneration {
    return { logicalId: row.logical_id, nativeId: row.native_id, generation: row.generation,
      seedThroughSeq: row.seed_seq, seedThroughTurn: row.seed_turn, previousLastSeq: row.prior_seq, previousLastTurn: row.prior_turn };
  }
  snapshot(): DshRoutingSnapshot {
    return { generations: this.db.prepare("SELECT * FROM dsh_session_generations ORDER BY logical_id,generation").all().map(row => this.decode(row)),
      pending: this.db.prepare("SELECT * FROM dsh_pending_generations").all().map((row: any) => ({ logicalId: row.logical_id, nativeId: row.native_id, intent: row.intent ? JSON.parse(row.intent) : null })) };
  }
  stage(logicalId: string, nativeId: string, intent?: { expectedNativeId: string; generation: number; previousLastSeq: number; previousLastTurn: number }): void {
    this.db.prepare("INSERT INTO dsh_pending_generations(native_id,logical_id,intent) VALUES(?,?,?) ON CONFLICT(native_id) DO UPDATE SET intent=excluded.intent").run(nativeId, logicalId, intent ? JSON.stringify(intent) : null);
    this.replaceSnapshot(this.snapshot());
  }
  reconcile(logicalId: string, checkpoint: { sessionId: string; generation: number; seedThroughSeq?: number; seedThroughTurn?: number }): boolean {
    const pending = this.pending().find(value => value.logicalId === logicalId && value.nativeId === checkpoint.sessionId);
    if (!pending) return false;
    if (!pending.intent || checkpoint.generation !== pending.intent.generation ||
        checkpoint.seedThroughSeq === undefined || checkpoint.seedThroughTurn === undefined) throw new DshRoutingRejection("INCOMPLETE_EVIDENCE", "Incomplete generation publication evidence");
    this.publish(pending.intent.expectedNativeId, { logicalId, nativeId: pending.nativeId, generation: checkpoint.generation,
      seedThroughSeq: checkpoint.seedThroughSeq, seedThroughTurn: checkpoint.seedThroughTurn,
      previousLastSeq: pending.intent.previousLastSeq, previousLastTurn: pending.intent.previousLastTurn });
    return true;
  }
  publish(expectedNativeId: string, next: DshSessionGeneration): void {
    for (const value of [next.generation, next.seedThroughTurn, next.previousLastTurn]) if (!Number.isSafeInteger(value) || value < 0) throw new DshRoutingRejection("INVALID_ROUTE", "Invalid generation routing coordinate");
    for (const value of [next.seedThroughSeq, next.previousLastSeq]) if (!Number.isSafeInteger(value) || value < -1) throw new DshRoutingRejection("INVALID_ROUTE", "Invalid generation routing watermark");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.current(next.logicalId);
      if (current.nativeId !== expectedNativeId || next.generation !== current.generation + 1 || next.nativeId === expectedNativeId) throw new DshRoutingRejection("AUTHORITY_CHANGED", "Generation routing authority changed");
      const insert = this.db.prepare("INSERT INTO dsh_session_generations VALUES(?,?,?,?,?,?,?)");
      if (current.generation === 0 && this.generations(next.logicalId)[0]?.nativeId === current.logicalId) {
        this.db.prepare("INSERT OR IGNORE INTO dsh_session_generations VALUES(?,?,?,?,?,?,?)").run(current.logicalId, current.nativeId, 0, -1, 0, -1, 0);
      }
      insert.run(next.logicalId, next.nativeId, next.generation, next.seedThroughSeq, next.seedThroughTurn, next.previousLastSeq, next.previousLastTurn);
      this.db.prepare("DELETE FROM dsh_pending_generations WHERE native_id=?").run(next.nativeId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.replaceSnapshot(this.snapshot());
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }
}
