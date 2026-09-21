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

export type ServerRequestHandler = (
  params: unknown,
  request: AppServerServerRequest,
) => unknown | Promise<unknown>;

export type TypedServerRequestHandler<TMethod extends AppServerServerMethod> = (
  params: AppServerServerRequestParams<TMethod>,
  request: TypedAppServerServerRequest<TMethod>,
) => AppServerServerRequestResult<TMethod> | Promise<AppServerServerRequestResult<TMethod>>;

export type AppServerNotificationInterceptor = (
  notification: AppServerNotification,
  next: () => void,
) => void;

export type AppServerServerRequestInterceptor = (
  request: AppServerServerRequest,
  next: () => Promise<unknown>,
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
  resolve(value: unknown): void;
  reject(error: Error): void;
  timerId: ReturnType<typeof globalThis.setTimeout> | null;
  removeAbortListener(): void;
}

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
    })
  | (RequestLifecycleBase & {
      type: "failed" | "timed-out" | "aborted";
      endedAtMs: number;
      durationMs: number;
      error: Error;
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
  private readonly resolvedServerRequestIds = new Set<string>();
  private readonly removeMessageListener: () => void;
  private readonly removeStatusListener: () => void;
  private requestSequence = 0;
  private generation = 0;
  private closed = false;
  private initialized: AppServerInitializeResponse | null = null;
  private initializePromise: Promise<AppServerInitializeResponse> | null = null;

  constructor(config: AppServerClientConfig) {
    this.hostId = config.hostId;
    this.transport = config.transport;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.clock = config.clock ?? systemClock;
    this.createRequestId = config.createRequestId ?? (() => `${this.hostId}:${++this.requestSequence}`);
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
    this.initializePromise = (async () => {
      await this.transport.connect(signal);
      const result = await this.request("initialize", params, { signal, priority: "user-blocking" });
      this.initialized = result;
      this.generation += 1;
      return result;
    })();
    try {
      return await this.initializePromise;
    } finally {
      this.initializePromise = null;
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

      void this.transport.send(encodeJsonRpcMessage(request), pending.controller.signal).catch((error: unknown) => {
        this.rejectPending(
          id,
          new AppServerClientError("TRANSPORT_ERROR", `Failed to send AppServer request ${method}`, {
            cause: error,
          }),
          "failed",
        );
      });
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
    this.removeMessageListener();
    this.removeStatusListener();
    this.notificationListeners.clear();
    this.notificationInterceptors.clear();
    this.protocolErrorListeners.clear();
    this.requestLifecycleListeners.clear();
    this.serverRequestHandlers.clear();
    this.serverRequestInterceptors.clear();
    this.resolvedServerRequestIds.clear();
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
      if (notification.method === "serverRequest/resolved") {
        const requestId = (notification.params as { readonly requestId?: unknown }).requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.resolvedServerRequestIds.add(this.serverRequestKey(requestId));
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
      });
    } else if (isJsonRpcSuccess(message)) {
      pending.resolve(message.result);
      this.emitRequestLifecycle({
        ...this.lifecycleBase(pending),
        type: "completed",
        endedAtMs,
        durationMs: endedAtMs - pending.startedAtMs,
        result: message.result,
      });
    }
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<void> {
    const requestKey = this.serverRequestKey(request.id);
    try {
      const serverRequest: AppServerServerRequest = {
        id: request.id,
        method: request.method,
        params: request.params,
      };
      const result = await this.dispatchServerRequest(serverRequest);
      if (this.resolvedServerRequestIds.delete(requestKey)) return;
      await this.transport.send(encodeJsonRpcMessage({ id: request.id, result }));
    } catch (error) {
      if (this.resolvedServerRequestIds.delete(requestKey)) return;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AppServerRpcError ? error.code : -32000;
      try {
        await this.transport.send(encodeJsonRpcMessage({
          id: request.id,
          error: { code, message },
        }));
      } catch (sendError) {
        this.emitProtocolError(new AppServerClientError(
          "TRANSPORT_ERROR",
          `Failed to answer AppServer request ${request.method}`,
          { cause: sendError },
        ));
      }
    }
  }

  private serverRequestKey(id: JsonRpcId): string {
    return JSON.stringify([typeof id, id]);
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

  private dispatchServerRequest(request: AppServerServerRequest): Promise<unknown> {
    const interceptors = [...this.serverRequestInterceptors];
    const dispatch = async (index: number): Promise<unknown> => {
      if (index >= interceptors.length) {
        const handler = this.serverRequestHandlers.get(request.method);
        if (handler === undefined) {
          throw new AppServerRpcError({ code: -32601, message: `No client handler for ${request.method}` });
        }
        return handler(request.params, request);
      }
      let called = false;
      return interceptors[index]?.(request, () => {
        if (called) return Promise.reject(new AppServerClientError(
          "PROTOCOL_ERROR",
          `AppServer request interceptor called next twice for ${request.method}`,
        ));
        called = true;
        return dispatch(index + 1);
      });
    };
    return dispatch(0);
  }

  private handleTransportStatus(status: TransportStatus): void {
    if (status.state !== "closed" && status.state !== "failed") return;
    this.initialized = null;
    const reason = status.reason == null ? "AppServer transport closed" : `AppServer transport closed: ${status.reason}`;
    this.rejectAllPending(new AppServerClientError("TRANSPORT_ERROR", reason), "failed");
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
