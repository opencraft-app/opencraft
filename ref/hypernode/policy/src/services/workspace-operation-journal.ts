import { Service, type Inject } from "@deepseek-ai/cordis";
import { uuidV4 } from "./device-identity.ts";
import {
  asOperationId,
  asThreadId,
  asViewId,
  errorMessage,
  parseJsonValue,
  type JsonValue,
  type OperationId,
  type ThreadId,
  type ViewId,
} from "../types/domain.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type { DurableSql, DurableStoragePort, SqlRow } from "../types/storage.js";

export type WorkspaceOperationKind = "threadFork" | "unknown";
export type WorkspaceOperationState =
  | "prepared"
  | "threadCreated"
  | "workspacePrepared"
  | "timelinePrepared"
  | "recoveryFailed"
  | "committed"
  | "rolledBack";

const TERMINAL_STATES: ReadonlySet<WorkspaceOperationState> = new Set(["committed", "rolledBack"]);

export interface WorkspaceOperationRecord {
  operationId: OperationId;
  operationKind: WorkspaceOperationKind;
  sourceThreadId: ThreadId | null;
  targetThreadId: ThreadId;
  sourceViewId: ViewId | null;
  targetViewId: ViewId | null;
  state: WorkspaceOperationState;
  details: JsonValue;
  errorMessage: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
}

export interface BeginWorkspaceOperation {
  operationKind?: WorkspaceOperationKind;
  sourceThreadId?: ThreadId | string | null;
  targetThreadId: ThreadId | string;
  sourceViewId?: ViewId | string | null;
  targetViewId?: ViewId | string | null;
  details?: JsonValue;
}

export interface TransitionWorkspaceOperation {
  details?: JsonValue;
  error?: unknown;
}

interface WorkspaceOperationRow extends SqlRow {
  operation_id: string;
  operation_kind: string;
  source_thread_id: string | null;
  target_thread_id: string;
  source_view_id: string | null;
  target_view_id: string | null;
  state: string;
  details_json: string | null;
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
}

interface JournalOptions {
  createId?: () => OperationId | string;
  now?: () => number;
}

function cloneJson<Value extends JsonValue>(value: Value): Value {
  return parseJsonValue(JSON.stringify(value)) as Value;
}

function cloneRecord(operation: WorkspaceOperationRecord): WorkspaceOperationRecord {
  return { ...operation, details: cloneJson(operation.details) };
}

function asOperationKind(value: unknown): WorkspaceOperationKind {
  return value === "threadFork" ? value : "unknown";
}

function asOperationState(value: unknown): WorkspaceOperationState {
  switch (value) {
    case "prepared":
    case "threadCreated":
    case "workspacePrepared":
    case "timelinePrepared":
    case "recoveryFailed":
    case "committed":
    case "rolledBack":
      return value;
    default:
      throw new Error(`unsupported workspace operation state ${JSON.stringify(value)}`);
  }
}

function nullableThreadId(value: unknown): ThreadId | null {
  return value == null ? null : asThreadId(value);
}

function nullableViewId(value: unknown): ViewId | null {
  return value == null ? null : asViewId(value);
}

export class WorkspaceOperationJournal {
  private readonly sql: DurableSql | null;
  private readonly createId: () => OperationId | string;
  private readonly now: () => number;
  private readonly memory = new Map<OperationId, WorkspaceOperationRecord>();

  constructor(
    storage?: Pick<DurableStoragePort, "available" | "sql"> | null,
    { createId = uuidV4, now = Date.now }: JournalOptions = {},
  ) {
    this.sql = storage?.available === true ? storage.sql : null;
    this.createId = createId;
    this.now = now;
    if (this.sql) this.initializeSchema();
  }

  initializeSchema(): void {
    if (!this.sql) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_workspace_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        source_thread_id TEXT,
        target_thread_id TEXT NOT NULL,
        source_view_id TEXT,
        target_view_id TEXT,
        state TEXT NOT NULL,
        details_json TEXT,
        error_message TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        terminal_at_ms INTEGER
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_workspace_operations_pending
      ON hypernode_workspace_operations(operation_kind, state, updated_at_ms)
    `);
  }

  begin(input: BeginWorkspaceOperation): WorkspaceOperationRecord {
    const createdAtMs = this.now();
    const operation: WorkspaceOperationRecord = {
      operationId: asOperationId(this.createId()),
      operationKind: asOperationKind(input.operationKind),
      sourceThreadId: nullableThreadId(input.sourceThreadId),
      targetThreadId: asThreadId(input.targetThreadId),
      sourceViewId: nullableViewId(input.sourceViewId),
      targetViewId: nullableViewId(input.targetViewId),
      state: "prepared",
      details: cloneJson(input.details ?? null),
      errorMessage: null,
      createdAtMs,
      updatedAtMs: createdAtMs,
      terminalAtMs: null,
    };
    if (!this.sql) {
      this.memory.set(operation.operationId, operation);
      return cloneRecord(operation);
    }
    this.sql.exec(`
      INSERT INTO hypernode_workspace_operations(
        operation_id, operation_kind, source_thread_id, target_thread_id,
        source_view_id, target_view_id, state, details_json, error_message,
        created_at_ms, updated_at_ms, terminal_at_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
    `,
    operation.operationId, operation.operationKind, operation.sourceThreadId,
    operation.targetThreadId, operation.sourceViewId, operation.targetViewId,
    operation.state, JSON.stringify(operation.details),
    operation.createdAtMs, operation.updatedAtMs);
    return operation;
  }

  transition(
    operationIdInput: OperationId | string,
    stateInput: WorkspaceOperationState,
    options: TransitionWorkspaceOperation = {},
  ): WorkspaceOperationRecord {
    const operationId = asOperationId(operationIdInput);
    const state = asOperationState(stateInput);
    const at = this.now();
    const terminalAtMs = TERMINAL_STATES.has(state) ? at : null;
    if (!this.sql) {
      const operation = this.memory.get(operationId);
      if (!operation) throw new Error(`unknown workspace operation: ${operationId}`);
      operation.state = state;
      if (options.details !== undefined) operation.details = cloneJson(options.details);
      if (options.error !== undefined) operation.errorMessage = errorMessage(options.error);
      operation.updatedAtMs = at;
      operation.terminalAtMs = terminalAtMs;
      return cloneRecord(operation);
    }
    const current = this.get(operationId);
    if (!current) throw new Error(`unknown workspace operation: ${operationId}`);
    this.sql.exec(`
      UPDATE hypernode_workspace_operations SET
        state = ?, details_json = ?, error_message = ?, updated_at_ms = ?, terminal_at_ms = ?
      WHERE operation_id = ?
    `,
    state,
    JSON.stringify(options.details === undefined ? current.details : options.details),
    options.error === undefined ? current.errorMessage : errorMessage(options.error),
    at, terminalAtMs, operationId);
    const updated = this.get(operationId);
    if (!updated) throw new Error(`workspace operation disappeared after update: ${operationId}`);
    return updated;
  }

  get(operationIdInput: OperationId | string): WorkspaceOperationRecord | null {
    const operationId = asOperationId(operationIdInput);
    if (!this.sql) {
      const operation = this.memory.get(operationId);
      return operation ? cloneRecord(operation) : null;
    }
    const row = this.sql.exec<WorkspaceOperationRow>(`
      SELECT * FROM hypernode_workspace_operations WHERE operation_id = ?
    `, operationId).toArray()[0];
    return row ? this.fromRow(row) : null;
  }

  pending(operationKind: WorkspaceOperationKind | null = null): WorkspaceOperationRecord[] {
    if (!this.sql) return [...this.memory.values()]
      .filter((operation) => !TERMINAL_STATES.has(operation.state) &&
        (operationKind == null || operation.operationKind === operationKind))
      .map(cloneRecord);
    const rows = operationKind == null
      ? this.sql.exec<WorkspaceOperationRow>(`
          SELECT * FROM hypernode_workspace_operations
          WHERE state NOT IN ('committed', 'rolledBack') ORDER BY created_at_ms
        `).toArray()
      : this.sql.exec<WorkspaceOperationRow>(`
          SELECT * FROM hypernode_workspace_operations
          WHERE operation_kind = ? AND state NOT IN ('committed', 'rolledBack')
          ORDER BY created_at_ms
        `, operationKind).toArray();
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: WorkspaceOperationRow): WorkspaceOperationRecord {
    return {
      operationId: asOperationId(row.operation_id),
      operationKind: asOperationKind(row.operation_kind),
      sourceThreadId: nullableThreadId(row.source_thread_id),
      targetThreadId: asThreadId(row.target_thread_id),
      sourceViewId: nullableViewId(row.source_view_id),
      targetViewId: nullableViewId(row.target_view_id),
      state: asOperationState(row.state),
      details: row.details_json == null ? null : parseJsonValue(row.details_json),
      errorMessage: row.error_message,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      terminalAtMs: row.terminal_at_ms == null ? null : Number(row.terminal_at_ms),
    };
  }
}

export class WorkspaceOperationJournalService extends Service {
  static inject = ["storage"] satisfies Inject<Pick<HypernodeServices, "storage">>;

  readonly table: WorkspaceOperationJournal;

  constructor(ctx: HypernodeContext<"storage">) {
    super(ctx, "workspaceOperationJournal");
    this.table = new WorkspaceOperationJournal(ctx.storage);
  }

  begin(input: BeginWorkspaceOperation): WorkspaceOperationRecord {
    return this.table.begin(input);
  }

  transition(
    operationId: OperationId | string,
    state: WorkspaceOperationState,
    options?: TransitionWorkspaceOperation,
  ): WorkspaceOperationRecord {
    return this.table.transition(operationId, state, options);
  }

  pending(operationKind?: WorkspaceOperationKind | null): WorkspaceOperationRecord[] {
    return this.table.pending(operationKind);
  }
}
