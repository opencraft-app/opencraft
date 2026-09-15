import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerParams, JsonRpcResponse } from "../types/appserver.js";
import type {
  AppServerBackendProjectionHost,
  AppServerActiveModel,
  AppServerHistoryThread,
  AppServerHistoryRequest,
  AppServerProjectionPort,
  AppServerProjectedNotification,
} from "../types/canonical-appserver-projection.js";
import type {
  CanonicalEvent,
  CanonicalEventSource,
  CanonicalParams,
  CanonicalRecordResult,
  CanonicalTurnSeed,
} from "../types/canonical-timeline.js";
import type { HypernodeContext, HypernodeServices } from "../types/context.js";
import type { ProjectionPageParams } from "./transparent-thread-history.ts";
import {
  projectedItemsPage,
  projectedThreadForRead,
  projectedTurnsPage,
} from "./transparent-thread-history.ts";
import {
  projectedResumeResultForModel,
  type ThreadSettingsShape,
} from "./transparent-thread-routing.ts";
import { threadStartedProjection } from "./thread-protocol.ts";

function projectEvent(event: CanonicalEvent): AppServerProjectedNotification | null {
  const method = event.data.method;
  const params = event.data.params;
  if (typeof method !== "string" || !params) return null;
  return { method, params };
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function turnValue(value: unknown): CanonicalTurnSeed | null {
  const turn = objectValue(value);
  return stringValue(turn["id"]) ? turn as CanonicalTurnSeed : null;
}

function threadIdFrom(value: unknown): string | null {
  return stringValue(objectValue(value)["id"]);
}

/**
 * The single canonical-fact -> AppServer compatibility boundary.
 *
 * Durable lifecycle facts are committed before delivery and projected back
 * from the committed event.  Live deltas intentionally are not persisted, so
 * they retain their transport payload.  A persistence failure is observable
 * in the canonical failure ledger but must not hide an already-produced
 * terminal notification from Desktop.
 */
type Dependencies =
  | "appServer"
  | "canonicalTimeline"
  | "modelGateway"
  | "threadExecution"
  | "threadManager"
  | "transparentSubscription";

export class AppServerProjectionService extends Service
  implements AppServerProjectionPort {
  static inject = [
    "appServer",
    "canonicalTimeline",
    "modelGateway",
    "threadExecution",
    "threadManager",
    "transparentSubscription",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "appServerProjection");
  }

  prepare(
    method: string,
    params: CanonicalParams,
    source: CanonicalEventSource = {},
  ): AppServerProjectedNotification {
    const result = this.ctx.canonicalTimeline.recordAppServer(method, params, source);
    if (result && "event" in result) return projectEvent(result.event) ?? { method, params };
    return { method, params };
  }

  broadcast(
    method: string,
    params: CanonicalParams,
    source: CanonicalEventSource = {},
  ): CanonicalRecordResult {
    const result = this.ctx.canonicalTimeline.recordAppServer(method, params, source);
    const projected = result && "event" in result
      ? projectEvent(result.event) ?? { method, params }
      : { method, params };
    this.ctx.appServer.broadcastNotification(projected.method, projected.params);
    return result;
  }

  historyResult(
    method: string,
    thread: AppServerHistoryThread,
    params: AppServerParams = {},
    activeModel: AppServerActiveModel | null = null,
  ): unknown {
    if (method === "thread/read") {
      return {
        thread: projectedThreadForRead(thread, params["includeTurns"] !== false),
      };
    }
    if (method === "thread/turns/list") {
      return projectedTurnsPage(thread, projectionPageParams(params, thread.id));
    }
    if (method === "thread/items/list") {
      return projectedItemsPage(thread, projectionPageParams(params, thread.id));
    }
    if (method === "thread/resume") {
      return projectedResumeResultForModel(
        activeModel,
        thread,
        threadSettingsShape(params),
      );
    }
    throw new Error(`unsupported AppServer history method: ${method}`);
  }

  /**
   * Project canonical history into the OpenAI AppServer read contracts.
   *
   * This path deliberately receives a read-only host without an engine port:
   * resuming a Desktop projection must never inspect or start an execution
   * runtime. Canonical Turn and Item facts are the only history source.
   */
  handleHistory(
    request: AppServerHistoryRequest,
  ): true {
    const { connection, message, threadId } = request;
    const thread = this.ctx.threadManager.get(threadId);
    const canonicalThread = {
      ...thread,
      turns: this.ctx.canonicalTimeline.turns(threadId),
    };
    this.ctx.transparentSubscription.subscribe(connection, threadId);
    connection.activeThreadId = threadId;

    const result = this.historyResult(
      message.method ?? "thread/resume",
      canonicalThread,
      message.params,
      this.ctx.modelGateway.activeForConnection(connection),
    );
    this.ctx.appServer.send(connection, response(message.id, result));

    if (message.method === "thread/resume") {
      this.ctx.appServer.send(connection, {
        method: "thread/started",
        params: { thread: threadStartedProjection(thread) },
      });
      this.ctx.appServer.send(connection, {
        method: "thread/status/changed",
        params: {
          threadId,
          status: this.ctx.threadExecution.table.get(threadId)
            ? { type: "active", activeFlags: [] }
            : { type: "idle" },
        },
      });
    }
    return true;
  }

  /**
   * Update the rebuildable AppServer read model from an outer-namespace
   * backend message. Canonical execution facts must be committed by the
   * caller before invoking this method.
   */
  projectBackend(
    message: JsonRpcResponse,
    host: AppServerBackendProjectionHost,
  ): string | null {
    const params = objectValue(message.params);
    if (Object.keys(params).length === 0) {
      const thread = objectValue(objectValue(message.result)["thread"]);
      const threadId = threadIdFrom(thread);
      if (threadId) this.projectThread(threadId, thread, host);
      return threadId;
    }

    const thread = objectValue(params["thread"]);
    const threadId = threadIdFrom(thread) ?? stringValue(params["threadId"]);
    if (!threadId) return null;

    if (Object.keys(thread).length > 0) this.projectThread(threadId, thread, host);
    const turn = turnValue(params["turn"]);
    if (message.method === "turn/started" && turn) {
      this.ctx.threadManager.projectTurn(threadId, turn, "started");
      host.turnStarted(threadId, turn);
    } else if (message.method === "turn/completed") {
      if (turn) this.ctx.threadManager.projectTurn(threadId, turn, "completed");
      host.turnCompleted(threadId, turn);
    } else if (message.method === "thread/status/changed" && params["status"] != null) {
      this.ctx.threadManager.project(threadId, { status: params["status"] });
    } else if (message.method === "thread/name/updated" &&
        typeof params["threadName"] === "string") {
      this.ctx.threadManager.project(threadId, { name: params["threadName"] });
    } else if (message.method === "thread/archived") {
      this.ctx.threadManager.archive(threadId);
      host.threadArchived(threadId);
    } else if (message.method === "thread/unarchived") {
      this.ctx.threadManager.unarchive(threadId);
    }
    return threadId;
  }

  projectThread(
    threadId: string,
    source: unknown,
    host: AppServerBackendProjectionHost,
  ): void {
    const thread = objectValue(source);
    if (Object.keys(thread).length === 0) return;
    // Backend read responses may include legacy embedded history. History is
    // canonical-timeline-owned and must never be re-imported by a read model.
    const { turns: _legacyTurns, ...metadata } = thread;
    this.ctx.threadManager.project(threadId, metadata, (path: string) => host.virtualPath(path));
  }
}

function threadSettingsShape(params: AppServerParams): ThreadSettingsShape {
  const result: ThreadSettingsShape = {};
  for (const [key, value] of Object.entries(params)) result[key] = value;
  return result;
}

function response(id: AppServerHistoryRequest["message"]["id"], result: unknown) {
  return id === undefined ? { result } : { id, result };
}

function projectionPageParams(
  params: AppServerHistoryRequest["message"]["params"],
  threadId: string,
): ProjectionPageParams {
  const source = params ?? {};
  const turnId = source["turnId"];
  const cursor = source["cursor"];
  const limit = source["limit"];
  const sortDirection = source["sortDirection"];
  const itemsView = source["itemsView"];
  return {
    threadId,
    ...(typeof turnId === "string" || turnId === null ? { turnId } : {}),
    ...(typeof cursor === "string" || cursor === null ? { cursor } : {}),
    ...(typeof limit === "number" || limit === null ? { limit } : {}),
    ...(typeof sortDirection === "string" || sortDirection === null ? { sortDirection } : {}),
    ...(typeof itemsView === "string" || itemsView === null ? { itemsView } : {}),
  };
}
