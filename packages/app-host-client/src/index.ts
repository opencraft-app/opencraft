import {
  APP_HOST_PROTOCOL_VERSION,
  type AppHostConnectResult,
  type AppHostErrorPayload,
  type AppHostToRendererMessage,
  type RendererToAppHostMessage,
} from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { combineAbortSignals } from "@opencraft/appserver-client/transport";

interface AppHostPort {
  postMessage(message: RendererToAppHostMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start(): void;
  close(): void;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly clearTimer: () => void;
}

export interface AppHostClientOptions {
  readonly controlTimeoutMs?: number;
  readonly maxPendingRequests?: number;
}

function waitForControl<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("App Host ready timed out")), timeoutMs);
    const abort = () => finish(abortError("App Host connection was aborted"));
    const finish = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(value => finish(undefined, value), error => finish(error));
  });
}

type AppHostRequestInput =
  | { readonly type: "host/connect"; readonly hostId: string; readonly leaseId: string }
  | {
      readonly type: "host/send";
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
      readonly frame: string;
    }
  | {
      readonly type: "host/disconnect";
      readonly hostId: string;
      readonly leaseId: string;
      readonly generation: number;
    };

interface HostEvent {
  readonly leaseId?: string;
  readonly generation: number;
  readonly status?: TransportStatus;
  readonly frame?: string;
  readonly terminalReason?: string;
  readonly terminalFailure?: TransportStatus["failure"];
}

function appHostFailure(error: Error): TransportStatus["failure"] {
  const classified = error as Error & { code?: unknown; retryable?: unknown };
  if (typeof classified.code !== "string"
    || (!classified.code.startsWith("SSH_") && !classified.code.startsWith("APP_HOST_"))) return undefined;
  return { code: classified.code, recovery: classified.retryable === true ? "automatic" : "manual" };
}

function appHostError(payload: AppHostErrorPayload): Error {
  const error = new Error(payload.message) as Error & {
    code?: string;
    retryable?: boolean;
  };
  error.name = "AppHostError";
  error.code = payload.code;
  error.retryable = payload.retryable;
  return error;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class MessagePortAppHostClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lateResults = new Map<string, (value: unknown) => void>();
  private readonly hostListeners = new Map<string, Set<(event: HostEvent) => void>>();
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private requestSequence = 0;
  private leaseSequence = 0;
  private closed = false;
  private terminalError: Error | null = null;

  constructor(
    private readonly port: AppHostPort,
    private readonly rendererId: string,
    private readonly options: AppHostClientOptions = {},
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The bridge may die before any Host extension asks for readiness. Keep
    // the original Promise rejectable for callers without creating an
    // application-level unhandled rejection in that valid hostless case.
    void this.ready.catch(() => undefined);
    this.port.addEventListener("message", this.receive);
    this.port.start();
    this.port.postMessage({
      type: "hello",
      protocolVersion: APP_HOST_PROTOCOL_VERSION,
      rendererId,
    });
  }

  waitUntilReady(): Promise<void> {
    if (this.terminalError !== null) return Promise.reject(this.terminalError);
    return this.ready;
  }

  createTransport(hostId: string): DuplexTransport {
    if (this.closed) throw this.terminalError ?? new Error("App Host connection is closed");
    return new AppHostChannelTransport(
      this,
      hostId,
    );
  }

  createLeaseId(): string { return `${this.rendererId}:lease:${++this.leaseSequence}`; }

  async connectHost(
    hostId: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<AppHostConnectResult> {
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    await waitForControl(this.waitUntilReady(), this.options.controlTimeoutMs ?? 30_000, signal);
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    const operation = this.request<AppHostConnectResult>({ type: "host/connect", hostId, leaseId }, (value) => {
      const result = value as AppHostConnectResult;
      // Timeout ends the local wait, not process-scoped activation. A late
      // grant belongs only to the expired lease and must be released.
      void this.disconnectHost(hostId, leaseId, result.generation).catch(() => undefined);
    });
    if (signal === undefined) return operation;
    return new Promise<AppHostConnectResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError("App Host connection was aborted"));
        // A Renderer abort never owns the process-scoped startup operation.
        // Once the Host acknowledges the reserved claim, release that claim.
        void operation.then((result) =>
          this.disconnectHost(hostId, leaseId, result.generation).catch(() => undefined)
        ).catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      operation.then((result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      }, (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  sendHostFrame(hostId: string, leaseId: string, generation: number, frame: string, signal?: AbortSignal): Promise<void> {
    return this.request<void>({ type: "host/send", hostId, leaseId, generation, frame }, undefined, signal);
  }

  disconnectHost(hostId: string, leaseId: string, generation: number): Promise<void> {
    return this.request<void>({ type: "host/disconnect", hostId, leaseId, generation });
  }

  subscribeHost(hostId: string, listener: (event: HostEvent) => void): () => void {
    let listeners = this.hostListeners.get(hostId);
    if (listeners === undefined) {
      listeners = new Set();
      this.hostListeners.set(hostId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.hostListeners.delete(hostId);
    };
  }

  close(): void {
    this.terminate(new Error("App Host connection closed"));
  }

  private request<TResult>(input: AppHostRequestInput, onLateResult?: (value: unknown) => void, signal?: AbortSignal): Promise<TResult> {
    if (signal?.aborted) return Promise.reject(abortError("App Host request was aborted"));
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error("App Host connection is closed"));
    }
    if (this.pending.size + this.lateResults.size >= (this.options.maxPendingRequests ?? 256)) {
      if (this.lateResults.size > 0) {
        // Expired claims cannot be forgotten: their late grants still need an
        // owner. Retiring the bridge releases its attachments at the server
        // and lets the shared socket owner acquire a fresh request budget.
        const error = appHostError({
          code: "APP_HOST_REQUEST_LIMIT",
          message: "App Host pending request limit reached",
          retryable: true,
        });
        this.terminate(error);
        return Promise.reject(error);
      }
      return Promise.reject(new Error("App Host pending request limit reached"));
    }
    const requestId = `${this.rendererId}:${++this.requestSequence}`;
    return new Promise<TResult>((resolve, reject) => {
      // host/send acknowledges forwarding, not execution. Its AppServer RPC
      // retains its own deadline and reconciliation policy (e.g. native fork).
      const timer = input.type === "host/send" ? null : setTimeout(() => {
        this.pending.delete(requestId);
        if (onLateResult) this.lateResults.set(requestId, onLateResult);
        reject(new Error(`App Host ${input.type} timed out`));
      }, this.options.controlTimeoutMs ?? 30_000);
      const abort = () => {
        this.pending.delete(requestId);
        clearTimer();
        reject(abortError("App Host request was aborted"));
      };
      const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TResult),
        reject,
        clearTimer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.port.postMessage({ ...input, requestId } as RendererToAppHostMessage);
      } catch (cause) {
        clearTimer();
        this.pending.delete(requestId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    this.port.removeEventListener("message", this.receive);
    this.port.close();
    this.rejectReady(error);
    for (const request of this.pending.values()) { request.clearTimer(); request.reject(error); }
    this.pending.clear();
    this.lateResults.clear();
    for (const listeners of this.hostListeners.values()) {
      for (const listener of listeners) {
        listener({ generation: 0, terminalReason: error.message, terminalFailure: appHostFailure(error) });
      }
    }
    this.hostListeners.clear();
  }

  private readonly receive = (event: MessageEvent<unknown>) => {
    const message = event.data as AppHostToRendererMessage;
    if (message?.type === "fatal") {
      this.terminate(appHostError(message.error));
      return;
    }
    if (message?.type === "ready") {
      if (message.protocolVersion !== APP_HOST_PROTOCOL_VERSION) {
        this.terminate(appHostError({
          code: "APP_HOST_PROTOCOL_MISMATCH",
          message: "Client and server versions are incompatible. Update or reload the client to reconnect.",
          retryable: false,
        }));
      } else {
        this.resolveReady();
      }
      return;
    }
    if (message?.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) {
        const late = this.lateResults.get(message.requestId);
        this.lateResults.delete(message.requestId);
        if (message.ok) late?.(message.result);
        return;
      }
      pending.clearTimer();
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(appHostError(message.error));
      return;
    }
    if (message?.type !== "host/status" && message?.type !== "host/frame") return;
    const listeners = this.hostListeners.get(message.hostId);
    if (listeners === undefined) return;
    const hostEvent: HostEvent = message.type === "host/status"
      ? { generation: message.generation, status: message.status }
      : { generation: message.generation, frame: message.frame, leaseId: message.leaseId };
    for (const listener of listeners) listener(hostEvent);
  };
}

class AppHostChannelTransport implements DuplexTransport {
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly unsubscribe: () => void;
  private currentStatus: TransportStatus = { state: "idle" };
  private generation = 0;
  private connectOperation: Promise<void> | null = null;
  private connectingAttempt: {
    readonly terminal: Map<number, TransportStatus>;
    revoked?: TransportStatus;
  } | null = null;
  private closed = false;
  private leaseId = "";
  private readonly closeAbort = new AbortController();

  constructor(
    private readonly client: MessagePortAppHostClient,
    private readonly hostId: string,
  ) {
    this.unsubscribe = client.subscribeHost(hostId, (event) => this.receive(event));
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`App Host channel ${this.hostId} is closed`));
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectOperation !== null) return this.connectOperation;
    if (signal?.aborted) return Promise.reject(abortError("App Host connection was aborted"));
    const leaseId = this.client.createLeaseId();
    this.leaseId = leaseId;
    this.generation = 0;
    const attempt: NonNullable<AppHostChannelTransport["connectingAttempt"]> = { terminal: new Map() };
    this.connectingAttempt = attempt;
    const connectionSignals = combineAbortSignals([...(signal ? [signal] : []), this.closeAbort.signal]);
    const operation = Promise.resolve().then(() => this.client.connectHost(this.hostId, leaseId,
      connectionSignals.signal))
      .then((result) => {
        const revoked = attempt.revoked ?? attempt.terminal.get(result.generation);
        if (this.closed || this.connectingAttempt !== attempt || revoked !== undefined) {
          // Channel disposal does not close the shared client. A grant that
          // arrives afterwards still belongs to this retired lease only.
          void this.client.disconnectHost(this.hostId, leaseId, result.generation).catch(() => undefined);
          if (revoked !== undefined) {
            attempt.revoked = revoked;
            throw appHostError({ code: revoked.failure?.code ?? "APP_HOST_DISCONNECTED",
              message: revoked.reason ?? "Host disconnected before its connection acknowledgement",
              retryable: revoked.failure?.recovery !== "manual" });
          }
          throw new Error(`App Host channel ${this.hostId} closed during connection`);
        }
        this.generation = result.generation;
        this.setStatus({ state: "open" });
      })
      .catch((cause) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const failure = attempt.revoked?.failure ?? (cause instanceof Error ? appHostFailure(cause) : undefined);
        if (!this.closed && this.connectingAttempt === attempt) if (!this.closed) this.setStatus({ state: "failed", reason, ...(failure ? { failure } : {}) });
        throw cause;
      })
      .finally(() => {
        connectionSignals.dispose();
        if (this.connectOperation === operation) this.connectOperation = null;
        if (this.connectingAttempt === attempt) this.connectingAttempt = null;
      });
    this.connectOperation = operation;
    this.setStatus({ state: "connecting" });
    return operation;
  }

  send(frame: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.currentStatus.state !== "open") {
      return Promise.reject(new Error(`App Host channel ${this.hostId} is not open`));
    }
    return this.client.sendHostFrame(this.hostId, this.leaseId, this.generation, frame, signal);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeAbort.abort();
    this.setStatus({ state: "closing" });
    try {
      if (this.generation > 0) {
        await this.client.disconnectHost(this.hostId, this.leaseId, this.generation).catch(() => undefined);
      }
    } finally {
      this.unsubscribe();
      this.setStatus({ state: "closed" });
      this.messageListeners.clear();
      this.statusListeners.clear();
    }
  }

  private receive(event: HostEvent): void {
    if (this.closed) return;
    if (event.leaseId !== undefined && event.leaseId !== this.leaseId) return;
    if (event.terminalReason !== undefined) {
      this.generation = 0;
      const status: TransportStatus = { state: "failed", reason: event.terminalReason,
        ...(event.terminalFailure ? { failure: event.terminalFailure } : {}) };
      if (this.connectingAttempt) this.connectingAttempt.revoked = status;
      this.setStatus(status);
      return;
    }
    // Only this lease's connect acknowledgement grants a generation. Shared
    // Host events cannot adopt a peer's grant or revive a retired channel.
    if (this.generation === 0) {
      // A shared status grants no authority. Remember only revocation, and
      // apply it later only if this attempt is granted that exact generation.
      if (event.status && ["closing", "closed", "failed"].includes(event.status.state)) {
        this.connectingAttempt?.terminal.set(event.generation, event.status);
      }
      return;
    }
    if (event.generation !== this.generation) return;
    if (event.status !== undefined) this.setStatus(event.status);
    if (event.frame !== undefined && event.generation === this.generation) {
      for (const listener of this.messageListeners) listener(event.frame);
    }
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus.state === status.state && this.currentStatus.reason === status.reason
      && this.currentStatus.failure?.code === status.failure?.code
      && this.currentStatus.failure?.recovery === status.failure?.recovery) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
