import {
  encodeJsonRpcMessage,
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  parseJsonRpcMessage,
  type AppServerInitializeParams,
  type AppServerInitializeResponse,
  type AppServerMethod,
  type AppServerMethodParams,
  type AppServerMethodResult,
  type AppServerNotification,
  type AppServerRequestOptions,
  type AppServerServerRequest,
  type AppServerServerMethod,
  type AppServerServerRequestParams,
  type AppServerServerRequestResult,
  type TypedAppServerServerRequest,
  type JsonRpcId,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";

import { AppServerClientError, AppServerRpcError } from "./errors";
import type { DuplexTransport, TransportStatus } from "./transport";

export interface AppServerClientClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timerId: ReturnType<typeof globalThis.setTimeout>): void;
}

export interface AppServerClientConfig {
  hostId: string;
  transport: DuplexTransport;
  requestTimeoutMs?: number;
  clock?: AppServerClientClock;
  createRequestId?: () => JsonRpcId;
  /** Bounds memory and load when a host or link stops making progress. */
  maxPendingRequests?: number;
}

/**
 * Delivery receipt for one AppServer-initiated request.
 *
 * A handler returning a result only releases the response payload to the
 * client. `delivered` settles after that JSON-RPC response is physically sent
 * on the receiving connection (or the Host resolves the request independently).
 * Connection loss rejects this receipt even if the handler is still running.
 */
export interface ServerRequestResponseContext {
  readonly delivered: Promise<void>;
}

export type ServerRequestHandler = (
  params: unknown,
  request: AppServerServerRequest,
  context: ServerRequestResponseContext,
) => unknown | Promise<unknown>;

export type TypedServerRequestHandler<TMethod extends AppServerServerMethod> = (
  params: AppServerServerRequestParams<TMethod>,
  request: TypedAppServerServerRequest<TMethod>,
  context: ServerRequestResponseContext,
) => AppServerServerRequestResult<TMethod> | Promise<AppServerServerRequestResult<TMethod>>;

export type AppServerNotificationInterceptor = (
  notification: AppServerNotification,
  next: () => void,
) => void;

export type AppServerServerRequestInterceptor = (
  request: AppServerServerRequest,
  next: () => Promise<unknown>,
  context: ServerRequestResponseContext,
) => unknown | Promise<unknown>;

interface PendingRequest {
  controller: AbortController;
  id: JsonRpcId;
  method: string;
  priority: AppServerRequestOptions["priority"];
  queuedAtMs: number;
  startedAtMs: number;
  params: unknown;
  timeoutMs: number;
  preparationTurnId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timerId: ReturnType<typeof globalThis.setTimeout> | null;
  removeAbortListener(): void;
}

interface MutableServerRequestResponseContext extends ServerRequestResponseContext {
  resolve(): void;
  reject(error: Error): void;
}

interface ActiveServerRequest {
  readonly request: JsonRpcRequest;
  readonly revision: number;
  readonly controller: AbortController;
  readonly context: MutableServerRequestResponseContext;
  phase: "handling" | "sending";
}

function createServerRequestResponseContext(): MutableServerRequestResponseContext {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const delivered = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Most handlers do not need delivery observation. Retain the rejecting
  // promise for interested owners without producing an unhandled rejection
  // when a legacy handler ignores the optional lifecycle detail.
  void delivered.catch(() => undefined);
  return { delivered, resolve, reject };
}

function utf8ResponseBytes(frame: string): number {
  let bytes = frame.length;
  for (let i = 0; i < frame.length; i++) {
    const code = frame.charCodeAt(i);
    if (code > 0x7f) {
      if (code <= 0x7ff) bytes++;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < frame.length
        && frame.charCodeAt(i + 1) >= 0xdc00 && frame.charCodeAt(i + 1) <= 0xdfff) { bytes += 2; i++; }
      else bytes += 2;
    }
  }
  return bytes;
}

let clientIncarnationSequence = 0;
const systemClock: AppServerClientClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timerId) => globalThis.clearTimeout(timerId),
};

interface RequestLifecycleBase {
  hostId: string;
  id: JsonRpcId;
  method: string;
  priority: AppServerRequestOptions["priority"];
}

export type AppServerRequestLifecycleEvent =
  | (RequestLifecycleBase & { type: "queued"; queuedAtMs: number })
  | (RequestLifecycleBase & {
      type: "started";
      startedAtMs: number;
      queueWaitMs: number;
      params: unknown;
      timeoutMs: number;
    })
  | (RequestLifecycleBase & {
      type: "completed";
      endedAtMs: number;
      durationMs: number;
      result: unknown;
      /** UTF-8 response size, computed only when an observer requests it. */
      readonly responseBytes?: number;
    })
  | (RequestLifecycleBase & {
      type: "failed" | "timed-out" | "aborted";
      endedAtMs: number;
      durationMs: number;
      error: Error;
      readonly responseBytes?: number;
    })
  | { type: "late-response"; hostId: string; id: JsonRpcId; receivedAtMs: number };

export interface AppServerClient {
  readonly hostId: string;
  readonly status: TransportStatus;
  readonly initializeResult: AppServerInitializeResponse | null;
  readonly connectionGeneration: number;
  connect(params: AppServerInitializeParams, signal?: AbortSignal): Promise<AppServerInitializeResponse>;
  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
    options?: AppServerRequestOptions,
  ): Promise<AppServerMethodResult<TMethod>>;
  requestRaw<TResult = unknown>(
    method: string,
    params: unknown,
    options?: AppServerRequestOptions,
  ): Promise<TResult>;
  subscribeNotification(listener: (notification: AppServerNotification) => void): () => void;
  interceptNotification(interceptor: AppServerNotificationInterceptor): () => void;
  interceptServerRequest(interceptor: AppServerServerRequestInterceptor): () => void;
  subscribeProtocolError(listener: (error: Error) => void): () => void;
  subscribeStatus(listener: (status: TransportStatus) => void): () => void;
  subscribeRequestLifecycle(listener: (event: AppServerRequestLifecycleEvent) => void): () => void;
  getPendingRequestCount(): number;
  handleServerRequest<TMethod extends AppServerServerMethod>(
    method: TMethod,
    handler: TypedServerRequestHandler<TMethod>,
  ): () => void;
  handleServerRequest(method: string, handler: ServerRequestHandler): () => void;
  close(): Promise<void>;
}

export class JsonRpcAppServerClient implements AppServerClient {
  readonly hostId: string;

  private readonly transport: DuplexTransport;
  private readonly requestTimeoutMs: number;
  private readonly clock: AppServerClientClock;
  private readonly createRequestId: () => JsonRpcId;
  private readonly maxPendingRequests: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly notificationInterceptors = new Set<AppServerNotificationInterceptor>();
  private readonly protocolErrorListeners = new Set<(error: Error) => void>();
  private readonly requestLifecycleListeners = new Set<(event: AppServerRequestLifecycleEvent) => void>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly serverRequestInterceptors = new Set<AppServerServerRequestInterceptor>();
  private readonly activeServerRequests = new Set<ActiveServerRequest>();
  private readonly removeMessageListener: () => void;
  private readonly removeStatusListener: () => void;
  private requestSequence = 0;
  private generation = 0;
  private transportRevision = 0;
  private closed = false;
  private initialized: AppServerInitializeResponse | null = null;
  private initializePromise: Promise<AppServerInitializeResponse> | null = null;

  constructor(config: AppServerClientConfig) {
    this.hostId = config.hostId;
    this.transport = config.transport;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.clock = config.clock ?? systemClock;
    const incarnation = ++clientIncarnationSequence;
    this.createRequestId = config.createRequestId ?? (() => `${this.hostId}:client-${incarnation}:${++this.requestSequence}`);
    this.maxPendingRequests = config.maxPendingRequests ?? 256;
    if (!Number.isInteger(this.maxPendingRequests) || this.maxPendingRequests < 1) {
      throw new RangeError("maxPendingRequests must be a positive integer");
    }
    this.removeMessageListener = this.transport.subscribeMessage((frame) => this.receive(frame));
    this.removeStatusListener = this.transport.subscribeStatus((status) => this.handleTransportStatus(status));
  }

  get status(): TransportStatus {
    return this.transport.status;
  }

  get initializeResult(): AppServerInitializeResponse | null {
    return this.initialized;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  async connect(
    params: AppServerInitializeParams,
    signal?: AbortSignal,
  ): Promise<AppServerInitializeResponse> {
    if (this.closed) throw new AppServerClientError("CLOSED", "AppServer client is closed");
    if (this.transport.status.state === "open" && this.initialized !== null) return this.initialized;
    if (this.initializePromise !== null) return this.initializePromise;
    // Transport status observers may synchronously call connect again.
    // Own the shared initialization before entering any transport code.
    const operation = Promise.resolve().then(async () => {
      if (this.closed) throw new AppServerClientError("CLOSED", "AppServer client is closed");
      if (signal?.aborted) throw new AppServerClientError("ABORTED", "AppServer connection was aborted");
      await this.transport.connect(signal);
      const revision = this.transportRevision;
      const result = await this.request("initialize", params, { signal, priority: "user-blocking" });
      if (this.closed || revision !== this.transportRevision || this.transport.status.state !== "open") {
        throw new AppServerClientError("TRANSPORT_ERROR", "AppServer initialization belongs to a lost connection");
      }
      this.initialized = result;
      this.generation += 1;
      return result;
    });
    this.initializePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.initializePromise === operation) this.initializePromise = null;
    }
  }

  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
    options?: AppServerRequestOptions,
  ): Promise<AppServerMethodResult<TMethod>> {
    return this.requestRaw<AppServerMethodResult<TMethod>>(method, params, options);
  }

  requestRaw<TResult = unknown>(
    method: string,
    params: unknown,
    options: AppServerRequestOptions = {},
  ): Promise<TResult> {
    if (this.closed) return Promise.reject(new AppServerClientError("CLOSED", "AppServer client is closed"));
    if (this.transport.status.state !== "open") {
      return Promise.reject(new AppServerClientError("NOT_CONNECTED", "AppServer transport is not open"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new AppServerClientError("ABORTED", `AppServer request ${method} was aborted`));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new AppServerClientError(
        "QUEUE_FULL",
        `AppServer request queue reached its limit of ${this.maxPendingRequests}`,
      ));
    }

    const id = this.createRequestId();
    if (this.pending.has(id)) {
      return Promise.reject(new AppServerClientError(
        "PROTOCOL_ERROR",
        `AppServer request id ${String(id)} is already pending`,
      ));
    }
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const queuedAtMs = this.clock.now();

    return new Promise<TResult>((resolve, reject) => {
      const abort = () => {
        this.rejectPending(
          id,
          new AppServerClientError("ABORTED", `AppServer request ${method} was aborted`),
          "aborted",
        );
      };
      options.signal?.addEventListener("abort", abort, { once: true });

      const pending: PendingRequest = {
        controller: new AbortController(),
        id,
        method,
        priority: options.priority,
        queuedAtMs,
        startedAtMs: queuedAtMs,
        params,
        timeoutMs,
        resolve: (value) => resolve(value as TResult),
        reject,
        timerId: timeoutMs > 0
          ? this.clock.setTimeout(() => {
              this.rejectPending(
                id,
                new AppServerClientError("TIMEOUT", `AppServer request ${method} timed out after ${timeoutMs} ms`),
                "timed-out",
              );
            }, timeoutMs)
          : null,
        removeAbortListener: () => options.signal?.removeEventListener("abort", abort),
      };
      this.pending.set(id, pending);
      this.emitRequestLifecycle({
        type: "queued",
        hostId: this.hostId,
        id,
        method,
        priority: options.priority,
        queuedAtMs,
      });
      if (this.pending.get(id) !== pending) return;
      pending.startedAtMs = this.clock.now();
      this.emitRequestLifecycle({
        type: "started",
        hostId: this.hostId,
        id,
        method,
        priority: options.priority,
        startedAtMs: pending.startedAtMs,
        queueWaitMs: pending.startedAtMs - pending.queuedAtMs,
        params,
        timeoutMs,
      });
      if (this.pending.get(id) !== pending) return;

      if (this.pending.get(id) !== pending) return;
      const fail = (error: unknown) => {
        if (this.pending.get(id) !== pending) return;
        this.rejectPending(id, new AppServerClientError("TRANSPORT_ERROR", `Failed to send AppServer request ${method}`, {
          cause: error,
        }), "failed");
      };
      try {
        const frame = encodeJsonRpcMessage(request);
        if (this.pending.get(id) !== pending) return;
        void Promise.resolve(this.transport.send(frame, pending.controller.signal)).catch(fail);
      } catch (error) { fail(error); }
    });
  }

  subscribeNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  interceptNotification(interceptor: AppServerNotificationInterceptor): () => void {
    this.notificationInterceptors.add(interceptor);
    return () => this.notificationInterceptors.delete(interceptor);
  }

  interceptServerRequest(interceptor: AppServerServerRequestInterceptor): () => void {
    this.serverRequestInterceptors.add(interceptor);
    return () => this.serverRequestInterceptors.delete(interceptor);
  }

  subscribeProtocolError(listener: (error: Error) => void): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.transport.subscribeStatus(listener);
  }

  subscribeRequestLifecycle(listener: (event: AppServerRequestLifecycleEvent) => void): () => void {
    this.requestLifecycleListeners.add(listener);
    return () => this.requestLifecycleListeners.delete(listener);
  }

  getPendingRequestCount(): number {
    return this.pending.size;
  }

  handleServerRequest<TMethod extends AppServerServerMethod>(
    method: TMethod,
    handler: TypedServerRequestHandler<TMethod>,
  ): () => void;
  handleServerRequest(method: string, handler: ServerRequestHandler): () => void;
  handleServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initialized = null;
    this.rejectAllPending(new AppServerClientError("CLOSED", "AppServer client closed"));
    this.invalidateServerRequests(new AppServerClientError("CLOSED", "AppServer client closed"));
    this.removeMessageListener();
    this.removeStatusListener();
    this.notificationListeners.clear();
    this.notificationInterceptors.clear();
    this.protocolErrorListeners.clear();
    this.requestLifecycleListeners.clear();
    this.serverRequestHandlers.clear();
    this.serverRequestInterceptors.clear();
    await this.transport.close();
  }

  private receive(frame: string): void {
    let message;
    try {
      message = parseJsonRpcMessage(frame);
    } catch (error) {
      this.emitProtocolError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (isJsonRpcRequest(message)) {
      void this.answerServerRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      const notification: AppServerNotification = {
        method: message.method,
        params: message.params,
      };
      this.trackContextPreparation(notification);
      if (notification.method === "serverRequest/resolved") {
        const { requestId, threadId } = notification.params as { readonly requestId?: unknown; readonly threadId?: unknown };
        if (typeof requestId === "string" || typeof requestId === "number") {
          for (const active of this.activeServerRequests) {
            const requestThreadId = (active.request.params as { readonly threadId?: unknown } | null)?.threadId;
            if (active.revision !== this.transportRevision || typeof active.request.id !== typeof requestId || active.request.id !== requestId) continue;
            if (typeof threadId === "string" && typeof requestThreadId === "string" && threadId !== requestThreadId) continue;
            this.settleServerRequest(active);
          }
        }
      }
      this.dispatchNotification(notification);
      return;
    }

    const pending = message.id === null ? undefined : this.pending.get(message.id);
    if (pending === undefined) {
      if (message.id !== null) {
        this.emitRequestLifecycle({
          type: "late-response",
          hostId: this.hostId,
          id: message.id,
          receivedAtMs: this.clock.now(),
        });
      }
      this.emitProtocolError(new AppServerClientError(
        "PROTOCOL_ERROR",
        `Received AppServer response for unknown request id ${String(message.id)}`,
      ));
      return;
    }
    this.cleanupPending(message.id as JsonRpcId, pending);
    const endedAtMs = this.clock.now();
    if (isJsonRpcFailure(message)) {
      const error = new AppServerRpcError(message.error);
      pending.reject(error);
      this.emitRequestLifecycle({
        ...this.lifecycleBase(pending),
        type: "failed",
        endedAtMs,
        durationMs: endedAtMs - pending.startedAtMs,
        error,
        get responseBytes() { return utf8ResponseBytes(frame); },
      });
    } else if (isJsonRpcSuccess(message)) {
      pending.resolve(message.result);
      this.emitRequestLifecycle({
        ...this.lifecycleBase(pending),
        type: "completed",
        endedAtMs,
        durationMs: endedAtMs - pending.startedAtMs,
        result: message.result,
        get responseBytes() { return utf8ResponseBytes(frame); },
      });
    }
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<void> {
    const responseContext = createServerRequestResponseContext();
    const active: ActiveServerRequest = {
      request, revision: this.transportRevision, controller: new AbortController(),
      context: responseContext, phase: "handling",
    };
    this.activeServerRequests.add(active);
    let response: Parameters<typeof encodeJsonRpcMessage>[0];
    try {
      const serverRequest: AppServerServerRequest = {
        id: request.id,
        method: request.method,
        params: request.params,
      };
      const result = await this.dispatchServerRequest(serverRequest, responseContext);
      response = { id: request.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AppServerRpcError ? error.code : -32000;
      response = { id: request.id, error: { code, message } };
    }
    // The owner is removed by resolution, connection loss or client disposal.
    // A late handler may finish, but it no longer has a right to reply.
    if (!this.activeServerRequests.has(active)) return;
    if (this.closed || active.revision !== this.transportRevision || this.transport.status.state !== "open") {
      this.settleServerRequest(active, new AppServerClientError("TRANSPORT_ERROR", "AppServer request belongs to a lost connection"));
      return;
    }
    active.phase = "sending";
    try {
      await this.transport.send(encodeJsonRpcMessage(response), active.controller.signal);
      this.settleServerRequest(active);
    } catch (sendError) {
      const deliveryError = new AppServerClientError(
        "TRANSPORT_ERROR",
        `Failed to answer AppServer request ${request.method}`,
        { cause: sendError },
      );
      if (this.settleServerRequest(active, deliveryError)) this.emitProtocolError(deliveryError);
    }
  }

  private settleServerRequest(active: ActiveServerRequest, error?: Error): boolean {
    if (!this.activeServerRequests.delete(active)) return false;
    active.controller.abort();
    if (error === undefined) active.context.resolve();
    else active.context.reject(error);
    return true;
  }

  private invalidateServerRequests(error: Error): void {
    for (const active of this.activeServerRequests) this.settleServerRequest(active, error);
  }

  private dispatchNotification(notification: AppServerNotification): void {
    const interceptors = [...this.notificationInterceptors];
    const dispatch = (index: number): void => {
      if (index >= interceptors.length) {
        for (const listener of this.notificationListeners) {
          try {
            listener(notification);
          } catch (error) {
            this.emitProtocolError(new AppServerClientError(
              "PROTOCOL_ERROR",
              `AppServer notification listener failed for ${notification.method}`,
              { cause: error },
            ));
          }
        }
        return;
      }
      let called = false;
      try {
        interceptors[index]?.(notification, () => {
          if (called) throw new AppServerClientError(
            "PROTOCOL_ERROR",
            `AppServer notification interceptor called next twice for ${notification.method}`,
          );
          called = true;
          dispatch(index + 1);
        });
      } catch (error) {
        this.emitProtocolError(new AppServerClientError(
          "PROTOCOL_ERROR",
          `AppServer notification interceptor failed for ${notification.method}`,
          { cause: error },
        ));
      }
    };
    dispatch(0);
  }

  private dispatchServerRequest(
    request: AppServerServerRequest,
    context: ServerRequestResponseContext,
  ): Promise<unknown> {
    const interceptors = [...this.serverRequestInterceptors];
    const dispatch = async (index: number): Promise<unknown> => {
      if (index >= interceptors.length) {
        const handler = this.serverRequestHandlers.get(request.method);
        if (handler === undefined) {
          throw new AppServerRpcError({ code: -32601, message: `No client handler for ${request.method}` });
        }
        return handler(request.params, request, context);
      }
      let called = false;
      return interceptors[index]?.(request, () => {
        if (called) return Promise.reject(new AppServerClientError(
          "PROTOCOL_ERROR",
          `AppServer request interceptor called next twice for ${request.method}`,
        ));
        called = true;
        return dispatch(index + 1);
      }, context);
    };
    return dispatch(0);
  }

  private handleTransportStatus(status: TransportStatus): void {
    if (status.state === "closing") {
      this.invalidateServerRequests(new AppServerClientError("TRANSPORT_ERROR", "AppServer transport closed"));
      return;
    }
    if (status.state !== "closed" && status.state !== "failed") return;
    this.transportRevision += 1;
    this.initialized = null;
    const reason = status.reason == null ? "AppServer transport closed" : `AppServer transport closed: ${status.reason}`;
    this.rejectAllPending(new AppServerClientError("TRANSPORT_ERROR", reason), "failed");
    this.invalidateServerRequests(new AppServerClientError("TRANSPORT_ERROR", reason));
  }

  private trackContextPreparation(notification: AppServerNotification): void {
    const params = notification.params as { threadId?: unknown; turnId?: unknown; item?: { type?: unknown }; turn?: { id?: unknown } } | null;
    if (typeof params?.threadId !== "string") return;
    const started = notification.method === "item/started" && params.item?.type === "contextCompaction" && typeof params.turnId === "string";
    const completed = notification.method === "turn/completed" && typeof params.turn?.id === "string";
    if (!started && !completed) return;
    for (const pending of this.pending.values()) {
      if (pending.timeoutMs <= 0 || !["turn/start", "thread/resume"].includes(pending.method)) continue;
      if ((pending.params as { threadId?: unknown } | null)?.threadId !== params.threadId) continue;
      if (started) {
        if (pending.preparationTurnId !== undefined) continue;
        pending.preparationTurnId = params.turnId as string;
      } else if (pending.preparationTurnId === undefined || pending.preparationTurnId !== params.turn?.id) continue;
      // Context preparation is model work, not a stalled RPC. Extend only for
      // the matching thread and never beyond a bounded absolute deadline.
      const remaining = Math.max(0, pending.startedAtMs + Math.max(pending.timeoutMs, 180_000) - this.clock.now());
      const delay = started ? remaining : Math.min(remaining, pending.timeoutMs);
      if (pending.timerId !== null) this.clock.clearTimeout(pending.timerId);
      pending.timerId = this.clock.setTimeout(() => this.rejectPending(pending.id,
        new AppServerClientError("TIMEOUT", `AppServer request ${pending.method} timed out during context preparation`), "timed-out"), delay);
    }
  }

  private rejectPending(
    id: JsonRpcId,
    error: Error,
    type: "failed" | "timed-out" | "aborted",
  ): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanupPending(id, pending);
    // React Native exposes the standards-compatible abort notification but its
    // type surface still declares abort() without the optional DOM reason.
    // The request promise and lifecycle event already carry the exact error.
    pending.controller.abort();
    pending.reject(error);
    const endedAtMs = this.clock.now();
    this.emitRequestLifecycle({
      ...this.lifecycleBase(pending),
      type,
      endedAtMs,
      durationMs: endedAtMs - pending.startedAtMs,
      error,
    });
  }

  private cleanupPending(id: JsonRpcId, pending: PendingRequest): void {
    this.pending.delete(id);
    if (pending.timerId !== null) this.clock.clearTimeout(pending.timerId);
    pending.removeAbortListener();
  }

  private rejectAllPending(error: Error, type: "failed" | "aborted" = "failed"): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error, type);
  }

  private emitProtocolError(error: Error): void {
    for (const listener of this.protocolErrorListeners) {
      try {
        listener(error);
      } catch {
        // Observability hooks must never corrupt request or transport state.
      }
    }
  }

  private lifecycleBase(pending: PendingRequest): RequestLifecycleBase {
    return {
      hostId: this.hostId,
      id: pending.id,
      method: pending.method,
      priority: pending.priority,
    };
  }

  private emitRequestLifecycle(event: AppServerRequestLifecycleEvent): void {
    for (const listener of this.requestLifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Matches Desktop's listener isolation without imposing a logger.
      }
    }
  }
}
