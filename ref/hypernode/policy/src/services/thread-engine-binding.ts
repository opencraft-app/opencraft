import { Service, type Inject } from "@deepseek-ai/cordis";
import {
  asCheckpointId,
  asEngineKind,
  asThreadId,
  type CheckpointId,
  type EngineKind,
  type ThreadId,
} from "../types/domain.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type { DurableSql, DurableStoragePort, SqlRow } from "../types/storage.js";

export interface ThreadEngineBindingRecord {
  threadId: ThreadId;
  engineKind: EngineKind;
  generation: number;
  provenance: string;
  updatedAtMs: number;
}

interface ThreadEngineBindingRow extends SqlRow {
  engine_kind: string;
  generation: number;
  provenance: string;
  updated_at_ms: number;
}

export interface ClaimEngineOptions {
  inferredEngineKind?: EngineKind;
  inferredProvenance?: string;
  provenance?: string;
}

export interface MigrateEngineOptions {
  checkpointId?: CheckpointId | string;
}

export interface ThreadEngineBindingPort {
  get(threadId: ThreadId | string): ThreadEngineBindingRecord | null;
  claim(
    threadId: ThreadId | string,
    engine: EngineKind | string,
    options?: ClaimEngineOptions,
  ): ThreadEngineBindingRecord;
  migrate(
    threadId: ThreadId | string,
    fromEngine: EngineKind | string,
    toEngine: EngineKind | string,
    options?: MigrateEngineOptions,
  ): ThreadEngineBindingRecord;
}

export class EngineMigrationRequiredError extends Error {
  readonly code = -32084;
  readonly data: {
    kind: "engineMigrationRequired";
    threadId: ThreadId;
    fromEngine: EngineKind;
    toEngine: EngineKind;
  };

  constructor(threadId: ThreadId, fromEngine: EngineKind, toEngine: EngineKind) {
    super(`Thread ${threadId} is bound to ${fromEngine}; switching to ${toEngine} requires an explicit migration.`);
    this.name = "EngineMigrationRequiredError";
    this.data = { kind: "engineMigrationRequired", threadId, fromEngine, toEngine };
  }
}

export function engineMigrationRequiredError(
  threadId: ThreadId | string,
  fromEngine: EngineKind,
  toEngine: EngineKind,
): EngineMigrationRequiredError {
  return new EngineMigrationRequiredError(asThreadId(threadId), fromEngine, toEngine);
}

export class ThreadEngineBindingTable {
  private readonly sql: DurableSql | null;
  private readonly memory = new Map<ThreadId, ThreadEngineBindingRecord>();

  constructor(storage?: Pick<DurableStoragePort, "available" | "sql"> | null) {
    this.sql = storage?.available === true ? storage.sql : null;
    if (this.sql) this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_engine_bindings (
        thread_id TEXT PRIMARY KEY,
        engine_kind TEXT NOT NULL,
        generation INTEGER NOT NULL,
        provenance TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  get(threadIdInput: ThreadId | string): ThreadEngineBindingRecord | null {
    const threadId = asThreadId(threadIdInput);
    if (!this.sql) return this.memory.get(threadId) ?? null;
    const row = this.sql.exec<ThreadEngineBindingRow>(`
      SELECT engine_kind, generation, provenance, updated_at_ms
      FROM hypernode_thread_engine_bindings WHERE thread_id = ?
    `, threadId).toArray()[0];
    return row ? {
      threadId,
      engineKind: asEngineKind(row.engine_kind),
      generation: Number(row.generation),
      provenance: String(row.provenance),
      updatedAtMs: Number(row.updated_at_ms),
    } : null;
  }

  write(record: ThreadEngineBindingRecord): ThreadEngineBindingRecord {
    if (!this.sql) {
      this.memory.set(record.threadId, record);
      return record;
    }
    this.sql.exec(`
      INSERT INTO hypernode_thread_engine_bindings(
        thread_id, engine_kind, generation, provenance, updated_at_ms
      ) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        engine_kind = excluded.engine_kind,
        generation = excluded.generation,
        provenance = excluded.provenance,
        updated_at_ms = excluded.updated_at_ms
    `, record.threadId, record.engineKind, record.generation, record.provenance, record.updatedAtMs);
    return record;
  }

  claim(
    threadIdInput: ThreadId | string,
    requestedEngineInput: EngineKind | string,
    options: ClaimEngineOptions = {},
  ): ThreadEngineBindingRecord {
    const threadId = asThreadId(threadIdInput);
    const requestedEngine = asEngineKind(requestedEngineInput);
    let current = this.get(threadId);
    if (!current && options.inferredEngineKind) {
      current = this.write({
        threadId,
        engineKind: asEngineKind(options.inferredEngineKind),
        generation: 1,
        provenance: options.inferredProvenance ?? "legacy-inference",
        updatedAtMs: Date.now(),
      });
    }
    if (!current) return this.write({
      threadId,
      engineKind: requestedEngine,
      generation: 1,
      provenance: options.provenance ?? "initial",
      updatedAtMs: Date.now(),
    });
    if (current.engineKind !== requestedEngine) {
      throw engineMigrationRequiredError(threadId, current.engineKind, requestedEngine);
    }
    return current;
  }

  migrate(
    threadIdInput: ThreadId | string,
    fromEngineInput: EngineKind | string,
    toEngineInput: EngineKind | string,
    options: MigrateEngineOptions = {},
  ): ThreadEngineBindingRecord {
    const threadId = asThreadId(threadIdInput);
    const fromEngine = asEngineKind(fromEngineInput);
    const toEngine = asEngineKind(toEngineInput);
    const current = this.get(threadId);
    if (!current || current.engineKind !== fromEngine) {
      throw new Error(`cannot migrate thread ${threadId}: expected ${fromEngine} binding`);
    }
    if (!options.checkpointId) throw new Error("explicit engine migration requires a checkpoint id");
    const checkpointId = asCheckpointId(options.checkpointId);
    return this.write({
      threadId,
      engineKind: toEngine,
      generation: current.generation + 1,
      provenance: `explicit-migration:${checkpointId}`,
      updatedAtMs: Date.now(),
    });
  }
}

export class ThreadEngineBindingService extends Service implements ThreadEngineBindingPort {
  static inject = ["storage"] satisfies Inject<Pick<HypernodeServices, "storage">>;

  readonly table: ThreadEngineBindingTable;

  constructor(ctx: HypernodeContext<"storage">) {
    super(ctx, "threadEngineBinding");
    this.table = new ThreadEngineBindingTable(ctx.storage);
  }

  get(threadId: ThreadId | string): ThreadEngineBindingRecord | null {
    return this.table.get(threadId);
  }

  claim(
    threadId: ThreadId | string,
    engine: EngineKind | string,
    options?: ClaimEngineOptions,
  ): ThreadEngineBindingRecord {
    return this.table.claim(threadId, engine, options);
  }

  migrate(
    threadId: ThreadId | string,
    fromEngine: EngineKind | string,
    toEngine: EngineKind | string,
    options?: MigrateEngineOptions,
  ): ThreadEngineBindingRecord {
    return this.table.migrate(threadId, fromEngine, toEngine, options);
  }
}
