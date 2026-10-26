import {
  APP_HOST_PROTOCOL_VERSION,
  type AppHostConnectResult,
  type AppHostErrorPayload,
  type AppHostToRendererMessage,
  type RendererToAppHostMessage,
} from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { ClientObserverList, combineAbortSignals, TransportStatusObservers } from "@opencraft/appserver-client/transport";

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

interface HostFramePublication {
  readonly hostId: string;
  readonly generation: number;
  active: boolean;
  retirement?: TransportStatus;
}

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

/** A remote reservation outlives the local delivery lifetime and owns exactly
 * one release. Its own grant may arrive after local cancellation or timeout. */
class HostRemoteClaim {
  private generation = 0;
  private retired = false;
  private background = true;
  private releaseOperation: Promise<void> | null = null;
  constructor(private readonly release: (generation: number, background: boolean) => Promise<void>) {}

  acknowledge(generation: number): void {
    this.generation = generation;
    if (this.retired) void this.releaseOnce().catch(() => undefined);
  }

  retire(background = true): Promise<void> {
    if (!this.retired) this.background = background;
    this.retired = true;
    return this.releaseOnce();
  }

  private releaseOnce(): Promise<void> {
    if (this.generation === 0) return Promise.resolve();
    if (this.releaseOperation !== null) return this.releaseOperation;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const operation = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // Install ownership before the Port callback can synchronously reenter.
    this.releaseOperation = operation;
    try { void this.release(this.generation, this.background).then(resolve, reject); }
    catch (error) { reject(error); }
    return operation;
  }
}

/** A native, per-claim lifetime; observed status publications never grant it.
 * Pending generations are matched at receipt of this claim's own response. */
class HostDeliveryLifetime {
  generation = 0;
  retirement: TransportStatus | undefined;
  private readonly terminal = new Map<number, TransportStatus>();
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(
    readonly claim: HostRemoteClaim,
    private readonly open: (owner: HostDeliveryLifetime, signal: AbortSignal, posted?: () => void) => Promise<AppHostConnectResult>,
    private readonly remove: () => void,
  ) {}

  get active(): boolean { return !this.disposed && this.generation > 0 && this.retirement === undefined; }
  get signal(): AbortSignal { return this.abort.signal; }
  connect(signal: AbortSignal, posted?: () => void): Promise<AppHostConnectResult> { return this.open(this, signal, posted); }

  acknowledge(generation: number): void {
    this.generation = generation;
    const terminal = this.terminal.get(generation);
    this.terminal.clear();
    if (terminal !== undefined && this.retirement === undefined) this.retire(terminal);
  }

  observe(generation: number, status: TransportStatus): void {
    if (this.disposed) return;
    if (this.generation === 0) {
      if (["closing", "closed", "failed"].includes(status.state)) this.terminal.set(generation, status);
    } else if (this.generation === generation && status.state !== "open") this.retire(status);
  }

  retire(status: TransportStatus): void {
    this.retirement = status;
    this.abort.abort(); // Deletes admitted local send waits before any external observer.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retirement === undefined) this.retire({ state: "closed" });
    this.terminal.clear();
    this.remove();
  }
}

export class MessagePortAppHostClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly releases = new Map<string, PendingRequest>();
  private readonly lateResults = new Map<string, (value: unknown) => void>();
  private readonly hostListeners = new Map<string, ClientObserverList<HostEvent>>();
  private readonly hostLifetimes = new Map<string, Set<HostDeliveryLifetime>>();
  private readonly publications: (() => void)[] = [];
  private publishing = false;
  private readonly framePublications = new Set<HostFramePublication>();
  private deliveringFrame: HostFramePublication | null = null;
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
      (leaseId) => this.createLifetime(hostId, leaseId),
    );
  }

  private createLifetime(hostId: string, leaseId: string): HostDeliveryLifetime {
    let owners = this.hostLifetimes.get(hostId);
    if (owners === undefined) { owners = new Set(); this.hostLifetimes.set(hostId, owners); }
    const registry = owners;
    const lifetime = new HostDeliveryLifetime(
      this.createClaim(hostId, leaseId),
      (owner, signal, posted) => this.connectHostAttempt(hostId, leaseId, signal, owner, posted),
      () => {
        registry.delete(lifetime);
        if (registry.size === 0 && this.hostLifetimes.get(hostId) === registry) this.hostLifetimes.delete(hostId);
      },
    );
    registry.add(lifetime);
    return lifetime;
  }

  private createClaim(hostId: string, leaseId: string): HostRemoteClaim {
    return new HostRemoteClaim((generation, background) => background
      ? this.releaseObsoleteClaim(hostId, leaseId, generation)
      : this.request<void>({ type: "host/disconnect", hostId, leaseId, generation }, undefined, undefined, undefined, undefined, true));
  }

  private releaseObsoleteClaim(hostId: string, leaseId: string, generation: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    // This is an already-known reservation, not an unknown startup grant.
    // Its response need not be retained and cannot occupy current RPC budget.
    try {
      this.port.postMessage({ type: "host/disconnect", hostId, leaseId, generation,
        requestId: `${this.rendererId}:${++this.requestSequence}` });
      return Promise.resolve();
    } catch (cause) {
      // A failed Port write cannot silently orphan an owned remote claim.
      // This is a real bridge failure, never the normal reclamation mechanism.
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.terminate(error);
      return Promise.reject(error);
    }
  }

  createLeaseId(): string { return `${this.rendererId}:lease:${++this.leaseSequence}`; }

  connectHost(
    hostId: string,
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<AppHostConnectResult> {
    return this.connectHostAttempt(hostId, leaseId, signal);
  }

  private async connectHostAttempt(
    hostId: string, leaseId: string, signal?: AbortSignal, owner?: HostDeliveryLifetime, posted?: () => void,
  ): Promise<AppHostConnectResult> {
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    await waitForControl(this.waitUntilReady(), this.options.controlTimeoutMs ?? 30_000, signal);
    if (signal?.aborted) throw abortError("App Host connection was aborted");
    const claim = owner?.claim ?? this.createClaim(hostId, leaseId);
    const operation = this.request<AppHostConnectResult>({ type: "host/connect", hostId, leaseId }, (value) => {
      const result = value as AppHostConnectResult;
      // Timeout ends the local wait, not process-scoped activation. A late
      // grant belongs only to the expired lease and must be released.
      claim.acknowledge(result.generation);
      void claim.retire().catch(() => undefined);
    }, undefined, (value) => {
      const generation = (value as AppHostConnectResult).generation;
      claim.acknowledge(generation);
      owner?.acknowledge(generation);
    }, posted);
    if (signal === undefined) return operation;
    return new Promise<AppHostConnectResult>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError("App Host connection was aborted"));
        // A Renderer abort never owns the process-scoped startup operation.
        // Once the Host acknowledges the reserved claim, release that claim.
        void claim.retire().catch(() => undefined);
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
    if (this.closed) return () => undefined;
    let listeners = this.hostListeners.get(hostId);
    if (listeners === undefined) {
      listeners = new ClientObserverList<HostEvent>();
      this.hostListeners.set(hostId, listeners);
    }
    const registry = listeners, remove = registry.subscribe(listener);
    return () => {
      remove();
      if (registry.size === 0 && this.hostListeners.get(hostId) === registry) this.hostListeners.delete(hostId);
    };
  }

  /** Only used while synchronously forwarding the current native Host frame.
   * A queued terminal invalidates it before any child status observer runs. */
  captureHostMessageScope(hostId: string, generation: number): () => boolean {
    const frame = this.deliveringFrame;
    return () => !this.closed && (frame === null || (frame.active
      && frame.hostId === hostId && frame.generation === generation));
  }

  hostMessageRetirement(hostId: string, generation: number): TransportStatus | undefined {
    if (this.terminalError) return { state: "failed", reason: this.terminalError.message,
      ...(appHostFailure(this.terminalError) ? { failure: appHostFailure(this.terminalError) } : {}) };
    const frame = this.deliveringFrame;
    return frame?.hostId === hostId && frame.generation === generation ? frame.retirement : undefined;
  }

  private drainPublications(): void {
    if (this.publishing) return;
    this.publishing = true;
    try { while (this.publications.length) this.publications.shift()!(); }
    finally { this.publishing = false; }
  }

  close(): void {
    this.terminate(new Error("App Host connection closed"));
  }

  private request<TResult>(input: AppHostRequestInput, onLateResult?: (value: unknown) => void, signal?: AbortSignal,
    onResponse?: (value: unknown) => void, posted?: () => void, cleanup = false): Promise<TResult> {
    if (signal?.aborted) return Promise.reject(abortError("App Host request was aborted"));
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error("App Host connection is closed"));
    }
    if (!cleanup && this.pending.size + this.lateResults.size >= (this.options.maxPendingRequests ?? 256)) {
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
    // An already-owned claim has at most one release waiter. Reclamation can
    // neither be denied by normal RPC backpressure nor occupy its request budget.
    const requests = cleanup ? this.releases : this.pending;
    const requestId = `${this.rendererId}:${++this.requestSequence}`;
    return new Promise<TResult>((resolve, reject) => {
      // host/send acknowledges forwarding, not execution. Its AppServer RPC
      // retains its own deadline and reconciliation policy (e.g. native fork).
      const timer = input.type === "host/send" ? null : setTimeout(() => {
        requests.delete(requestId);
        if (onLateResult) this.lateResults.set(requestId, onLateResult);
        reject(new Error(`App Host ${input.type} timed out`));
      }, this.options.controlTimeoutMs ?? 30_000);
      const abort = () => {
        requests.delete(requestId);
        clearTimer();
        reject(abortError("App Host request was aborted"));
      };
      const clearTimer = () => {
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      requests.set(requestId, {
        resolve: (value) => { onResponse?.(value); resolve(value as TResult); },
        reject,
        clearTimer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.port.postMessage({ ...input, requestId } as RendererToAppHostMessage);
        posted?.();
      } catch (cause) {
        clearTimer();
        requests.delete(requestId);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        reject(error);
        if (cleanup) this.terminate(error);
      }
    });
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const frame of this.framePublications) frame.active = false;
    this.terminalError = error;
    const status: TransportStatus = { state: "failed", reason: error.message,
      ...(appHostFailure(error) ? { failure: appHostFailure(error) } : {}) };
    for (const owners of this.hostLifetimes.values()) for (const owner of owners) owner.retire(status);
    this.hostLifetimes.clear();
    this.port.removeEventListener("message", this.receive);
    this.port.close();
    this.rejectReady(error);
    for (const request of this.pending.values()) { request.clearTimer(); request.reject(error); }
    this.pending.clear();
    for (const request of this.releases.values()) { request.clearTimer(); request.reject(error); }
    this.releases.clear();
    this.lateResults.clear();
    // Admit every Host cut before any observer can modify a later registry.
    const terminal: HostEvent = { generation: 0, terminalReason: error.message, terminalFailure: appHostFailure(error) };
    for (const listeners of this.hostListeners.values()) this.publications.push(listeners.capture(terminal));
    this.publications.push(() => {
      for (const listeners of this.hostListeners.values()) listeners.clear();
      this.hostListeners.clear();
    });
    this.drainPublications();
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
      const requests = this.pending.has(message.requestId) ? this.pending : this.releases;
      const pending = requests.get(message.requestId);
      if (pending === undefined) {
        const late = this.lateResults.get(message.requestId);
        this.lateResults.delete(message.requestId);
        if (message.ok) late?.(message.result);
        return;
      }
      pending.clearTimer();
      requests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(appHostError(message.error));
      return;
    }
    if (message?.type !== "host/status" && message?.type !== "host/frame") return;
    if (this.closed) return;
    const terminal = message.type === "host/status"
      && ["closing", "closed", "failed"].includes(message.status.state);
    const retiresData = message.type === "host/status" && message.status.state !== "open";
    if (message.type === "host/status") {
      for (const owner of this.hostLifetimes.get(message.hostId) ?? []) owner.observe(message.generation, message.status);
    }
    if (retiresData) for (const frame of this.framePublications) {
      if (frame.hostId === message.hostId && frame.generation === message.generation) {
        frame.active = false;
        if (message.type === "host/status") frame.retirement = message.status;
      }
    }
    const listeners = this.hostListeners.get(message.hostId);
    if (listeners === undefined) return;
    const hostEvent: HostEvent = message.type === "host/status"
      ? { generation: message.generation, status: message.status }
      : { generation: message.generation, frame: message.frame, leaseId: message.leaseId };
    if (message.type === "host/frame") {
      const frame: HostFramePublication = { hostId: message.hostId, generation: message.generation, active: true };
      this.framePublications.add(frame);
      const publish = listeners.capture(hostEvent, () => !this.closed && frame.active);
      this.publications.push(() => {
        const previous = this.deliveringFrame;
        this.deliveringFrame = frame;
        try { publish(); }
        finally {
          frame.active = false;
          this.framePublications.delete(frame);
          this.deliveringFrame = previous;
        }
      });
    } else this.publications.push(listeners.capture(hostEvent, () => terminal || !this.closed));
    this.drainPublications();
  };
}

class AppHostChannelTransport implements DuplexTransport {
  private readonly messageListeners = new ClientObserverList<string>();
  private readonly statusListeners = new TransportStatusObservers();
  private readonly unsubscribe: () => void;
  private currentStatus: TransportStatus = { state: "idle" };
  private generation = 0;
  private lifetime: HostDeliveryLifetime | null = null;
  private connectOperation: Promise<void> | null = null;
  private closed = false;
  private leaseId = "";
  private readonly closeAbort = new AbortController();

  constructor(
    private readonly client: MessagePortAppHostClient,
    private readonly hostId: string,
    private readonly createLifetime: (leaseId: string) => HostDeliveryLifetime,
  ) {
    this.unsubscribe = client.subscribeHost(hostId, (event) => this.receive(event));
  }

  get status(): TransportStatus {
    return !this.closed ? this.lifetime?.retirement ?? this.currentStatus : this.currentStatus;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`App Host channel ${this.hostId} is closed`));
    if (this.currentStatus.state === "open" && !this.lifetime?.active) {
      const terminal = this.status;
      this.connectOperation = null;
      this.setStatus(terminal);
    }
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectOperation !== null) return this.connectOperation;
    if (signal?.aborted) return Promise.reject(abortError("App Host connection was aborted"));
    const leaseId = this.client.createLeaseId();
    const previous = this.lifetime;
    this.leaseId = leaseId;
    this.generation = 0;
    this.lifetime?.dispose();
    const owner = this.createLifetime(leaseId);
    this.lifetime = owner;
    const connectionSignals = combineAbortSignals([...(signal ? [signal] : []), this.closeAbort.signal]);
    const releasePrevious = () => { void previous?.claim.retire().catch(() => undefined); };
    const operation = Promise.resolve().then(() => owner.connect(connectionSignals.signal, releasePrevious))
      .then((result) => {
        const revoked = owner.retirement;
        if (this.closed || this.lifetime !== owner || !owner.active) {
          // Channel disposal does not close the shared client. A grant that
          // arrives afterwards still belongs to this retired lease only.
          void owner.claim.retire().catch(() => undefined);
          if (revoked !== undefined) {
            throw appHostError({ code: revoked.failure?.code ?? "APP_HOST_DISCONNECTED",
              message: revoked.reason ?? "Host disconnected before its connection acknowledgement",
              retryable: revoked.failure?.recovery !== "manual" });
          }
          throw new Error(`App Host channel ${this.hostId} closed during connection`);
        }
        this.generation = result.generation;
        this.setStatus({ state: "open" });
        if (this.closed || this.lifetime !== owner || !owner.active) {
          const retirement = owner.retirement;
          if (retirement) throw appHostError({ code: retirement.failure?.code ?? "APP_HOST_DISCONNECTED",
            message: retirement.reason ?? "Host disconnected during its open publication",
            retryable: retirement.failure?.recovery !== "manual" });
          throw new Error(`App Host channel ${this.hostId} retired during connection`);
        }
      })
      .catch((cause) => {
        releasePrevious();
        void owner.claim.retire().catch(() => undefined);
        const reason = cause instanceof Error ? cause.message : String(cause);
        const failure = owner.retirement?.failure ?? (cause instanceof Error ? appHostFailure(cause) : undefined);
        if (!this.closed && this.lifetime === owner) {
          const failed: TransportStatus = { state: "failed", reason, ...(failure ? { failure } : {}) };
          owner.retire(failed);
          this.setStatus(failed);
        }
        owner.dispose();
        throw cause;
      })
      .finally(() => {
        connectionSignals.dispose();
        if (this.connectOperation === operation) this.connectOperation = null;
      });
    this.connectOperation = operation;
    this.setStatus({ state: "connecting" });
    return operation;
  }

  send(frame: string, signal?: AbortSignal): Promise<void> {
    const owner = this.lifetime;
    if (this.closed || !owner?.active || this.currentStatus.state !== "open") {
      return Promise.reject(new Error(`App Host channel ${this.hostId} is not open`));
    }
    const signals = combineAbortSignals([owner.signal, ...(signal ? [signal] : [])]);
    return this.client.sendHostFrame(this.hostId, this.leaseId, owner.generation, frame, signals.signal)
      .finally(() => signals.dispose());
  }

  captureMessageScope(): () => boolean {
    const owner = this.lifetime;
    const native = this.client.captureHostMessageScope(this.hostId, this.generation);
    return () => !this.closed && owner !== null && this.lifetime === owner && owner.active && native();
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime?.dispose();
    this.closeAbort.abort();
    this.setStatus({ state: "closing" });
    try {
      await this.lifetime?.claim.retire(false).catch(() => undefined);
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
      this.setStatus(status);
      return;
    }
    // Only this lease's connect acknowledgement grants a generation. Shared
    // Host events cannot adopt a peer's grant or revive a retired channel.
    if (this.generation === 0) return;
    if (event.generation !== this.generation) return;
    if (event.status !== undefined) {
      // A shared open publication cannot grant a retired lease again.
      // Conversely a terminal queued before a new own ACK cannot retire it.
      if (event.status.state === "open" ? this.lifetime?.active : this.lifetime?.retirement) this.setStatus(event.status);
    }
    if (event.frame !== undefined && event.generation === this.generation) {
      this.messageListeners.emit(event.frame, this.captureMessageScope());
    }
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus.state === status.state && this.currentStatus.reason === status.reason
      && this.currentStatus.failure?.code === status.failure?.code
      && this.currentStatus.failure?.recovery === status.failure?.recovery) return;
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}
