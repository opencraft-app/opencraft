import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import {
  asJsonValue,
  type JsonValue,
} from "../types/domain.ts";
import type {
  DshNativeSessionRecord,
  DshNativeSessionSnapshot,
  DshNativeSessionStorePort,
} from "../types/dsh-native-session.ts";
import type { DurableSql, SqlRow } from "../types/storage.ts";

interface NativeSessionStorage {
  readonly available: boolean;
  readonly sql?: DurableSql | null;
}

interface NativeSessionRow extends SqlRow {
  session_id: string;
  header_json: string;
  provenance: string;
  updated_at_ms: number;
}

interface NativeSessionIdRow extends SqlRow {
  session_id: string;
}

interface NativeSessionPresentRow extends SqlRow {
  present: number;
}

function cloneHeader(header: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return asJsonValue(JSON.parse(JSON.stringify(header))) as Record<string, JsonValue>;
}

function cloneRecord(record: DshNativeSessionRecord | null): DshNativeSessionRecord | null {
  return record === null ? null : { ...record, header: cloneHeader(record.header) };
}

function assertThreadId(value: unknown): string {
  const threadId = String(value ?? "");
  if (!threadId || !/^[A-Za-z0-9._-]+$/.test(threadId)) {
    throw new Error("invalid DSH thread id");
  }
  return threadId;
}

function assertSessionId(value: unknown): string {
  const sessionId = String(value ?? "");
  if (!sessionId) throw new Error("invalid DSH session id");
  return sessionId;
}

function parseHeader(encoded: string): Record<string, JsonValue> {
  const value = asJsonValue(JSON.parse(encoded));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("invalid persisted DSH session header");
  }
  return value;
}

export function stableDshSessionId(threadId: unknown): string {
  return `hypernode-dsh-${assertThreadId(threadId)}`;
}

// This registry stores only a pointer to DSH's native session ledger. DSH's
// own SQLite database is the transcript authority; copying its events into the
// policy database would create a second writer and a legacy compatibility path.
export class DshNativeSessionTable implements DshNativeSessionStorePort {
  private readonly sql: DurableSql | null;
  private readonly memory = new Map<string, DshNativeSessionRecord>();

  constructor(storage: NativeSessionStorage) {
    this.sql = storage.available === true && storage.sql != null ? storage.sql : null;
    if (this.sql !== null) this.initializeSchema();
  }

  private initializeSchema(): void {
    this.sql?.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_dsh_native_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        header_json TEXT NOT NULL,
        provenance TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  load(threadIdValue: string): DshNativeSessionRecord | null {
    const threadId = assertThreadId(threadIdValue);
    if (this.sql === null) return cloneRecord(this.memory.get(threadId) ?? null);
    const row = this.sql.exec<NativeSessionRow>(`
      SELECT session_id, header_json, provenance, updated_at_ms
      FROM hypernode_dsh_native_sessions WHERE thread_id = ?
    `, threadId).toArray()[0];
    if (row === undefined) return null;
    const header = parseHeader(row.header_json);
    if (header["id"] !== row.session_id) {
      throw new Error("persisted DSH session header identity mismatch");
    }
    return {
      threadId,
      sessionId: row.session_id,
      header,
      provenance: row.provenance,
      updatedAtMs: row.updated_at_ms,
    };
  }

  has(threadIdValue: string): boolean {
    const threadId = assertThreadId(threadIdValue);
    if (this.sql === null) return this.memory.has(threadId);
    return this.sql.exec<NativeSessionPresentRow>(`
      SELECT 1 AS present FROM hypernode_dsh_native_sessions WHERE thread_id = ?
    `, threadId).toArray().length > 0;
  }

  currentSessionId(threadIdValue: string): string | null {
    const threadId = assertThreadId(threadIdValue);
    if (this.sql === null) return this.memory.get(threadId)?.sessionId ?? null;
    const row = this.sql.exec<NativeSessionIdRow>(`
      SELECT session_id FROM hypernode_dsh_native_sessions WHERE thread_id = ?
    `, threadId).toArray()[0];
    return row?.session_id ?? null;
  }

  remember(
    threadIdValue: string,
    snapshot: DshNativeSessionSnapshot,
    provenance = "native",
  ): DshNativeSessionRecord {
    const threadId = assertThreadId(threadIdValue);
    const sessionId = assertSessionId(snapshot.sessionId ?? snapshot.header?.["id"]);
    if (snapshot.header === null || snapshot.header === undefined) {
      throw new Error("DSH session header is required");
    }
    const header = cloneHeader(snapshot.header);
    if (header["id"] !== sessionId) throw new Error("DSH session header identity mismatch");
    const updatedAtMs = Date.now();
    const record: DshNativeSessionRecord = {
      threadId,
      sessionId,
      header,
      provenance: String(provenance),
      updatedAtMs,
    };
    if (this.sql === null) {
      this.memory.set(threadId, record);
      return cloneRecord(record) as DshNativeSessionRecord;
    }
    this.sql.exec(`
      INSERT INTO hypernode_dsh_native_sessions(
        thread_id, session_id, header_json, provenance, updated_at_ms
      ) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        session_id = excluded.session_id,
        header_json = excluded.header_json,
        provenance = excluded.provenance,
        updated_at_ms = excluded.updated_at_ms
    `, threadId, sessionId, JSON.stringify(header), String(provenance), updatedAtMs);
    return record;
  }
}

type Dependencies = "storage";

export class DshNativeSessionStoreService extends Service implements DshNativeSessionStorePort {
  static inject = ["storage"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  private readonly table: DshNativeSessionTable;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "dshNativeSessionStore");
    this.table = new DshNativeSessionTable(ctx.storage);
  }

  load(threadId: string): DshNativeSessionRecord | null {
    return this.table.load(threadId);
  }

  has(threadId: string): boolean {
    return this.table.has(threadId);
  }

  currentSessionId(threadId: string): string | null {
    return this.table.currentSessionId(threadId);
  }

  remember(
    threadId: string,
    snapshot: DshNativeSessionSnapshot,
    provenance?: string,
  ): DshNativeSessionRecord {
    return this.table.remember(threadId, snapshot, provenance);
  }
}
