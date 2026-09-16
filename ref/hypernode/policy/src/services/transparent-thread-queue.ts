import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcId,
  JsonRpcRequest,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  DurableSql,
  DurableStoragePort,
  SqlRow,
} from "../types/storage.ts";
import type {
  TransparentThreadQueueDecision,
  TransparentThreadQueuePort,
  TransparentThreadQueueRequest,
} from "../types/transparent-thread-queue.ts";
import { uuidV4 } from "./device-identity.ts";
import { desiredRuntimeHint } from "./execution-profile.ts";

const QUEUE_METHODS = new Set([
  "thread/queue/add",
  "thread/queue/list",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
]);

type QueueState = "queued" | "dispatched" | "deleted";

interface QueueSubmission {
  threadId: string;
  id: string;
  clientUserMessageId: string;
  actorUserId: string | null;
  input: unknown[];
  state: QueueState;
  position: number;
  createdAtMs: number;
  updatedAtMs: number;
}

interface QueueSqlRow extends SqlRow {
  thread_id: string;
  submission_id: string;
  client_user_message_id: string;
  actor_user_id: string | null;
  input_json: string;
  state: string;
  position: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export class ThreadQueueStore {
  private readonly sql: DurableSql | null;
  private readonly memory = new Map<string, QueueSubmission[]>();
  private readonly pausedMemory = new Set<string>();
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    storage: DurableStoragePort | null | undefined,
    createId: () => string = uuidV4,
    now: () => number = Date.now,
  ) {
    this.sql = storage?.available === true ? storage.sql : null;
    this.createId = createId;
    this.now = now;
    if (this.sql) this.initializeSchema();
  }

  private initializeSchema(): void {
    this.sql?.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_queue_submissions (
        thread_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        client_user_message_id TEXT NOT NULL,
        actor_user_id TEXT,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(thread_id, submission_id),
        UNIQUE(thread_id, client_user_message_id)
      )
    `);
    this.sql?.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_thread_queue_pending
      ON hypernode_thread_queue_submissions(thread_id, state, position)
    `);
    this.sql?.exec(`
      CREATE INDEX IF NOT EXISTS hypernode_thread_queue_actor
      ON hypernode_thread_queue_submissions(actor_user_id, state)
    `);
    this.sql?.exec(`
      CREATE TABLE IF NOT EXISTS hypernode_thread_queue_state (
        thread_id TEXT PRIMARY KEY,
        paused_reason TEXT,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  add(
    threadId: string,
    clientUserMessageId: string,
    actorUserId: string | null,
    input: unknown[],
  ): { submission: QueueSubmission; created: boolean } {
    const existing = this.findByClientId(threadId, clientUserMessageId);
    if (existing) return { submission: existing, created: false };
    const at = this.now();
    const submission: QueueSubmission = {
      threadId,
      id: this.createId(),
      clientUserMessageId,
      actorUserId,
      input: structuredCopy(input),
      state: "queued",
      position: this.nextPosition(threadId),
      createdAtMs: at,
      updatedAtMs: at,
    };
    if (this.sql) {
      this.sql.exec(
        `
        INSERT INTO hypernode_thread_queue_submissions(
          thread_id, submission_id, client_user_message_id, actor_user_id,
          input_json, state, position, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `,
        submission.threadId,
        submission.id,
        submission.clientUserMessageId,
        submission.actorUserId,
        JSON.stringify(submission.input),
        submission.position,
        submission.createdAtMs,
        submission.updatedAtMs,
      );
    } else {
      const rows = this.memory.get(threadId) ?? [];
      rows.push(submission);
      this.memory.set(threadId, rows);
    }
    return { submission, created: true };
  }

  findByClientId(
    threadId: string,
    clientUserMessageId: string,
  ): QueueSubmission | null {
    if (this.sql) {
      return hydrate(
        this.sql
          .exec<QueueSqlRow>(
            `
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND client_user_message_id = ?
      `,
            threadId,
            clientUserMessageId,
          )
          .toArray()[0],
      );
    }
    return (
      this.memory
        .get(threadId)
        ?.find((row) => row.clientUserMessageId === clientUserMessageId) ?? null
    );
  }

  find(threadId: string, submissionId: string): QueueSubmission | null {
    if (this.sql) {
      return hydrate(
        this.sql
          .exec<QueueSqlRow>(
            `
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND submission_id = ?
      `,
            threadId,
            submissionId,
          )
          .toArray()[0],
      );
    }
    return (
      this.memory.get(threadId)?.find((row) => row.id === submissionId) ?? null
    );
  }

  pending(threadId: string): QueueSubmission[] {
    if (this.sql) {
      return this.sql
        .exec<QueueSqlRow>(
          `
        SELECT * FROM hypernode_thread_queue_submissions
        WHERE thread_id = ? AND state = 'queued'
        ORDER BY position, created_at_ms, submission_id
      `,
          threadId,
        )
        .toArray()
        .map(hydrate)
        .filter(notNull);
    }
    return (this.memory.get(threadId) ?? [])
      .filter((row) => row.state === "queued")
      .sort(compareQueue)
      .map(cloneSubmission);
  }

  update(
    threadId: string,
    submissionId: string,
    input: unknown[],
  ): QueueSubmission | null {
    const row = this.find(threadId, submissionId);
    if (!row || row.state !== "queued") return null;
    const at = this.now();
    if (this.sql) {
      this.sql.exec(
        `
        UPDATE hypernode_thread_queue_submissions
        SET input_json = ?, updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `,
        JSON.stringify(input),
        at,
        threadId,
        submissionId,
      );
    } else {
      const stored = this.memory
        .get(threadId)
        ?.find((item) => item.id === submissionId);
      if (stored) {
        stored.input = structuredCopy(input);
        stored.updatedAtMs = at;
      }
    }
    return this.find(threadId, submissionId);
  }

  delete(threadId: string, submissionId: string): boolean {
    const row = this.find(threadId, submissionId);
    if (!row || row.state !== "queued") return false;
    const at = this.now();
    if (this.sql) {
      this.sql.exec(
        `
        UPDATE hypernode_thread_queue_submissions
        SET state = 'deleted', updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `,
        at,
        threadId,
        submissionId,
      );
    } else {
      rowInMemory(this.memory, threadId, submissionId, (stored) => {
        stored.state = "deleted";
        stored.updatedAtMs = at;
      });
    }
    if (this.pending(threadId).length === 0) this.resume(threadId);
    return true;
  }

  reorder(threadId: string, ids: string[]): boolean {
    const rows = this.pending(threadId);
    if (
      rows.length !== ids.length ||
      new Set(ids).size !== ids.length ||
      rows.some((row) => !ids.includes(row.id))
    )
      return false;
    const at = this.now();
    if (this.sql) {
      for (const [index, id] of ids.entries()) {
        this.sql.exec(
          `
          UPDATE hypernode_thread_queue_submissions
          SET position = ?, updated_at_ms = ?
          WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
        `,
          index + 1,
          at,
          threadId,
          id,
        );
      }
    } else {
      for (const [index, id] of ids.entries()) {
        rowInMemory(this.memory, threadId, id, (stored) => {
          stored.position = index + 1;
          stored.updatedAtMs = at;
        });
      }
    }
    return true;
  }

  markDispatched(threadId: string, submissionId: string): void {
    const at = this.now();
    if (this.sql) {
      this.sql.exec(
        `
        UPDATE hypernode_thread_queue_submissions
        SET state = 'dispatched', updated_at_ms = ?
        WHERE thread_id = ? AND submission_id = ? AND state = 'queued'
      `,
        at,
        threadId,
        submissionId,
      );
    } else {
      rowInMemory(this.memory, threadId, submissionId, (stored) => {
        stored.state = "dispatched";
        stored.updatedAtMs = at;
      });
    }
  }

  pendingThreadsForActor(actorUserId: string): string[] {
    if (this.sql) {
      return this.sql
        .exec<{ thread_id: string }>(
          `
        SELECT DISTINCT thread_id FROM hypernode_thread_queue_submissions
        WHERE actor_user_id = ? AND state = 'queued'
      `,
          actorUserId,
        )
        .toArray()
        .map((row) => row.thread_id);
    }
    const result: string[] = [];
    for (const [threadId, rows] of this.memory) {
      if (
        rows.some(
          (row) => row.actorUserId === actorUserId && row.state === "queued",
        )
      ) {
        result.push(threadId);
      }
    }
    return result;
  }

  pauseAfterInterruption(threadId: string): void {
    if (this.pending(threadId).length === 0) {
      this.resume(threadId);
      return;
    }
    const at = this.now();
    if (this.sql) {
      this.sql.exec(
        `
        INSERT INTO hypernode_thread_queue_state(thread_id, paused_reason, updated_at_ms)
        VALUES(?, 'interrupted', ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          paused_reason = 'interrupted', updated_at_ms = excluded.updated_at_ms
      `,
        threadId,
        at,
      );
      return;
    }
    this.pausedMemory.add(threadId);
  }

  resume(threadId: string): void {
    if (this.sql) {
      this.sql.exec(
        `DELETE FROM hypernode_thread_queue_state WHERE thread_id = ?`,
        threadId,
      );
      return;
    }
    this.pausedMemory.delete(threadId);
  }

  isPaused(threadId: string): boolean {
    if (this.sql) {
      return (
        this.sql
          .exec<{ paused_reason: string }>(
            `
        SELECT paused_reason FROM hypernode_thread_queue_state
        WHERE thread_id = ? AND paused_reason = 'interrupted'
      `,
            threadId,
          )
          .toArray().length > 0
      );
    }
    return this.pausedMemory.has(threadId);
  }

  private nextPosition(threadId: string): number {
    if (this.sql) {
      const row = this.sql
        .exec<{ position: number }>(
          `
        SELECT COALESCE(MAX(position), 0) + 1 AS position
        FROM hypernode_thread_queue_submissions WHERE thread_id = ?
      `,
          threadId,
        )
        .toArray()[0];
      return Number(row?.position ?? 1);
    }
    return (
      Math.max(
        0,
        ...(this.memory.get(threadId) ?? []).map((row) => row.position),
      ) + 1
    );
  }
}

type Dependencies =
  | "appServer"
  | "storage"
  | "threadExecution"
  | "transparentBackendChannel"
  | "transparentThreadBinding"
  | "transparentTurnExecution";

/** Implements the native queued-submission protocol for non-Codex engines. */
export class TransparentThreadQueueService
  extends Service
  implements TransparentThreadQueuePort
{
  static inject = [
    "appServer",
    "storage",
    "threadExecution",
    "transparentBackendChannel",
    "transparentThreadBinding",
    "transparentTurnExecution",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly store: ThreadQueueStore;
  private readonly liveConnections = new Map<string, AppServerConnection>();
  private readonly pumping = new Set<string>();
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadQueue");
    this.store = new ThreadQueueStore(ctx.storage);
    ctx.effect(() =>
      ctx.threadExecution.onChange((event) => {
        if (
          !event?.execution?.threadId ||
          !["completed", "aborted"].includes(event.type)
        )
          return;
        if (this.pumping.has(event.execution.threadId)) return;
        if (event.type === "aborted") {
          this.store.pauseAfterInterruption(event.execution.threadId);
          this.changed(event.execution.threadId);
          return;
        }
        const connection = this.connectionFor(
          event.execution.threadId,
          event.execution.connection,
        );
        if (connection) this.schedulePump(event.execution.threadId, connection);
      }),
    );
    ctx.effect(() =>
      ctx.appServer.onInitialize((connection) => {
        const actorUserId = connection.identity?.id;
        if (!actorUserId) return;
        for (const threadId of this.store.pendingThreadsForActor(actorUserId)) {
          if (this.store.isPaused(threadId)) continue;
          this.schedulePump(threadId, connection);
        }
      }),
    );
    ctx.effect(() =>
      ctx.appServer.onClose((connection) => {
        for (const [key, value] of this.liveConnections) {
          if (value === connection) this.liveConnections.delete(key);
        }
      }),
    );
  }

  handle(
    request: TransparentThreadQueueRequest,
  ): TransparentThreadQueueDecision {
    if (!request.message.method || !QUEUE_METHODS.has(request.message.method)) {
      return "queueCodex";
    }
    if (!this.ownsQueue(request.threadId)) return "queueCodex";
    try {
      switch (request.message.method) {
        case "thread/queue/add":
          this.add(request);
          break;
        case "thread/queue/list":
          this.list(request);
          break;
        case "thread/queue/update":
          this.update(request);
          break;
        case "thread/queue/delete":
          this.delete(request);
          break;
        case "thread/queue/reorder":
          this.reorder(request);
          break;
        case "thread/queue/start":
          this.start(request);
          break;
      }
    } catch (error) {
      this.sendError(
        request.connection,
        request.message.id,
        -32602,
        errorMessage(error),
      );
    }
    return "handled";
  }

  private ownsQueue(threadId: string): boolean {
    const active = this.ctx.threadExecution.table.get(threadId);
    if (active?.executionProfile?.engineKind === "dsh") return true;
    return (
      desiredRuntimeHint(
        this.ctx.transparentThreadBinding.runtimeHintFor(threadId),
      )?.engineKind === "dsh"
    );
  }

  private add(request: TransparentThreadQueueRequest): void {
    const input = inputParam(request.message);
    const clientUserMessageId = requiredString(
      request.message.params?.["clientUserMessageId"],
      "clientUserMessageId",
    );
    const result = this.store.add(
      request.threadId,
      clientUserMessageId,
      request.connection.identity?.id ?? null,
      input,
    );
    this.liveConnections.set(
      queueKey(request.threadId, result.submission.id),
      request.connection,
    );
    this.ctx.transparentBackendChannel.send(
      request.connection,
      withId(request.message.id, {
        result: { queuedSubmission: wireSubmission(result.submission) },
      }),
    );
    if (result.created) this.changed(request.threadId);
    if (
      result.submission.state === "queued" &&
      !this.store.isPaused(request.threadId)
    ) {
      this.schedulePump(request.threadId, request.connection);
    }
  }

  private list(request: TransparentThreadQueueRequest): void {
    const rows = this.store.pending(request.threadId);
    const cursor = queueCursor(request.message.params?.["cursor"]);
    const rawLimit = request.message.params?.["limit"];
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(1_000, Math.floor(rawLimit)))
        : 50;
    const remaining = rows.filter((row) => row.position > cursor);
    const page = remaining.slice(0, limit);
    const nextCursor =
      remaining.length > page.length && page.length > 0
        ? `position:${page[page.length - 1]!.position}`
        : null;
    this.ctx.transparentBackendChannel.send(
      request.connection,
      withId(request.message.id, {
        result: { data: page.map(wireSubmission), nextCursor },
      }),
    );
  }

  private update(request: TransparentThreadQueueRequest): void {
    const id = requiredString(
      request.message.params?.["queuedSubmissionId"],
      "queuedSubmissionId",
    );
    const submission = this.store.update(
      request.threadId,
      id,
      inputParam(request.message),
    );
    if (!submission)
      throw new Error(`queued submission is not editable: ${id}`);
    this.ctx.transparentBackendChannel.send(
      request.connection,
      withId(request.message.id, {
        result: { queuedSubmission: wireSubmission(submission) },
      }),
    );
    this.changed(request.threadId);
  }

  private delete(request: TransparentThreadQueueRequest): void {
    const id = requiredString(
      request.message.params?.["queuedSubmissionId"],
      "queuedSubmissionId",
    );
    const deleted = this.store.delete(request.threadId, id);
    this.liveConnections.delete(queueKey(request.threadId, id));
    this.ctx.transparentBackendChannel.send(
      request.connection,
      withId(request.message.id, {
        result: { deleted },
      }),
    );
    if (deleted) this.changed(request.threadId);
  }

  private reorder(request: TransparentThreadQueueRequest): void {
    const value = request.message.params?.["queuedSubmissionIds"];
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new Error("queuedSubmissionIds must be an array of strings");
    }
    if (!this.store.reorder(request.threadId, value)) {
      throw new Error(
        "queuedSubmissionIds must contain every pending submission exactly once",
      );
    }
    this.ctx.transparentBackendChannel.send(
      request.connection,
      withId(request.message.id, { result: {} }),
    );
    this.changed(request.threadId);
  }

  private start(request: TransparentThreadQueueRequest): void {
    if (this.ctx.threadExecution.table.get(request.threadId)) {
      this.sendError(
        request.connection,
        request.message.id,
        -32068,
        "Thread already has an active Turn.",
      );
      return;
    }
    const requestedId = request.message.params?.["queuedSubmissionId"];
    const submission =
      typeof requestedId === "string"
        ? this.store.find(request.threadId, requestedId)
        : (this.store.pending(request.threadId)[0] ?? null);
    if (!submission || submission.state !== "queued") {
      this.sendError(
        request.connection,
        request.message.id,
        -32602,
        "No queued submission is available.",
      );
      return;
    }
    this.store.resume(request.threadId);
    this.liveConnections.set(
      queueKey(request.threadId, submission.id),
      request.connection,
    );
    this.dispatch(submission, request.connection, request.message.id, false);
  }

  private schedulePump(
    threadId: string,
    connection: AppServerConnection,
  ): void {
    this.ctx.appServer.defer(connection, 0, () =>
      this.pump(threadId, connection),
    );
  }

  private pump(threadId: string, preferred: AppServerConnection): void {
    if (
      this.pumping.has(threadId) ||
      this.ctx.threadExecution.table.get(threadId) ||
      this.store.isPaused(threadId)
    )
      return;
    const submission = this.store.pending(threadId)[0];
    if (!submission) return;
    const connection = this.connectionFor(threadId, preferred, submission);
    if (!connection) return;
    this.dispatch(
      submission,
      connection,
      `hypernode:thread-queue:auto:${++this.sequence}`,
      true,
    );
  }

  private dispatch(
    submission: QueueSubmission,
    connection: AppServerConnection,
    requestId: JsonRpcId | undefined,
    suppressResponse: boolean,
  ): void {
    const hint = desiredRuntimeHint(
      this.ctx.transparentThreadBinding.runtimeHintFor(submission.threadId),
    );
    const settings = jsonRecord(hint?.threadSettings);
    const params: AppServerParams = {
      ...settings,
      threadId: submission.threadId,
      input: structuredCopy(submission.input),
      clientUserMessageId: submission.clientUserMessageId,
      ...(typeof hint?.model === "string" ? { model: hint.model } : {}),
    };
    const message: JsonRpcRequest = {
      ...(requestId === undefined ? {} : { id: requestId }),
      method: "turn/start",
      params,
    };
    this.pumping.add(submission.threadId);
    try {
      this.ctx.transparentTurnExecution.handle({
        connection,
        threadId: submission.threadId,
        message,
        suppressResponse,
      });
      const execution = this.ctx.threadExecution.table.get(submission.threadId);
      if (!execution?.turnId) return;
      this.store.markDispatched(submission.threadId, submission.id);
      this.liveConnections.delete(queueKey(submission.threadId, submission.id));
      this.changed(submission.threadId);
    } finally {
      this.pumping.delete(submission.threadId);
    }
  }

  private connectionFor(
    threadId: string,
    preferred: AppServerConnection | null | undefined,
    submission = this.store.pending(threadId)[0] ?? null,
  ): AppServerConnection | null {
    if (!submission) return null;
    const live = this.liveConnections.get(queueKey(threadId, submission.id));
    if (live && this.isUsableConnection(live, submission.actorUserId))
      return live;
    if (preferred && this.isUsableConnection(preferred, submission.actorUserId))
      return preferred;
    for (const connection of this.ctx.appServer.connections) {
      if (this.isUsableConnection(connection, submission.actorUserId))
        return connection;
    }
    return null;
  }

  private isUsableConnection(
    connection: AppServerConnection,
    actorUserId: string | null,
  ): boolean {
    return (
      connection.initialized !== false &&
      (actorUserId == null || connection.identity?.id === actorUserId)
    );
  }

  private changed(threadId: string): void {
    this.ctx.appServer.broadcastNotification("thread/queue/changed", {
      threadId,
    });
  }

  private sendError(
    connection: AppServerConnection,
    id: JsonRpcId | undefined,
    code: number,
    message: string,
  ): void {
    this.ctx.transparentBackendChannel.send(
      connection,
      withId(id, { error: { code, message } }),
    );
  }
}

function hydrate(row: QueueSqlRow | undefined): QueueSubmission | null {
  if (!row) return null;
  let input: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.input_json);
    if (Array.isArray(parsed)) input = parsed;
  } catch {}
  const state: QueueState =
    row.state === "dispatched" || row.state === "deleted"
      ? row.state
      : "queued";
  return {
    threadId: row.thread_id,
    id: row.submission_id,
    clientUserMessageId: row.client_user_message_id,
    actorUserId: row.actor_user_id,
    input,
    state,
    position: Number(row.position),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function rowInMemory(
  memory: Map<string, QueueSubmission[]>,
  threadId: string,
  submissionId: string,
  mutate: (row: QueueSubmission) => void,
): void {
  const row = memory.get(threadId)?.find((item) => item.id === submissionId);
  if (row) mutate(row);
}

function compareQueue(left: QueueSubmission, right: QueueSubmission): number {
  return (
    left.position - right.position ||
    left.createdAtMs - right.createdAtMs ||
    left.id.localeCompare(right.id)
  );
}

function cloneSubmission(row: QueueSubmission): QueueSubmission {
  return { ...row, input: structuredCopy(row.input) };
}

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function queueKey(threadId: string, submissionId: string): string {
  return `${threadId}\u0000${submissionId}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function inputParam(message: JsonRpcRequest): unknown[] {
  const input = message.params?.["input"];
  if (!Array.isArray(input)) throw new Error("input must be an array");
  return input;
}

function queueCursor(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== "string" || !value.startsWith("position:")) {
    throw new Error("invalid queue cursor");
  }
  const position = Number(value.slice("position:".length));
  if (!Number.isSafeInteger(position) || position < 0)
    throw new Error("invalid queue cursor");
  return position;
}

function wireSubmission(submission: QueueSubmission): Record<string, unknown> {
  return {
    id: submission.id,
    input: structuredCopy(submission.input),
    clientUserMessageId: submission.clientUserMessageId,
  };
}

function withId(
  id: JsonRpcId | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return id === undefined ? payload : { id, ...payload };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
