import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  ProtocolAuditData,
  ProtocolAuditEvent,
  ProtocolAuditPort,
  ProtocolAuditProjection,
  ProtocolAuditReadResult,
} from "../types/protocol-audit.ts";
import type { DurableSql, DurableStoragePort, SqlRow } from "../types/storage.ts";

const DEBUG_METHOD = "hypernode/protocolAudit/read";
const LEGACY_DEBUG_METHOD = "hypernode/dshShadow/read";
const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)/i;

type Dependencies = "appServer" | "storage";

interface ProtocolAuditSequenceRow extends SqlRow {
  next_seq: number;
}

interface ProtocolAuditEventRow extends SqlRow {
  event_json: string;
}

interface PendingAuditRequest {
  message: JsonRpcRequest;
  method: string;
  threadId: string | null;
  captured: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return null;
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

function messageId(message: unknown): string | number | null | undefined {
  const id = asRecord(message)?.["id"];
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function messageMethod(message: unknown): string | null {
  const method = asRecord(message)?.["method"];
  return typeof method === "string" ? method : null;
}

function parseStoredEvent(value: string): ProtocolAuditEvent {
  const parsed: unknown = JSON.parse(value);
  const event = asRecord(parsed);
  const data = asRecord(event?.["data"]);
  if (
    event?.["type"] !== "hypernode/protocol" ||
    typeof event["seq"] !== "number" ||
    typeof event["time"] !== "number" ||
    data === null
  ) {
    throw new Error("stored protocol audit event has an invalid shape");
  }
  return parsed as ProtocolAuditEvent;
}

export function redactProtocolValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactProtocolValue(entry));
  const record = asRecord(value);
  if (record !== null) {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      result[childKey] = redactProtocolValue(child, childKey);
    }
    return result;
  }
  return value === undefined ? null : value;
}

export function protocolThreadId(message: unknown): string | null {
  const root = asRecord(message);
  const params = asRecord(root?.["params"]);
  const result = asRecord(root?.["result"]);
  const paramThread = asRecord(params?.["thread"]);
  const resultThread = asRecord(result?.["thread"]);
  const candidates = [
    params?.["threadId"],
    paramThread?.["id"],
    resultThread?.["id"],
    result?.["threadId"],
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

export function reduceProtocolProjection(
  state: ProtocolAuditProjection,
  event: ProtocolAuditEvent,
): ProtocolAuditProjection {
  if (event.type !== "hypernode/protocol") return state;
  const direction = event.data.direction === "inbound" ? "inbound" : "outbound";
  const method = typeof event.data.method === "string" ? event.data.method : "<response>";
  return {
    total: state.total + 1,
    inbound: state.inbound + (direction === "inbound" ? 1 : 0),
    outbound: state.outbound + (direction === "outbound" ? 1 : 0),
    methods: { ...state.methods, [method]: (state.methods[method] ?? 0) + 1 },
    last: { seq: event.seq, direction, method, rpcId: event.data.rpcId },
  };
}

function initialProjection(): ProtocolAuditProjection {
  return { total: 0, inbound: 0, outbound: 0, methods: {}, last: null };
}

export class ProtocolAuditTable {
  private readonly storage: Pick<DurableStoragePort, "transactionSync"> | null;
  private readonly sql: DurableSql | null;
  private readonly memory = new Map<string, ProtocolAuditEvent[]>();
  readonly available: boolean;

  constructor(
    storage?: Pick<DurableStoragePort, "available" | "sql" | "transactionSync"> | null,
  ) {
    this.available = storage?.available === true && storage.sql !== null;
    this.storage = this.available && storage ? storage : null;
    this.sql = this.available && storage ? storage.sql : null;
    if (this.sql === null) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_protocol_audit_threads (
        thread_id TEXT PRIMARY KEY,
        next_seq INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_protocol_audit_events (
        thread_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(thread_id, seq)
      )
    `);
  }

  append(threadIdInput: string, data: ProtocolAuditData): ProtocolAuditEvent {
    const threadId = String(threadIdInput);
    const storage = this.storage;
    const sql = this.sql;
    if (!this.available || storage === null || sql === null) {
      const events = this.memory.get(threadId) ?? [];
      const event: ProtocolAuditEvent = {
        type: "hypernode/protocol",
        seq: events.length,
        time: Date.now(),
        data: cloneJson(data) as ProtocolAuditData,
      };
      events.push(event);
      this.memory.set(threadId, events);
      return cloneJson(event) as ProtocolAuditEvent;
    }
    return storage.transactionSync(() => {
      const row = sql.exec<ProtocolAuditSequenceRow>(`
        SELECT next_seq FROM hypernode_protocol_audit_threads WHERE thread_id = ?
      `, threadId).toArray()[0];
      const seq = typeof row?.next_seq === "number" ? row.next_seq : 0;
      const event: ProtocolAuditEvent = {
        type: "hypernode/protocol",
        seq,
        time: Date.now(),
        data: cloneJson(data) as ProtocolAuditData,
      };
      sql.exec(`
        INSERT INTO hypernode_protocol_audit_events(thread_id, seq, event_json) VALUES(?, ?, ?)
      `, threadId, seq, JSON.stringify(event));
      sql.exec(`
        INSERT INTO hypernode_protocol_audit_threads(thread_id, next_seq, updated_at_ms)
        VALUES(?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          next_seq = excluded.next_seq,
          updated_at_ms = excluded.updated_at_ms
      `, threadId, seq + 1, Date.now());
      return event;
    });
  }

  events(threadIdInput: string): ProtocolAuditEvent[] {
    const threadId = String(threadIdInput);
    if (!this.available || this.sql === null) {
      return cloneJson(this.memory.get(threadId) ?? []) as ProtocolAuditEvent[];
    }
    return this.sql.exec<ProtocolAuditEventRow>(`
      SELECT event_json FROM hypernode_protocol_audit_events
      WHERE thread_id = ? ORDER BY seq
    `, threadId).toArray().map((row) => parseStoredEvent(row.event_json));
  }
}

export class ProtocolAuditService extends Service implements ProtocolAuditPort {
  static inject = ["appServer", "storage"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly pending = new WeakMap<AppServerConnection, Map<string, PendingAuditRequest>>();
  private readonly table: ProtocolAuditTable;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "protocolAudit");
    this.table = new ProtocolAuditTable(ctx.storage);
    ctx.effect(() => ctx.appServer.intercept((message, connection) => this.captureInbound(message, connection)));
    ctx.effect(() => ctx.appServer.projectOutbound((message, connection) => this.captureOutbound(message, connection)));
    ctx.effect(() => ctx.appServer.register(DEBUG_METHOD, (params) => this.read(params)));
    ctx.effect(() => ctx.appServer.register(LEGACY_DEBUG_METHOD, (params) => this.read(params)));
  }

  private append(
    threadId: string | null,
    direction: "inbound" | "outbound",
    message: JsonRpcRequest | JsonRpcResponse,
    method: string | null = null,
  ): void {
    if (!threadId || method !== null && [DEBUG_METHOD, LEGACY_DEBUG_METHOD].includes(method)) return;
    this.table.append(threadId, {
      direction,
      method: method ?? messageMethod(message),
      rpcId: messageId(message),
      message: redactProtocolValue(cloneJson(message)),
    });
  }

  private pendingFor(connection: AppServerConnection): Map<string, PendingAuditRequest> {
    let pending = this.pending.get(connection);
    if (!pending) {
      pending = new Map();
      this.pending.set(connection, pending);
    }
    return pending;
  }

  private captureInbound(message: JsonRpcRequest | null, connection: AppServerConnection): false {
    if (message === null) return false;
    const threadId = protocolThreadId(message);
    if (message.id !== undefined && typeof message.method === "string") {
      this.pendingFor(connection).set(String(message.id), {
        message: cloneJson(message) as JsonRpcRequest,
        method: message.method,
        threadId,
        captured: Boolean(threadId),
      });
    }
    if (threadId) this.append(threadId, "inbound", message);
    return false;
  }

  private captureOutbound(
    message: JsonRpcResponse,
    connection: AppServerConnection,
  ): JsonRpcResponse {
    const pending = message.id === undefined
      ? null
      : this.pendingFor(connection).get(String(message.id)) ?? null;
    const threadId = protocolThreadId(message) ?? pending?.threadId ?? null;
    if (threadId && pending && !pending.captured) {
      this.append(threadId, "inbound", pending.message, pending.method);
    }
    if (threadId) {
      this.append(threadId, "outbound", message, messageMethod(message) ?? pending?.method ?? null);
    }
    if (message.id !== undefined) this.pendingFor(connection).delete(String(message.id));
    return message;
  }

  read(params: Record<string, unknown> | AppServerParams = {}): ProtocolAuditReadResult {
    const threadId = String(params["threadId"] ?? "");
    const events = this.table.events(threadId);
    const requestedLimit = params["limit"];
    const limit = typeof requestedLimit === "number" && Number.isSafeInteger(requestedLimit)
      ? Math.max(0, Math.min(requestedLimit, 200))
      : 50;
    return {
      threadId,
      found: events.length > 0,
      eventCount: events.length,
      events: events.slice(-limit),
      projection: events.reduce(reduceProtocolProjection, initialProjection()),
    };
  }
}
