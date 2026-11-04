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

import { executionEngineExtension } from "./execution-engine";
import { elapsedNow } from "./clock";
import { AppServerClientError, AppServerRpcError } from "./errors";
import { ClientObserverList } from "./observer-list";
import type { DuplexTransport, TransportStatus } from "./transport";

export interface AppServerClientClock {
  /** Absolute diagnostic timestamps. Legacy single-clock adapters also supply elapsed time here. */
  now(): number;
  /** Nondecreasing elapsed time for budgets and durations; includes simulated suspension. */
  elapsedNow?(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timerId: ReturnType<typeof globalThis.setTimeout>): void;
}

/** Client-local admission; callbacks are never part of protocol/bridge options. */
export interface AppServerClientRequestOptions extends AppServerRequestOptions {
  /** Synchronous final check after lifecycle observers and serialization.
   * Throw to reject before transport admission; the original error is preserved. */
  beforeSend?(): void;
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
  /** Native request lifetime, independent of any history/view operation.
   * Aborts after this exact context retires; inspect retirement to distinguish
   * Host resolution, a sent answer and connection loss. */
  readonly signal: AbortSignal;
  readonly retirement: "answered" | "resolved" | "lost" | null;
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

interface NotificationSubscription {
  readonly listener: (notification: AppServerNotification) => void;
  readonly options?: AppServerNotificationSubscriptionOptions;
}

export type AppServerServerRequestInterceptor = (
  request: AppServerServerRequest,
  next: () => Promise<unknown>,
  context: ServerRequestResponseContext,
) => unknown | Promise<unknown>;

interface PendingRequest {
  controller: AbortController;
  historyCancellation?: { threadId: string; historyReadId: string };
  id: JsonRpcId;
  method: string;
  priority: AppServerRequestOptions["priority"];
  queuedAtMs: number;
  queuedElapsedAtMs: number;
  startedAtMs: number;
  startedElapsedAtMs: number;
  params: unknown;
  timeoutMs: number;
  preparationTurnId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timerId: ReturnType<typeof globalThis.setTimeout> | null;
  timerTicket: number;
  removeAbortListener(): void;
}

interface MutableServerRequestResponseContext extends ServerRequestResponseContext {
  retirement: ServerRequestResponseContext["retirement"];
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

function createServerRequestResponseContext(signal: AbortSignal): MutableServerRequestResponseContext {
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
  return { delivered, signal, retirement: null, resolve, reject };
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
  elapsedNow,
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
      historySource?: AppServerClientRequestOptions["historySource"];
      timeoutMs: number;
    })
  | (RequestLifecycleBase & {
      type: "completed";
      endedAtMs: number;
      durationMs: number;
      result: unknown;
      /** UTF-8 response size, computed only when an observer requests it. */
      readonly responseBytes?: number;
      readonly decodeMs?: number;
    })
  | (RequestLifecycleBase & {
      type: "failed" | "timed-out" | "aborted";
      endedAtMs: number;
      durationMs: number;
      error: Error;
      readonly responseBytes?: number;
      readonly decodeMs?: number;
    })
  | { type: "late-response"; hostId: string; id: JsonRpcId; receivedAtMs: number };

/** A consumer may defer its own delivery without holding the shared notification
 * lane. Deferred next retains this subscription and physical generation only. */
export interface AppServerNotificationSubscriptionOptions {
  readonly intercept: AppServerNotificationInterceptor;
}

export interface AppServerClient {
  readonly hostId: string;
  readonly status: TransportStatus;
  readonly initializeResult: AppServerInitializeResponse | null;
  readonly connectionGeneration: number;
  connect(params: AppServerInitializeParams, signal?: AbortSignal, assertCurrent?: () => void): Promise<AppServerInitializeResponse>;
  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
    options?: AppServerClientRequestOptions,
  ): Promise<AppServerMethodResult<TMethod>>;
  requestRaw<TResult = unknown>(
    method: string,
    params: unknown,
    options?: AppServerClientRequestOptions,
  ): Promise<TResult>;
  subscribeNotification(listener: (notification: AppServerNotification) => void, options?: AppServerNotificationSubscriptionOptions): () => void;
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
  private elapsedTime() { return this.clock.elapsedNow?.() ?? this.clock.now(); }
  private readonly createRequestId: () => JsonRpcId;
  private readonly maxPendingRequests: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationSubscription>();
  private readonly nativeNotificationListeners = new Map<NotificationSubscription["listener"], NotificationSubscription>();
  private readonly notificationInterceptors = new Set<AppServerNotificationInterceptor>();
  private readonly protocolErrorListeners = new ClientObserverList<Error>();
  private readonly requestLifecycleListeners = new ClientObserverList<AppServerRequestLifecycleEvent>();
  private readonly serverRequestHandlers = new Map<string, { readonly handler: ServerRequestHandler }>();
  private readonly serverRequestInterceptors = new Set<AppServerServerRequestInterceptor>();
  private readonly activeServerRequests = new Set<ActiveServerRequest>();
  private readonly removeMessageListener: () => void;
  private readonly removeStatusListener: () => void;
  private requestSequence = 0;
  private generation = 0;
  private transportRevision = 0;
  private transportRetired = true;
  private closed = false;
  private initialized: AppServerInitializeResponse | null = null;
  private initializationSignal: AbortSignal | undefined;
  private initialization: { readonly promise: Promise<AppServerInitializeResponse>; nativeStarted: boolean; cancel(cause: unknown): void } | null = null;

  constructor(config: AppServerClientConfig) {
    this.hostId = config.hostId;
    this.transport = config.transport;
    const initialState = this.transport.status.state;
    this.transportRetired = initialState !== "open" && initialState !== "connecting";
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
    return this.initializationSignal?.aborted ? null : this.initialized;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  async connect(
    params: AppServerInitializeParams,
    signal?: AbortSignal,
    assertCurrent?: () => void,
  ): Promise<AppServerInitializeResponse> {
    // A reentrant caller allocates its successor only after the current
    // synchronous status publication has retired the old initialization slot.
    await Promise.resolve();
    if (this.closed) throw new AppServerClientError("CLOSED", "AppServer client is closed");
    if (signal?.aborted) throw new AppServerClientError("ABORTED", "AppServer connection was aborted");
    assertCurrent?.();
    // Reconcile the current native truth before allocating or joining a slot,
    // including after an intermediate observer missed its loss publication.
    this.handleTransportStatus(this.transport.status);
    const status = this.transport.status;
    if (this.initialization?.nativeStarted && (status.state === "closing" || status.state === "closed" || status.state === "failed")) {
      // A native attempt can be revoked before this subscriber observes its
      // connecting publication. A new caller must not join that retired work.
      this.initialization.cancel(new AppServerClientError("TRANSPORT_ERROR", "AppServer native initialization was retired"));
    }
    const initialized = this.initializeResult;
    if (this.transport.status.state === "open" && initialized !== null) return initialized;
    if (this.initialization !== null) return this.initialization.promise;
    let resolve!: (result: AppServerInitializeResponse) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<AppServerInitializeResponse>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const controller = new AbortController();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const attempt = { promise, nativeStarted: false, cancel: (cause: unknown) => {
      if (this.initialization !== attempt) return;
      // Release this LOCAL slot before lower-layer abort/status observers reenter.
      this.initialization = null;
      cleanup();
      reject(cause);
      controller.abort(cause);
    } };
    const abort = () => attempt.cancel(new AppServerClientError("ABORTED", "AppServer connection was aborted"));
    this.initialization = attempt;
    signal?.addEventListener("abort", abort, { once: true });
    const check = () => {
      if (this.closed || this.initialization !== attempt || controller.signal.aborted)
        throw controller.signal.reason ?? new AppServerClientError("CLOSED", "AppServer initialization was revoked");
      assertCurrent?.();
    };
    // Uncooperative lower-layer work may finish later; it cannot retain the local
    // operation or publish through its successor. Physical barriers stay below.
    void Promise.resolve().then(async () => {
      check();
      attempt.nativeStarted = true;
      await this.transport.connect(controller.signal);
      check();
      if (this.transport.status.state === "open") this.transportRetired = false;
      const revision = this.transportRevision;
      const result = await this.request("initialize", params, { signal: controller.signal, priority: "user-blocking" });
      if (this.closed || revision !== this.transportRevision || this.transport.status.state !== "open") {
        throw new AppServerClientError("TRANSPORT_ERROR", "AppServer initialization belongs to a lost connection");
      }
      // A resumed page must validate its owner deadline before caching readiness.
      check();
      // The owner may still revoke its handoff after this Promise resolves.
      // Ordinary callers' completed connect cancellation remains a no-op.
      this.initializationSignal = assertCurrent ? signal : undefined;
      this.initialized = result;
      this.generation += 1;
      this.initialization = null;
      cleanup();
      resolve(result);
    }).catch(cause => attempt.cancel(cause));
    return promise;
  }

  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
    options?: AppServerClientRequestOptions,
  ): Promise<AppServerMethodResult<TMethod>> {
    return this.requestRaw<AppServerMethodResult<TMethod>>(method, params, options);
  }

  requestRaw<TResult = unknown>(
    method: string,
    params: unknown,
    options: AppServerClientRequestOptions = {},
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
    const historyParams = params as { threadId?: string; initialTurnsPage?: unknown; itemsView?: string; cursor?: string | null };
    const cancellable = method === "thread/read" && historyParams?.initialTurnsPage !== undefined
      || method === "thread/turns/list" && ["full", "notLoaded"].includes(historyParams?.itemsView ?? "")
        && (historyParams?.cursor == null || /^transcript(?:-asc)?:/.test(historyParams.cursor));
    const historyCancellation = cancellable && typeof historyParams?.threadId === "string"
      && executionEngineExtension(this.initializeResult?.capabilities?.extensions, historyParams.threadId, "opencraft/read-history")?.cancellation === true
      ? { threadId: historyParams.threadId, historyReadId: `${this.connectionGeneration}:${++this.historyReadSequence}` } : undefined;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method,
      params: historyCancellation ? { ...params as object, historyReadId: historyCancellation.historyReadId } : params };
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const queuedAtMs = this.clock.now();
    const queuedElapsedAtMs = this.elapsedTime();

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
        historyCancellation,
        id,
        method,
        priority: options.priority,
        queuedAtMs,
        queuedElapsedAtMs,
        startedAtMs: queuedAtMs,
        startedElapsedAtMs: queuedElapsedAtMs,
        params,
        timeoutMs,
        resolve: (value) => resolve(value as TResult),
        reject,
        timerId: null,
        timerTicket: 0,
        removeAbortListener: () => options.signal?.removeEventListener("abort", abort),
      };
      this.pending.set(id, pending);
      if (timeoutMs > 0) this.armRequestTimeout(pending, timeoutMs,
        `AppServer request ${method} timed out after ${timeoutMs} ms`);
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
      pending.startedElapsedAtMs = this.elapsedTime();
      this.emitRequestLifecycle({
        type: "started",
        hostId: this.hostId,
        id,
        method,
        priority: options.priority,
        startedAtMs: pending.startedAtMs,
        queueWaitMs: Math.max(0, pending.startedElapsedAtMs - pending.queuedElapsedAtMs),
        params,
        historySource: options.historySource,
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
        try { options.beforeSend?.(); }
        catch (cause) {
          if (this.pending.get(id) === pending) this.rejectPending(id,
            cause instanceof Error ? cause : new Error("AppServer request admission failed", { cause }), "failed");
          return;
        }
        // Admission itself can synchronously cancel/dispose or admit a successor.
        if (this.pending.get(id) !== pending) return;
        void Promise.resolve(this.transport.send(frame, pending.controller.signal)).catch(fail);
      } catch (error) { fail(error); }
    });
  }

  subscribeNotification(listener: (notification: AppServerNotification) => void, options?: AppServerNotificationSubscriptionOptions): () => void {
    // Native subscriptions retain same-function deduplication. A later
    // registration of that function still has its own retirement identity.
    const subscription = (!options && this.nativeNotificationListeners.get(listener)) || { listener, options };
    if (!options) this.nativeNotificationListeners.set(listener, subscription);
    this.notificationListeners.add(subscription);
    return () => {
      this.notificationListeners.delete(subscription);
      if (this.nativeNotificationListeners.get(listener) === subscription) this.nativeNotificationListeners.delete(listener);
    };
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
    return this.protocolErrorListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.transport.subscribeStatus(listener);
  }

  subscribeRequestLifecycle(listener: (event: AppServerRequestLifecycleEvent) => void): () => void {
    return this.requestLifecycleListeners.subscribe(listener);
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
    const registration = { handler };
    this.serverRequestHandlers.set(method, registration);
    return () => {
      if (this.serverRequestHandlers.get(method) === registration) this.serverRequestHandlers.delete(method);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initialized = null;
    this.initialization?.cancel(new AppServerClientError("CLOSED", "AppServer client closed"));
    this.rejectAllPending(new AppServerClientError("CLOSED", "AppServer client closed"));
    this.invalidateServerRequests(new AppServerClientError("CLOSED", "AppServer client closed"));
    this.removeMessageListener();
    this.removeStatusListener();
    this.notificationListeners.clear();
    this.nativeNotificationListeners.clear();
    this.notificationInterceptors.clear();
    this.protocolErrorListeners.clear();
    this.requestLifecycleListeners.clear();
    this.serverRequestHandlers.clear();
    this.serverRequestInterceptors.clear();
    await this.transport.close();
  }

  private historyReadSequence = 0;

  private receive(frame: string): void {
    const decodeStarted = this.elapsedTime();
    let message;
    try {
      message = parseJsonRpcMessage(frame);
    } catch (error) {
      this.emitProtocolError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const decodeMs = Math.max(0, this.elapsedTime() - decodeStarted);
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
          for (const active of [...this.activeServerRequests]) {
            const requestThreadId = (active.request.params as { readonly threadId?: unknown } | null)?.threadId;
            if (active.revision !== this.transportRevision || typeof active.request.id !== typeof requestId || active.request.id !== requestId) continue;
            if (typeof threadId === "string" && typeof requestThreadId === "string" && threadId !== requestThreadId) continue;
            this.settleServerRequest(active, undefined, "resolved");
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
        durationMs: Math.max(0, this.elapsedTime() - pending.startedElapsedAtMs),
        error,
        get responseBytes() { return utf8ResponseBytes(frame); },
        decodeMs,
      });
    } else if (isJsonRpcSuccess(message)) {
      pending.resolve(message.result);
      this.emitRequestLifecycle({
        ...this.lifecycleBase(pending),
        type: "completed",
        endedAtMs,
        durationMs: Math.max(0, this.elapsedTime() - pending.startedElapsedAtMs),
        result: message.result,
        get responseBytes() { return utf8ResponseBytes(frame); },
        decodeMs,
      });
    }
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<void> {
    const controller = new AbortController();
    const responseContext = createServerRequestResponseContext(controller.signal);
    const active: ActiveServerRequest = {
      request, revision: this.transportRevision, controller,
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
      const frame = encodeJsonRpcMessage(response);
      // Serialization may execute user-defined data accessors. Recheck the
      // exact native owner after it, immediately before transport admission.
      if (!this.activeServerRequests.has(active)) return;
      if (this.closed || active.revision !== this.transportRevision || this.transport.status.state !== "open") {
        this.settleServerRequest(active, new AppServerClientError("TRANSPORT_ERROR", "AppServer request lost its connection before response admission"));
        return;
      }
      await this.transport.send(frame, active.controller.signal);
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

  private settleServerRequest(active: ActiveServerRequest, error?: Error, retirement: "answered" | "resolved" = "answered"): boolean {
    if (!this.activeServerRequests.delete(active)) return false;
    active.context.retirement = error === undefined ? retirement : "lost";
    if (error === undefined) active.context.resolve();
    else active.context.reject(error);
    active.controller.abort(error);
    return true;
  }

  private invalidateServerRequests(error: Error): void {
    for (const active of [...this.activeServerRequests]) this.settleServerRequest(active, error);
  }

  private dispatchNotification(notification: AppServerNotification): void {
    // Admission precedes every observer, including a transport-wide gate.
    // Reentrant registration cannot grow or inherit this event's finite cut.
    const subscriptions = [...this.notificationListeners];
    const generation = this.connectionGeneration, revision = this.transportRevision;
    const current = () => !this.closed && this.transport.status.state === "open"
      && this.connectionGeneration === generation && this.transportRevision === revision;
    const interceptors = [...this.notificationInterceptors];
    const dispatch = (index: number): void => {
      if (!current()) return;
      if (index >= interceptors.length) {
        for (const subscription of subscriptions) {
          const admitted = () => current() && this.notificationListeners.has(subscription);
          if (!admitted()) continue;
          let delivered = false;
          const next = () => {
            // Physical loss revokes immediately, even before a successor's
            // initialization increments connectionGeneration.
            if (!admitted()) return;
            try {
              if (delivered) throw new AppServerClientError("PROTOCOL_ERROR", `AppServer notification subscription called next twice for ${notification.method}`);
              delivered = true;
              const listener = subscription.listener;
              listener(notification);
            } catch (error) {
              this.emitProtocolError(new AppServerClientError("PROTOCOL_ERROR", `AppServer notification listener failed for ${notification.method}`, { cause: error }));
            }
          };
          try {
            if (subscription.options) subscription.options.intercept(notification, next);
            else next();
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
          if (!current()) return;
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
      if (context.signal.aborted) throw new AppServerClientError("ABORTED", "AppServer request was retired before handler admission");
      if (index >= interceptors.length) {
        const registration = this.serverRequestHandlers.get(request.method);
        if (registration === undefined) {
          throw new AppServerRpcError({ code: -32601, message: `No client handler for ${request.method}` });
        }
        const handler = registration.handler;
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
    if (status.state === "connecting" || status.state === "open") {
      this.transportRetired = false;
      return;
    }
    if (status.state !== "closing" && status.state !== "closed" && status.state !== "failed") return;
    const firstRetirement = !this.transportRetired;
    this.transportRetired = true;
    if (firstRetirement) this.transportRevision += 1;
    this.initialized = null;
    const reason = status.reason == null ? "AppServer transport closed" : `AppServer transport closed: ${status.reason}`;
    // Repeated terminal snapshots belong to the retired native activity. They
    // cannot cancel a successor that has not started native admission yet.
    if (firstRetirement) this.initialization?.cancel(new AppServerClientError("TRANSPORT_ERROR", reason));
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, new AppServerClientError(
        id === status.failure?.notDispatchedRequestId ? "NOT_DISPATCHED" : "TRANSPORT_ERROR", reason,
      ), "failed");
    }
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
      // the matching thread and never beyond a bounded elapsed deadline.
      const remaining = Math.max(0, pending.startedElapsedAtMs + Math.max(pending.timeoutMs, 180_000) - this.elapsedTime());
      const delay = started ? remaining : Math.min(remaining, pending.timeoutMs);
      this.armRequestTimeout(pending, delay,
        `AppServer request ${pending.method} timed out during context preparation`);
    }
  }

  private armRequestTimeout(pending: PendingRequest, delayMs: number, message: string): void {
    // Fence even clock adapters that may deliver retired callbacks. The request
    // object and its timer revision must both still own the timeout decision.
    const ticket = ++pending.timerTicket;
    if (pending.timerId !== null) this.clock.clearTimeout(pending.timerId);
    pending.timerId = this.clock.setTimeout(() => {
      if (this.pending.get(pending.id) !== pending || pending.timerTicket !== ticket) return;
      this.rejectPending(pending.id, new AppServerClientError("TIMEOUT", message), "timed-out");
    }, delayMs);
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
    // The opaque read identity survives router RPC-id translation. Cancellation
    // is capability-gated and scoped to this logical owner, never a Turn stop.
    if (pending.historyCancellation && (type === "aborted" || type === "timed-out") && this.transport.status.state === "open" && !this.closed)
      void this.request("thread/history/cancel", pending.historyCancellation, { timeoutMs: 5_000, priority: "user-visible" }).catch(() => {});
    pending.reject(error);
    const endedAtMs = this.clock.now();
    this.emitRequestLifecycle({
      ...this.lifecycleBase(pending),
      type,
      endedAtMs,
      durationMs: Math.max(0, this.elapsedTime() - pending.startedElapsedAtMs),
      error,
    });
  }

  private cleanupPending(id: JsonRpcId, pending: PendingRequest): void {
    this.pending.delete(id);
    ++pending.timerTicket;
    if (pending.timerId !== null) this.clock.clearTimeout(pending.timerId);
    pending.removeAbortListener();
  }

  private rejectAllPending(error: Error, type: "failed" | "aborted" = "failed"): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error, type);
  }

  private emitProtocolError(error: Error): void {
    this.protocolErrorListeners.emit(error);
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
    this.requestLifecycleListeners.emit(event);
  }
}
