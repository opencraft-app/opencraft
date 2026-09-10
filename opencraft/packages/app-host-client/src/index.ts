import {
  APP_HOST_PROTOCOL_VERSION,
  type AppHostConnectResult,
  type AppHostErrorPayload,
  type AppHostToRendererMessage,
  type RendererToAppHostMessage,
} from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

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
  readonly generation: number;
  readonly status?: TransportStatus;
  readonly frame?: string;
  readonly terminalReason?: string;
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
      `${this.rendererId}:lease:${++this.leaseSequence}`,
    );
  }

  async connectHost(
    hostId: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<AppHostConnectResult> {
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    await this.ready;
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    const operation = this.request<AppHostConnectResult>({ type: "host/connect", hostId, leaseId });
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

  sendHostFrame(hostId: string, leaseId: string, generation: number, frame: string): Promise<void> {
    return this.request<void>({ type: "host/send", hostId, leaseId, generation, frame });
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

  private request<TResult>(input: AppHostRequestInput): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error("App Host connection is closed"));
    }
    const requestId = `${this.rendererId}:${++this.requestSequence}`;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TResult),
        reject,
      });
      try {
        this.port.postMessage({ ...input, requestId } as RendererToAppHostMessage);
      } catch (cause) {
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
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    for (const listeners of this.hostListeners.values()) {
      for (const listener of listeners) {
        listener({ generation: 0, terminalReason: error.message });
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
        this.terminate(new Error(`Unsupported App Host protocol ${message.protocolVersion}`));
      } else {
        this.resolveReady();
      }
      return;
    }
    if (message?.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) return;
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
      : { generation: message.generation, frame: message.frame };
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
  private closed = false;

  constructor(
    private readonly client: MessagePortAppHostClient,
    private readonly hostId: string,
    private readonly leaseId: string,
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
    this.setStatus({ state: "connecting" });
    const operation = this.client.connectHost(this.hostId, this.leaseId, signal)
      .then((result) => {
        if (this.closed) throw new Error(`App Host channel ${this.hostId} closed during connection`);
        this.generation = result.generation;
        this.setStatus({ state: "open" });
      })
      .catch((cause) => {
        const reason = cause instanceof Error ? cause.message : String(cause);
        this.setStatus({ state: "failed", reason });
        throw cause;
      })
      .finally(() => {
        if (this.connectOperation === operation) this.connectOperation = null;
      });
    this.connectOperation = operation;
    return operation;
  }

  send(frame: string): Promise<void> {
    if (this.closed || this.currentStatus.state !== "open") {
      return Promise.reject(new Error(`App Host channel ${this.hostId} is not open`));
    }
    return this.client.sendHostFrame(this.hostId, this.leaseId, this.generation, frame);
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
    if (event.terminalReason !== undefined) {
      this.generation = 0;
      this.setStatus({ state: "failed", reason: event.terminalReason });
      return;
    }
    if (event.generation < this.generation) return;
    if (event.generation > this.generation) this.generation = event.generation;
    if (event.status !== undefined) this.setStatus(event.status);
    if (event.frame !== undefined && event.generation === this.generation) {
      for (const listener of this.messageListeners) listener(event.frame);
    }
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus.state === status.state && this.currentStatus.reason === status.reason) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
