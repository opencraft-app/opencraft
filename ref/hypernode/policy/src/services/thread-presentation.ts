import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentExecutionChange } from "../types/transparent-runtime-locator.ts";
import { canonicalThreadTitle } from "./thread-identity.ts";
import { HYPERNODE_ROUTER_PROVIDER_ID } from "./model-router.ts";

const RECENT_ACTOR_TTL_MS = 15 * 60_000;
const REFRESH_MS = 5_000;

type Dependencies =
  | "appServer"
  | "modelGateway"
  | "threadExecution"
  | "threadManager"
  | "threadTitle";

interface ExecutionPresentationState {
  phase: "running" | "completed";
  actorUserId?: string;
  actorUsername?: string;
}

interface RecentExecutionState extends ExecutionPresentationState {
  phase: "completed";
  completedAtMs: number;
  expiresAtMs: number;
}

interface PresentedThread extends Record<string, unknown> {
  id: string;
  name?: string;
  modelProvider?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function presentedThread(value: unknown): PresentedThread | null {
  const record = objectRecord(value);
  return record !== null && typeof record["id"] === "string"
    ? record as PresentedThread
    : null;
}

function plainThreadName(name: unknown): string {
  return canonicalThreadTitle(name);
}

export function executionPresentationName(
  canonicalName: unknown,
  state: ExecutionPresentationState | null,
  connection: Pick<AppServerConnection, "identity"> | null | undefined,
): string {
  if (state === null) return String(canonicalName ?? "New chat").trim();
  const self = connection?.identity?.id === state.actorUserId;
  const actor = self ? "我" : state.actorUsername;
  const icon = state.phase === "running" ? "🔒" : "✅";
  return `${icon} ${actor} · ${plainThreadName(canonicalName)}`;
}

export class ThreadPresentationService extends Service {
  static inject = [
    "appServer",
    "modelGateway",
    "threadExecution",
    "threadManager",
    "threadTitle",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly recent = new Map<string, RecentExecutionState>();
  lastRefreshAtMs = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadPresentation");
    ctx.effect(() => ctx.appServer.projectOutbound((message, connection) =>
      this.projectMessage(message, connection)));
    ctx.effect(() => ctx.threadExecution.onChange((event) => this.onExecution(event)));
    ctx.effect(() => ctx.threadTitle.onChange(({ threadId }) => this.send(threadId)));
    ctx.effect(() => ctx.appServer.intercept((message) => {
      if (message === null) this.refresh();
      return false;
    }));
    ctx.effect(() => ctx.appServer.onInitialize((connection) => this.queueAll(connection)));
  }

  projectThread(
    thread: unknown,
    connection: AppServerConnection,
    now = Date.now(),
  ): unknown {
    const projectedThread = presentedThread(thread);
    if (projectedThread === null) return thread;
    const canonical = this.ctx.threadManager.find(projectedThread.id);
    if (canonical === null || canonical === undefined) return thread;
    const state = this.state(projectedThread.id, now);
    const name = executionPresentationName(
      canonical.name ?? projectedThread.name,
      state,
      connection,
    );
    const modelProvider = HYPERNODE_ROUTER_PROVIDER_ID;
    connection.threadPresentationNames ??= new Map();
    if (state !== null) connection.threadPresentationNames.set(projectedThread.id, name);
    else connection.threadPresentationNames.delete(projectedThread.id);
    return projectedThread.name === name && projectedThread.modelProvider === modelProvider
      ? thread
      : { ...projectedThread, name, modelProvider };
  }

  projectMessage(
    message: JsonRpcResponse,
    connection: AppServerConnection,
    now = Date.now(),
  ): JsonRpcResponse {
    let projected = message;
    const result = objectRecord(message.result);
    if (result !== null) {
      let projectedResult = result;
      if (Object.prototype.hasOwnProperty.call(result, "modelProvider") &&
          result["modelProvider"] !== HYPERNODE_ROUTER_PROVIDER_ID) {
        projectedResult = { ...projectedResult, modelProvider: HYPERNODE_ROUTER_PROVIDER_ID };
      }
      if (Array.isArray(result["data"])) {
        const source = result["data"];
        const data = source.map((item) => this.projectThread(item, connection, now));
        if (data.some((item, index) => item !== source[index])) {
          projectedResult = { ...projectedResult, data };
        }
      }
      if (result["thread"] !== undefined) {
        const thread = this.projectThread(result["thread"], connection, now);
        if (thread !== result["thread"]) projectedResult = { ...projectedResult, thread };
      }
      if (projectedResult !== result) projected = { ...projected, result: projectedResult };
    }

    const params = objectRecord(message.params);
    const paramsThread = params === null ? null : presentedThread(params["thread"]);
    if (params !== null && paramsThread !== null) {
      const thread = this.projectThread(paramsThread, connection, now);
      if (thread !== paramsThread) projected = { ...projected, params: { ...params, thread } };
    }

    const projectedParams = objectRecord(projected.params);
    const threadSettings = projectedParams === null
      ? null
      : objectRecord(projectedParams["threadSettings"]);
    if (threadSettings !== null && threadSettings["modelProvider"] !== undefined &&
        threadSettings["modelProvider"] !== HYPERNODE_ROUTER_PROVIDER_ID) {
      projected = {
        ...projected,
        params: {
          ...projectedParams,
          threadSettings: {
            ...threadSettings,
            modelProvider: HYPERNODE_ROUTER_PROVIDER_ID,
          },
        },
      };
    }

    const finalParams = objectRecord(projected.params);
    if (message.method === "thread/name/updated" &&
        typeof finalParams?.["threadId"] === "string") {
      const thread = this.ctx.threadManager.find(finalParams["threadId"]);
      if (thread !== null && thread !== undefined) {
        const state = this.state(thread.id, now);
        const threadName = executionPresentationName(thread.name, state, connection);
        connection.threadPresentationNames ??= new Map();
        if (state !== null) connection.threadPresentationNames.set(thread.id, threadName);
        else connection.threadPresentationNames.delete(thread.id);
        if (threadName !== finalParams["threadName"]) {
          projected = { ...projected, params: { ...finalParams, threadName } };
        }
      }
    }
    return projected;
  }

  onExecution(event: TransparentExecutionChange, now = Date.now()): void {
    const { execution } = event;
    if (event.type === "started") {
      this.recent.delete(execution.threadId);
    } else if (event.type === "completed") {
      this.recent.set(execution.threadId, {
        phase: "completed",
        ...(execution.actorUserId === undefined ? {} : { actorUserId: execution.actorUserId }),
        ...(execution.actorUsername === undefined ? {} : { actorUsername: execution.actorUsername }),
        completedAtMs: now,
        expiresAtMs: now + RECENT_ACTOR_TTL_MS,
      });
    }
    this.send(execution.threadId, now);
  }

  state(threadId: string, now = Date.now()): ExecutionPresentationState | null {
    const execution = this.ctx.threadExecution.table.get(threadId);
    if (execution) {
      return {
        phase: "running",
        ...(execution.actorUserId === undefined ? {} : { actorUserId: execution.actorUserId }),
        ...(execution.actorUsername === undefined ? {} : { actorUsername: execution.actorUsername }),
      };
    }
    const recent = this.recent.get(threadId);
    if (recent?.expiresAtMs !== undefined && recent.expiresAtMs > now) return recent;
    if (recent !== undefined) this.recent.delete(threadId);
    return null;
  }

  queueAll(connection: AppServerConnection, now = Date.now()): void {
    const ids = new Set<string>([
      ...[...this.ctx.threadExecution.table.values()]
        .map((execution) => execution.threadId)
        .filter((threadId): threadId is string => typeof threadId === "string"),
      ...this.recent.keys(),
    ]);
    for (const threadId of ids) this.queue(connection, threadId, now);
  }

  queue(connection: AppServerConnection, threadId: string, now = Date.now()): void {
    const thread = this.ctx.threadManager.find(threadId);
    if (thread === null || thread === undefined) return;
    const state = this.state(threadId, now);
    const threadName = executionPresentationName(thread.name, state, connection);
    connection.threadPresentationNames ??= new Map();
    if (connection.threadPresentationNames.get(threadId) === threadName) return;
    if (state !== null) connection.threadPresentationNames.set(threadId, threadName);
    else connection.threadPresentationNames.delete(threadId);
    this.ctx.appServer.notifyAfter(connection, "thread/name/updated", { threadId, threadName });
  }

  send(threadId: string, now = Date.now()): void {
    const thread = this.ctx.threadManager.find(threadId);
    if (thread === null || thread === undefined) return;
    const state = this.state(threadId, now);
    for (const connection of this.ctx.appServer.connections) {
      if (!connection.initialized) continue;
      connection.threadPresentationNames ??= new Map();
      const previous = connection.threadPresentationNames.get(threadId);
      const threadName = executionPresentationName(thread.name, state, connection);
      if (previous === threadName) continue;
      this.sendMessage(connection, {
        method: "thread/name/updated",
        params: { threadId, threadName },
      });
      if (state !== null) connection.threadPresentationNames.set(threadId, threadName);
      else connection.threadPresentationNames.delete(threadId);
    }
  }

  refresh(now = Date.now()): void {
    if (now - this.lastRefreshAtMs < REFRESH_MS) return;
    this.lastRefreshAtMs = now;
    for (const [threadId, recent] of this.recent) {
      if (recent.expiresAtMs <= now) this.send(threadId, now);
    }
  }

  sendMessage(connection: AppServerConnection, message: JsonRpcResponse): void {
    if (typeof this.ctx.appServer.send === "function") this.ctx.appServer.send(connection, message);
    else connection.socket.send(message);
  }
}
