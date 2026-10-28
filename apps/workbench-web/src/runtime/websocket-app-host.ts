import { serverFetch, serverUrl } from "./server-context";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { RendererToAppHostMessage } from "@opencraft/app-host-protocol";
import { captureTransportMessageScope, ClientObserverList, TransportStatusObservers } from "@opencraft/appserver-client/transport";
import type { DuplexTransport, TransportStatus, TransportFailureDiagnostic } from "@opencraft/appserver-client/transport";

type AppHostConnectionPhase = "connecting" | "socket-open" | "ready";
type AppHostFailure = "socket-error" | "socket-close" | "handshake-timeout" | "probe-timeout" | "invalid-response";

export interface AppHostRecoveryEvents {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

const browserRecoveryEvents: AppHostRecoveryEvents = {
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  subscribe(listener) {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener?.("online", listener);
    window.addEventListener?.("pageshow", listener);
    globalThis.document?.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener?.("online", listener);
      window.removeEventListener?.("pageshow", listener);
      globalThis.document?.removeEventListener("visibilitychange", listener);
    };
  },
};

interface AppHostConnectionDiagnostic {
  attemptId: string;
  failure: AppHostFailure;
  phase: AppHostConnectionPhase;
  readyState: number;
  ageMs: number;
  closeCode?: number;
}

function reportAppHostConnectionFailure(diagnostic: AppHostConnectionDiagnostic): void {
  if (typeof globalThis.fetch !== "function") return;
  try {
    void serverFetch("/__opencraft_apphost_diagnostic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(diagnostic),
      keepalive: true,
    }).catch(() => undefined);
  } catch { /* Diagnostics must never alter transport behavior. */ }
}

class WebSocketAppHostPort {
  private readonly socket: WebSocket;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly queued: string[] = [];
  private readonly handshakeTimer: ReturnType<typeof globalThis.setTimeout>;
  private readonly startedAt = Date.now();
  private phase: AppHostConnectionPhase = "connecting";
  private closed = false;
  private socketCloseAccepted = false;
  private supportsProbe = false;
  private probeSequence = 0;
  private probe: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  failureDiagnostic: TransportFailureDiagnostic | undefined;

  get isClosed(): boolean { return this.closed; }
  // close() accepting the request is distinct from a terminal notification or
  // remote execution acknowledgement. A throwing provider retains this debt.
  get closeAccepted(): boolean { return this.socketCloseAccepted; }
  get isReady(): boolean { return this.phase === "ready" && !this.closed; }

  constructor(
    url: string,
    readonly attemptId: string,
    createSocket: (url: string) => WebSocket = value => new WebSocket(value),
    handshakeTimeoutMs = 10_000,
    private readonly reportFailure = reportAppHostConnectionFailure,
    private readonly probeTimeoutMs = 5_000,
    private readonly isVisible: () => boolean = () => true,
  ) {
    this.socket = createSocket(url);
    this.handshakeTimer = globalThis.setTimeout(() => {
      this.fail("App Host handshake timed out", "handshake-timeout");
    }, handshakeTimeoutMs);
    this.socket.addEventListener("open", () => {
      if (this.closed) return;
      this.phase = "socket-open";
      for (const frame of this.queued.splice(0)) this.socket.send(frame);
    });
    this.socket.addEventListener("message", event => {
      if (this.closed) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type === "ready") {
          this.phase = "ready";
          this.supportsProbe = message.capabilities?.connectionProbe === true;
          this.clearHandshakeTimer();
        }
        if (message?.type === "response" && message.requestId === this.probe?.id && message.ok === true) {
          this.cancelProbe();
          return;
        }
        this.publish(message);
      }
      catch { this.fail("Invalid App Host response", "invalid-response"); }
    });
    this.socket.addEventListener("close", event => {
      if (!this.closed) this.fail("App Host connection closed", "socket-close", event.code);
    });
    this.socket.addEventListener("error", () => this.fail("App Host connection failed", "socket-error"));
  }

  postMessage(message: RendererToAppHostMessage): void {
    if (this.closed) throw new Error("App Host connection is closed");
    const frame = JSON.stringify(message);
    if (this.socket.readyState === 1) this.socket.send(frame);
    else if (this.socket.readyState === 0 && this.queued.length < 16) this.queued.push(frame);
    else throw new Error("App Host connection is unavailable");
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  probeReachability(): void {
    if (this.closed || !this.supportsProbe || this.phase !== "ready" || this.probe !== null || !this.isVisible()) return;
    const id = `${this.attemptId}:probe:${++this.probeSequence}`;
    const timer = globalThis.setTimeout(() => {
      if (this.closed || this.probe?.id !== id) return;
      this.probe = null;
      if (!this.isVisible()) return;
      this.fail("App Host reachability probe timed out", "probe-timeout");
    }, this.probeTimeoutMs);
    this.probe = { id, timer };
    try { this.postMessage({ type: "connection/probe", requestId: id }); }
    catch { this.fail("App Host connection failed", "socket-error"); }
  }

  cancelProbe(): void {
    if (this.probe !== null) globalThis.clearTimeout(this.probe.timer);
    this.probe = null;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.clearHandshakeTimer();
      this.cancelProbe();
      this.queued.length = 0;
      this.listeners.clear();
    }
    if (!this.socketCloseAccepted) {
      this.socket.close();
      this.socketCloseAccepted = true;
    }
  }

  private publish(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners) listener(event);
  }

  private fail(message: string, failure: AppHostFailure, closeCode?: number): void {
    if (this.closed) return;
    this.failureDiagnostic = {
      attemptId: this.attemptId, occurredAt: new Date().toISOString(),
      phase: this.phase, failure,
      ...(closeCode === undefined ? {} : { closeCode }),
    };
    try {
      this.reportFailure({
        attemptId: this.attemptId,
        failure,
        phase: this.phase,
        readyState: this.socket.readyState,
        ageMs: Math.max(0, Date.now() - this.startedAt),
        ...(closeCode === undefined ? {} : { closeCode }),
      });
    } catch { /* Diagnostics must never alter transport behavior. */ }
    this.publish({ type: "fatal", error: { code: "APP_HOST_DISCONNECTED", message, retryable: true } });
    this.close();
  }

  private clearHandshakeTimer(): void {
    globalThis.clearTimeout(this.handshakeTimer);
  }
}

// Workbench keeps one transport object for its lifetime. A closed WebSocket
// invalidates its AppHost client and lease, so reconnect must replace the
// lease *inside* that object rather than ask Workbench to create another one.
class RenewableAppHostTransport implements DuplexTransport {
  private lease: DuplexTransport | null = null;
  private removeMessageListener: (() => void) | null = null;
  private removeStatusListener: (() => void) | null = null;
  private readonly messageListeners = new ClientObserverList<string>();
  private readonly statusListeners = new TransportStatusObservers();
  private readonly recoveryListeners = new Set<() => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  private attempt: { readonly controller: AbortController; readonly promise: Promise<void>;
    cancel(reason: unknown, retirement?: TransportStatus): void } | null = null;
  // Physical lease release is serialized independently of local attempt cancellation.
  private closeBarrier: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly createLease: () => { transport: DuplexTransport; attemptId: string; diagnostic: () => TransportFailureDiagnostic | undefined; subscribeStage(listener: (stage: "bridge" | "host") => void): () => void }, private readonly onClose: () => void, private readonly beforeConnect?: () => Promise<void>) {}

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App Host transport is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Connection cancelled"));
    if (this.currentStatus.state === "open" && this.lease && !this.captureMessageScope()()) {
      const native = this.lease.status;
      const retirement: TransportStatus = { ...(native.state === "open" ? { state: "closed" as const } : native),
        attemptId: this.currentStatus.attemptId };
      if (this.attempt) this.attempt.cancel(new Error(retirement.reason ?? "App Host connection retired"), retirement);
      else this.setStatus(retirement);
    }
    if (this.attempt !== null) return this.attempt.promise;
    if (this.currentStatus.state === "open") return Promise.resolve();
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const controller = new AbortController();
    let removeStage: (() => void) | undefined;
    const cleanup = () => { signal?.removeEventListener("abort", abort); removeStage?.(); };
    const attempt = { controller, promise, cancel: (cause: unknown, retirement?: TransportStatus) => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      // Detach callbacks and install the physical barrier before abort/status reentry.
      this.retireLease();
      controller.abort(cause);
      reject(cause);
      if (!this.closed && this.currentStatus.state !== "failed")
        this.setStatus(retirement ?? { state: "failed", reason: cause instanceof Error ? cause.message : String(cause) });
    } };
    const abort = () => attempt.cancel(signal?.reason ?? new Error("Connection cancelled"));
    this.attempt = attempt;
    signal?.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => {
      if (this.closed || this.attempt !== attempt || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Connection was superseded");
    };
    // One cancellable local wait per operation. Old external work can finish later,
    // but every continuation checks its owner before allocating or publishing.
    const revoked = new Promise<never>((_, fail) => {
      controller.signal.addEventListener("abort", () => fail(controller.signal.reason), { once: true });
    });
    void revoked.catch(() => undefined);
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await Promise.race([operation, revoked]);
      assertCurrent();
      return result;
    };
    const run = async () => {
      assertCurrent();
      this.setStatus({ state: "connecting", connectionStage: "admission" });
      assertCurrent();
      await wait(Promise.resolve(this.beforeConnect?.()));
      this.setStatus({ state: "connecting", connectionStage: "release" });
      assertCurrent();
      // Cancellation cannot bypass a physical close already started by an old lease.
      this.retireLease();
      await wait(this.closeBarrier);
      const acquired = this.createLease();
      assertCurrent();
      const next = acquired.transport;
      this.lease = next;
      this.removeMessageListener = next.subscribeMessage(frame => {
        if (this.lease !== next) return;
        this.messageListeners.emit(frame, this.captureMessageScope());
      });
      this.removeStatusListener = next.subscribeStatus(status => {
        if (this.lease !== next) return;
        const diagnostic = acquired.diagnostic();
        this.setStatus({ ...status, attemptId: acquired.attemptId, ...(status.failure && diagnostic
          ? { failure: { ...status.failure, diagnostic } } : {}) });
      });
      // Install observers before I/O. Stage notifications grant no readiness.
      removeStage = acquired.subscribeStage(stage => {
        if (this.attempt === attempt) this.setStatus({ state: "connecting", connectionStage: stage, attemptId: acquired.attemptId });
      });
      assertCurrent();
      await wait(next.connect(controller.signal));
      assertCurrent();
    };
    void run().then(() => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      resolve();
    }, cause => { cleanup(); attempt.cancel(cause); });
    return promise;
  }

  private retireLease(): void {
    const previous = this.lease;
    this.lease = null;
    this.detachLease();
    if (previous) this.closeBarrier = this.closeBarrier.then(() => previous.close()).catch(() => undefined);
  }

  send(frame: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.lease === null) return Promise.reject(new Error("App Host transport is not open"));
    return this.lease.send(frame, signal);
  }

  captureMessageScope(): () => boolean {
    const lease = this.lease;
    const native = lease ? captureTransportMessageScope(lease) : () => false;
    return () => !this.closed && this.lease === lease && native();
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener);
  }

  subscribeRecoveryHint(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  notifyRecoveryHint(): void {
    for (const listener of this.recoveryListeners) listener();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.recoveryListeners.clear();
    this.attempt?.cancel(new Error("App Host transport is closed"));
    this.retireLease();
    this.setStatus({ state: "closing" });
    await this.closeBarrier;
    this.setStatus({ state: "closed" });
    this.messageListeners.clear();
    this.statusListeners.clear();
  }

  private detachLease(): void {
    this.removeMessageListener?.();
    this.removeStatusListener?.();
    this.removeMessageListener = null;
    this.removeStatusListener = null;
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}

export function connectWebSocketAppHost(
  createSocket?: (url: string) => WebSocket,
  options: {
    readonly handshakeTimeoutMs?: number;
    readonly probeTimeoutMs?: number;
    readonly recoveryEvents?: AppHostRecoveryEvents;
    readonly reportFailure?: (diagnostic: AppHostConnectionDiagnostic) => void;
    readonly path?: "/apphost" | "/ssh-apphost";
    /** Revalidate private admission through its existing owner before opening a socket. */
    readonly beforeConnect?: () => Promise<void>;
  } = {},
): { createTransport(hostId: string): DuplexTransport; close(): void } {
  let current: { port: WebSocketAppHostPort; client: MessagePortAppHostClient } | null = null;
  let disposed = false;
  let closing = false;
  let recoveryDetached = false;
  const transports = new Set<RenewableAppHostTransport>();
  const events = options.recoveryEvents ?? browserRecoveryEvents;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryTicket = 0;
  const stopRecoveryTimer = () => {
    ++recoveryTicket;
    if (recoveryTimer !== null) globalThis.clearTimeout(recoveryTimer);
    recoveryTimer = null;
  };
  const scheduleRecoveryCheck = () => {
    if (disposed || recoveryTimer !== null || transports.size === 0 || !events.isVisible()) return;
    // Mobile routes can recover without an online/visibility event. This is a
    // shared physical-route observation, never a second Host retry scheduler.
    const ticket = ++recoveryTicket;
    recoveryTimer = globalThis.setTimeout(() => {
      if (ticket !== recoveryTicket) return;
      recoveryTimer = null;
      checkRecovery();
    }, 5_000);
  };
  const checkRecovery = () => {
    if (disposed) return;
    // A backgrounded page cannot spend its foreground probe deadline.
    if (!events.isVisible()) { stopRecoveryTimer(); current?.port.cancelProbe(); return; }
    if (transports.size === 0) return;
    current?.port.probeReachability();
    // Arm before notifying consumers: synchronous disposal must cancel this
    // owner's timer, and a subscriber cannot create duplicate periodic work.
    scheduleRecoveryCheck();
    for (const transport of [...transports]) {
      if (disposed) break;
      if (transports.has(transport)) transport.notifyRecoveryHint();
    }
  };
  const unsubscribeRecovery = events.subscribe(checkRecovery);
  const retireCurrent = (): boolean => {
    const owner = current;
    if (owner === null) return true;
    owner.client.close();
    // Client.close may have joined a synchronous termination already in flight.
    // Its return alone cannot release the parent while raw close is unresolved.
    if (!owner.port.closeAccepted) return false;
    if (current === owner) current = null;
    return true;
  };
  return {
    createTransport(hostId) {
      if (disposed) throw new Error("App Host connection is closed");
      const transport = new RenewableAppHostTransport(() => {
        if (disposed) throw new Error("App Host connection is closed");
        if (current?.port.isClosed && !retireCurrent()) throw new Error("App Host Socket cleanup is in progress");
        // A raw provider callback can synchronously dispose the whole factory.
        if (disposed) throw new Error("App Host connection is closed");
        if (current === null || current.port.isClosed) {
          const url = new URL(serverUrl(options.path ?? "/apphost"), window.location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const id = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          url.searchParams.set("attempt", id);
          const port = new WebSocketAppHostPort(
            url.href,
            id,
            createSocket,
            options.handshakeTimeoutMs ?? 10_000,
            options.reportFailure ?? reportAppHostConnectionFailure,
            options.probeTimeoutMs ?? 5_000,
            () => events.isVisible(),
          );
          try { current = { port, client: new MessagePortAppHostClient(port, id) }; }
          catch (error) { port.close(); throw error; }
        }
        const leaseOwner = current;
        return { transport: leaseOwner.client.createTransport(hostId), attemptId: leaseOwner.port.attemptId,
          diagnostic: () => leaseOwner.port.failureDiagnostic,
          subscribeStage(listener) {
            const ready = (event: MessageEvent<unknown>) => {
              if ((event.data as { type?: unknown })?.type === "ready") listener("host");
            };
            leaseOwner.port.addEventListener("message", ready);
            listener(leaseOwner.port.isReady ? "host" : "bridge");
            return () => leaseOwner.port.removeEventListener("message", ready);
          },
        };
      }, () => {
        transports.delete(transport);
        if (transports.size === 0) stopRecoveryTimer();
      }, options.beforeConnect);
      transports.add(transport);
      scheduleRecoveryCheck();
      return transport;
    },
    close() {
      disposed = true;
      stopRecoveryTimer();
      if (closing) return;
      closing = true;
      try {
        // Every local channel loses write authority before external disposers.
        for (const transport of [...transports]) void transport.close().catch(() => undefined);
        const errors: unknown[] = [];
        try { retireCurrent(); } catch (cause) { errors.push(cause); }
        if (!recoveryDetached) {
          try { unsubscribeRecovery(); recoveryDetached = true; }
          catch (cause) { errors.push(cause); }
        }
        if (errors.length) throw new AggregateError(errors, "App Host connection cleanup failed");
      } finally { closing = false; }
    },
  };
}
