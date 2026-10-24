import { serverFetch, serverUrl } from "./server-context";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { RendererToAppHostMessage } from "@opencraft/app-host-protocol";
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
  private supportsProbe = false;
  private probeSequence = 0;
  private probe: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  failureDiagnostic: TransportFailureDiagnostic | undefined;

  get isClosed(): boolean { return this.closed; }

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
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.cancelProbe();
    this.queued.length = 0;
    this.listeners.clear();
    this.socket.close();
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
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly recoveryListeners = new Set<() => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  private connectOperation: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly createLease: () => { transport: DuplexTransport; attemptId: string; diagnostic: () => TransportFailureDiagnostic | undefined }, private readonly onClose: () => void, private readonly beforeConnect?: () => Promise<void>) {}

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App Host transport is closed"));
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectOperation !== null) return this.connectOperation;
    const operation = (async () => {
      signal?.throwIfAborted();
      await this.beforeConnect?.();
      signal?.throwIfAborted();
      if (this.closed) throw new Error("App Host transport is closed");
      if (this.lease === null || this.currentStatus.state === "failed" || this.currentStatus.state === "closed") {
        const previous = this.lease;
        this.detachLease();
        this.lease = null;
        await previous?.close().catch(() => undefined);
        if (this.closed) throw new Error("App Host transport is closed");
        const acquired = this.createLease();
        const next = acquired.transport;
        this.lease = next;
        this.removeMessageListener = next.subscribeMessage(frame => {
          for (const listener of this.messageListeners) listener(frame);
        });
        this.removeStatusListener = next.subscribeStatus(status => {
          const diagnostic = acquired.diagnostic();
          this.setStatus({ ...status, attemptId: acquired.attemptId, ...(status.failure && diagnostic
            ? { failure: { ...status.failure, diagnostic } } : {}) });
        });
        this.setStatus({ ...next.status, attemptId: acquired.attemptId });
      }
      await this.lease!.connect(signal);
      if (this.closed) throw new Error("App Host transport is closed");
    })().catch(cause => {
      if (!this.closed && this.currentStatus.state !== "failed") {
        this.setStatus({ state: "failed", reason: cause instanceof Error ? cause.message : String(cause) });
      }
      throw cause;
    }).finally(() => {
      if (this.connectOperation === operation) this.connectOperation = null;
    });
    this.connectOperation = operation;
    return operation;
  }

  send(frame: string, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.lease === null) return Promise.reject(new Error("App Host transport is not open"));
    return this.lease.send(frame, signal);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
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
    this.detachLease();
    const lease = this.lease;
    this.lease = null;
    this.setStatus({ state: "closing" });
    await lease?.close().catch(() => undefined);
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
    for (const listener of this.statusListeners) listener(status);
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
  const transports = new Set<RenewableAppHostTransport>();
  const events = options.recoveryEvents ?? browserRecoveryEvents;
  const unsubscribeRecovery = events.subscribe(() => {
    if (disposed) return;
    // A backgrounded page cannot spend its foreground probe deadline.
    if (!events.isVisible()) { current?.port.cancelProbe(); return; }
    current?.port.probeReachability();
    for (const transport of transports) transport.notifyRecoveryHint();
  });
  return {
    createTransport(hostId) {
      if (disposed) throw new Error("App Host connection is closed");
      const transport = new RenewableAppHostTransport(() => {
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
        return { transport: leaseOwner.client.createTransport(hostId), attemptId: leaseOwner.port.attemptId, diagnostic: () => leaseOwner.port.failureDiagnostic };
      }, () => transports.delete(transport), options.beforeConnect);
      transports.add(transport);
      return transport;
    },
    close() {
      disposed = true;
      unsubscribeRecovery();
      current?.client.close();
      current = null;
    },
  };
}
