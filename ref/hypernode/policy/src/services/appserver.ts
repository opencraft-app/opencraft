import { Service } from "@deepseek-ai/cordis";
import { POLICY_CONFIG } from "../config.ts";
import type { VirtualWebSocket } from "../runtime/virtual-websocket.ts";
import type {
  AppServerAttachMetadata,
  AppServerClientInfo,
  AppServerConnection,
  AppServerDeferredController,
  AppServerDeferredResult,
  DeferredAction,
  AppServerHandler,
  AppServerInitializeListener,
  AppServerInterceptor,
  AppServerProjector,
  AppServerResponseListener,
  AppServerRuntimePort,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext } from "../types/context.ts";
import { VfsError } from "./memory-vfs.ts";
import { abortUnroutedTurnStart } from "./request-lifecycle.ts";
import {
  PresentationDrainBarrierRegistry,
  type PresentationMetadata,
} from "./websocket-presentation-queue.ts";

type RequestListener = (connection: AppServerConnection, request: JsonRpcRequest) => void;
type ConnectionListener = (connection: AppServerConnection) => void;

interface SensitiveOptions {
  sensitive?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function property(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isDeferredResult(value: unknown): value is AppServerDeferredResult {
  return isRecord(value) && value["__hypernodeDeferredRpc"] === true &&
    typeof value["start"] === "function";
}

export function deferredAppServerResponse(
  start: (controller: AppServerDeferredController) => void,
): AppServerDeferredResult {
  return { __hypernodeDeferredRpc: true, start };
}

function integerProperty(value: unknown, key: string): number | null {
  const candidate = property(value, key);
  return Number.isInteger(candidate) ? Number(candidate) : null;
}

function wireError(error: unknown): JsonRpcError {
  const code = integerProperty(error, "code") ?? -32000;
  const explicitData = property(error, "data");
  const data = explicitData ?? (error instanceof VfsError
    ? { code: error.code, path: error.path }
    : undefined);
  return {
    code,
    message: errorMessage(error),
    ...(data === undefined ? {} : { data }),
  };
}

function notifyHostOutput(): void {
  globalThis.hostEvents?.notify?.();
}

export class AppServerVService extends Service implements AppServerRuntimePort {
  static inject = ["vfs"];

  declare protected ctx: HypernodeContext<"vfs">;
  private readonly vfs: HypernodeContext<"vfs">["vfs"];
  private readonly handlers = new Map<string, AppServerHandler>();
  private readonly interceptors = new Set<AppServerInterceptor>();
  private readonly initializeListeners = new Set<AppServerInitializeListener>();
  private readonly afterRequestListeners = new Set<RequestListener>();
  private readonly afterResponseListeners = new Set<AppServerResponseListener>();
  private readonly afterPollListeners = new Set<ConnectionListener>();
  private readonly outboundProjectors = new Set<AppServerProjector>();
  private readonly closeListeners = new Set<ConnectionListener>();
  readonly connections = new Set<AppServerConnection>();
  private readonly presentationBarriers: PresentationDrainBarrierRegistry;
  filesystemWatchSequence = 0;

  constructor(ctx: HypernodeContext<"vfs" | "storage">) {
    super(ctx, "appServer");
    this.vfs = ctx.vfs;
    this.presentationBarriers = new PresentationDrainBarrierRegistry({
      sockets: () => [...this.connections].map((connection) => connection.socket),
      requestWake: (delayMs) => {
        if (typeof globalThis.hostEvents?.wakeAfter === "function") {
          globalThis.hostEvents.wakeAfter(delayMs);
        } else {
          notifyHostOutput();
        }
      },
    });
  }

  summarizeMessage(message: JsonRpcRequest): Record<string, unknown> {
    const params = message.params ?? {};
    const summary: Record<string, unknown> = {
      id: message.id ?? null,
      method: message.method ?? null,
      paramKeys: Object.keys(params).sort(),
    };
    for (const key of [
      "path", "sourcePath", "destinationPath", "cwd", "processId", "threadId",
      "environmentId", "sectionId", "beforeThreadId", "projectId", "source",
      "pluginName", "pluginId", "remoteMarketplaceName", "marketplaceName",
    ]) {
      if (typeof params[key] === "string") summary[key] = params[key];
    }
    const command = params["command"];
    if (Array.isArray(command)) summary["command"] = command.map(String);
    else if (typeof command === "string") summary["command"] = command;
    if (typeof params["permissions"] === "string") summary["permissions"] = params["permissions"];
    if (typeof params["model"] === "string") summary["model"] = params["model"];
    else if (params["model"] != null) summary["modelType"] = typeof params["model"];
    const collaborationSettings = property(property(params, "collaborationMode"), "settings");
    const collaborationModel = property(collaborationSettings, "model");
    if (typeof collaborationModel === "string") summary["collaborationModel"] = collaborationModel;
    const sandboxPolicyType = property(params["sandboxPolicy"], "type");
    if (typeof sandboxPolicyType === "string") summary["sandboxPolicyType"] = sandboxPolicyType;
    else if (Object.prototype.hasOwnProperty.call(params, "sandboxPolicy")) summary["sandboxPolicyType"] = null;
    if (Array.isArray(params["runtimeWorkspaceRoots"])) {
      summary["runtimeWorkspaceRootCount"] = params["runtimeWorkspaceRoots"].length;
    }
    if (Array.isArray(params["marketplaceKinds"])) {
      summary["marketplaceKinds"] = params["marketplaceKinds"].map(String);
    }
    if (params["forceRefetch"] === true) summary["forceRefetch"] = true;
    if (typeof params["dataBase64"] === "string") {
      summary["dataBase64Length"] = params["dataBase64"].length;
    }
    return summary;
  }

  summarizeResult(result: unknown): Record<string, unknown> {
    if (!isRecord(result)) return { resultType: typeof result };
    const summary: Record<string, unknown> = { resultKeys: Object.keys(result).sort() };
    if (Array.isArray(result["entries"])) summary["entryCount"] = result["entries"].length;
    if (Array.isArray(result["data"])) {
      summary["dataCount"] = result["data"].length;
      summary["dataIds"] = result["data"].slice(0, 20)
        .map((item) => property(item, "id"))
        .filter((id): id is string => typeof id === "string");
      summary["nextCursor"] = result["nextCursor"] ?? null;
    }
    if (typeof result["dataBase64"] === "string") {
      summary["dataBase64Length"] = result["dataBase64"].length;
      summary["decodedBytes"] = Math.floor(result["dataBase64"].length * 3 / 4) -
        (result["dataBase64"].endsWith("==") ? 2 : result["dataBase64"].endsWith("=") ? 1 : 0);
    }
    return summary;
  }

  audit(
    connection: AppServerConnection,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const connectionId = connection.connectionId ?? "";
    const sessionId = connection.sessionId ?? "";
    const record = { client: connection.clientInfo, ...payload };
    // Protocol auditing is disabled on the hot path. Desktop can issue a large
    // volume of filesystem and stale-thread probes; even journal-only logging
    // crosses the host bridge synchronously and can starve turn/start. Keep
    // only failures as operational warnings.
    if (type === "rpc.error") {
      console.warn(
        `[app-server] ${type} connection=${connectionId || "-"} session=${sessionId || "-"} ${JSON.stringify(record)}`,
      );
    }
  }

  register(method: string, handler: AppServerHandler): () => boolean {
    if (this.handlers.has(method)) throw new Error(`duplicate app-server handler: ${method}`);
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  intercept(handler: AppServerInterceptor): () => boolean {
    this.interceptors.add(handler);
    return () => this.interceptors.delete(handler);
  }

  projectOutbound(handler: AppServerProjector): () => boolean {
    this.outboundProjectors.add(handler);
    return () => this.outboundProjectors.delete(handler);
  }

  project(connection: AppServerConnection, message: JsonRpcResponse): JsonRpcResponse | null {
    let projected = message;
    for (const projector of this.outboundProjectors) {
      const next = projector(projected, connection);
      if (next === null) return null;
      if (next !== undefined) projected = next;
    }
    return projected;
  }

  send(connection: AppServerConnection, message: JsonRpcResponse, sensitive = false): void {
    const projected = this.project(connection, message);
    if (projected !== null) connection.socket.send(projected, sensitive);
  }

  notifyAfter(
    connection: AppServerConnection,
    method: string,
    params: unknown,
    options: SensitiveOptions = {},
  ): void {
    connection.pendingNotifications.push({
      method,
      params,
      sensitive: options.sensitive === true,
    });
  }

  afterPresentationDrained(metadata: PresentationMetadata, action: () => void): boolean {
    return this.presentationBarriers.afterDrained(metadata, action);
  }

  defer(connection: AppServerConnection, delayMs: number, action: () => void): void {
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    connection.deferredActions.push({ dueAtMs: Date.now() + delay, action });
    if (typeof globalThis.hostEvents?.wakeAfter === "function") {
      globalThis.hostEvents.wakeAfter(delay);
    } else {
      notifyHostOutput();
    }
  }

  flushDeferredActions(connection: AppServerConnection, now = Date.now()): void {
    const ready: DeferredAction[] = [];
    const pending: DeferredAction[] = [];
    for (const entry of connection.deferredActions) {
      (entry.dueAtMs <= now ? ready : pending).push(entry);
    }
    connection.deferredActions = pending;
    for (const entry of ready) {
      try {
        entry.action();
      } catch (error) {
        console.warn(`[app-server] deferred action failed error=${errorMessage(error)}`);
      }
    }
  }

  tick(now = Date.now()): void {
    this.presentationBarriers.flush();
    for (const connection of this.connections) {
      this.flushDeferredActions(connection, now);
      this.flushNotifications(connection);
    }
  }

  notifyAllAfter(
    origin: AppServerConnection,
    method: string,
    params: unknown,
    options: SensitiveOptions = {},
  ): void {
    for (const connection of this.connections) {
      if (!connection.initialized) continue;
      if (connection === origin) this.notifyAfter(connection, method, params, options);
      else this.send(connection, { method, params }, options.sensitive === true);
    }
  }

  onInitialize(listener: AppServerInitializeListener): () => boolean {
    this.initializeListeners.add(listener);
    return () => this.initializeListeners.delete(listener);
  }

  onAfterRequest(listener: RequestListener): () => boolean {
    this.afterRequestListeners.add(listener);
    return () => this.afterRequestListeners.delete(listener);
  }

  onAfterResponse(listener: AppServerResponseListener): () => boolean {
    this.afterResponseListeners.add(listener);
    return () => this.afterResponseListeners.delete(listener);
  }

  onAfterPoll(listener: ConnectionListener): () => boolean {
    this.afterPollListeners.add(listener);
    return () => this.afterPollListeners.delete(listener);
  }

  onClose(listener: ConnectionListener): () => boolean {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  flushNotifications(connection: AppServerConnection): void {
    for (const notification of connection.pendingNotifications.splice(0)) {
      this.send(
        connection,
        { method: notification.method, params: notification.params },
        notification.sensitive,
      );
    }
  }

  broadcastNotification(method: string, params: unknown, options: SensitiveOptions = {}): void {
    for (const connection of this.connections) {
      this.send(connection, { method, params }, options.sensitive === true);
    }
  }

  attach(socket: VirtualWebSocket, metadata: AppServerAttachMetadata = {}): void {
    const connection: AppServerConnection = {
      clientInfo: null,
      initializeParams: null,
      initialized: false,
      pendingNotifications: [],
      deferredActions: [],
      socket,
      watches: new Map(),
      unroutableWatchPaths: new Set(),
      identity: metadata.identity ?? null,
      connectionId: metadata.connectionId ?? null,
      sessionId: metadata.sessionId ?? null,
    };
    this.connections.add(connection);
    console.info(`[appserver-lifecycle] ${JSON.stringify({
      phase: "attached",
      connectionId: connection.connectionId,
      sessionId: connection.sessionId,
    })}`);
    const stopWatching = this.vfs.onChange((paths) => {
      for (const [watchId, watch] of connection.watches) {
        const watchedPath = typeof watch === "string" ? watch : watch.path;
        if (typeof watch !== "string" && watch.routable === false) continue;
        const changedPaths = paths.filter(
          (path) => path === watchedPath || path.startsWith(`${watchedPath}/`),
        );
        if (changedPaths.length > 0) {
          socket.send({ method: "fs/changed", params: { watchId, changedPaths } });
        }
      }
    });
    socket.on("message", (text) => this.onMessage(socket, text, connection));
    socket.on("presentation-drained", () => notifyHostOutput());
    socket.on("poll", () => {
      this.presentationBarriers.flush();
      this.flushDeferredActions(connection);
      for (const [watchId, watch] of connection.watches) {
        if (typeof watch === "string" || typeof watch.drain !== "function") continue;
        try {
          const changedPaths = watch.drain();
          if (changedPaths.length > 0) {
            socket.send({ method: "fs/changed", params: { watchId, changedPaths } });
          }
        } catch (error) {
          console.warn(`[filesystem] watch drain failed path=${watch.path} error=${errorMessage(error)}`);
        }
      }
      for (const interceptor of this.interceptors) interceptor(null, connection);
      for (const listener of this.afterPollListeners) listener(connection);
      this.flushNotifications(connection);
    });
    socket.on("close", () => {
      console.info(`[appserver-lifecycle] ${JSON.stringify({
        phase: "closed",
        connectionId: connection.connectionId,
        sessionId: connection.sessionId,
        initialized: connection.initialized,
        activeThreadId: connection.activeThreadId ?? null,
        pendingNotifications: connection.pendingNotifications.length,
        deferredActions: connection.deferredActions.length,
        watches: connection.watches.size,
        socketPendingFrames: connection.socket.pendingFrames,
      })}`);
      this.connections.delete(connection);
      connection.deferredActions.splice(0);
      stopWatching();
      for (const watch of connection.watches.values()) {
        if (typeof watch !== "string") watch.stop?.();
      }
      connection.watches.clear();
      for (const listener of this.closeListeners) listener(connection);
      this.presentationBarriers.flush();
    });
  }

  onMessage(
    socket: VirtualWebSocket,
    text: string,
    connection: AppServerConnection,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message: JsonRpcRequest = parsed;
    this.audit(connection, "rpc.request", this.summarizeMessage(message));
    if (message.method === "initialize" && message.id !== undefined) {
      const clientValue = message.params?.["clientInfo"];
      const client: AppServerClientInfo = isRecord(clientValue) ? clientValue : {};
      connection.clientInfo = client;
      connection.initializeParams = message.params ?? {};
      const result = {
        userAgent: `hypernode/${POLICY_CONFIG.cliVersion} (Linux Unknown; x86_64) dumb (${typeof client.name === "string" ? client.name : "unknown"}; ${typeof client.version === "string" ? client.version : "unknown"})`,
        codexHome: POLICY_CONFIG.codexHome,
        platformFamily: "unix",
        platformOs: "linux",
      };
      this.send(connection, { id: message.id, result });
      this.audit(connection, "rpc.response", {
        id: message.id,
        method: message.method,
        ...this.summarizeResult(result),
      });
      if (!connection.initialized) {
        connection.initialized = true;
        console.info(`[appserver-lifecycle] ${JSON.stringify({
          phase: "initialized",
          connectionId: connection.connectionId,
          sessionId: connection.sessionId,
          clientName: typeof client.name === "string" ? client.name : null,
          clientVersion: typeof client.version === "string" ? client.version : null,
        })}`);
        for (const listener of this.initializeListeners) listener(connection, client);
        this.flushNotifications(connection);
      }
      return;
    }
    if (message.method === "initialized" && message.id === undefined) {
      if (!connection.initialized) {
        connection.initialized = true;
        console.info(`[appserver-lifecycle] ${JSON.stringify({
          phase: "initialized",
          connectionId: connection.connectionId,
          sessionId: connection.sessionId,
          clientName: connection.clientInfo?.name ?? null,
          clientVersion: connection.clientInfo?.version ?? null,
        })}`);
        for (const listener of this.initializeListeners) {
          listener(connection, connection.clientInfo ?? {});
        }
        this.flushNotifications(connection);
      }
      return;
    }
    try {
      for (const interceptor of this.interceptors) {
        if (interceptor(message, connection) === true) return;
      }
    } catch (error) {
      connection.pendingNotifications.splice(0);
      abortUnroutedTurnStart(message, connection, "interceptorFailed");
      const rpcError = wireError(error);
      if (message.id !== undefined) this.send(connection, { id: message.id, error: rpcError });
      this.audit(connection, "rpc.error", {
        id: message.id ?? null,
        method: message.method ?? null,
        code: rpcError.code,
        error: rpcError.message,
        ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
      });
      return;
    }
    const handler = message.method === undefined ? undefined : this.handlers.get(message.method);
    if (handler !== undefined && message.id !== undefined) {
      const requestId = message.id;
      let settled = false;
      const resolve = (result: unknown): void => {
        if (settled) return;
        settled = true;
        if (!this.connections.has(connection)) return;
        this.send(connection, { id: requestId, result });
        this.audit(connection, "rpc.response", {
          id: requestId,
          method: message.method ?? null,
          ...this.summarizeResult(result),
        });
        for (const listener of this.afterResponseListeners) {
          listener(connection, message, result);
        }
        this.flushNotifications(connection);
      };
      const reject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (!this.connections.has(connection)) return;
        connection.pendingNotifications.splice(0);
        abortUnroutedTurnStart(message, connection, "handlerFailed");
        const rpcError = wireError(error);
        this.send(connection, { id: requestId, error: rpcError });
        this.audit(connection, "rpc.error", {
          id: requestId,
          method: message.method ?? null,
          code: rpcError.code,
          error: rpcError.message,
          ...(rpcError.data === undefined ? {} : { data: rpcError.data }),
        });
      };
      try {
        const result = handler(message.params ?? {}, connection);
        for (const listener of this.afterRequestListeners) listener(connection, message);
        if (isDeferredResult(result)) result.start({ resolve, reject });
        else resolve(result);
      } catch (error) {
        reject(error);
      }
      return;
    }
    if (message.id === undefined) return;
    abortUnroutedTurnStart(message, connection, "methodNotFound");
    const method = message.method ?? "unknown";
    this.send(connection, {
      id: message.id,
      error: { code: -32601, message: `Hypernode has not mocked ${method}` },
    });
    this.audit(connection, "rpc.error", {
      id: message.id,
      method,
      code: -32601,
      error: `Hypernode has not mocked ${method}`,
    });
    void socket;
  }
}
