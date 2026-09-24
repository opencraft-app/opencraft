import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import type { RendererToAppHostMessage } from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

class WebSocketAppHostPort {
  private readonly socket: WebSocket;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly queued: string[] = [];
  private closed = false;

  get isClosed(): boolean { return this.closed; }

  constructor(url: string, createSocket: (url: string) => WebSocket = value => new WebSocket(value)) {
    this.socket = createSocket(url);
    this.socket.addEventListener("open", () => {
      for (const frame of this.queued.splice(0)) this.socket.send(frame);
    });
    this.socket.addEventListener("message", event => {
      try { this.publish(JSON.parse(String(event.data))); }
      catch { this.fail("Invalid App Host response"); }
    });
    this.socket.addEventListener("close", () => {
      if (!this.closed) this.fail("App Host connection closed");
    });
    this.socket.addEventListener("error", () => this.fail("App Host connection failed"));
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queued.length = 0;
    this.listeners.clear();
    this.socket.close();
  }

  private publish(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners) listener(event);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.publish({ type: "fatal", error: { code: "APP_HOST_DISCONNECTED", message, retryable: true } });
    this.close();
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
  private currentStatus: TransportStatus = { state: "idle" };
  private connectOperation: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly createLease: () => DuplexTransport) {}

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App Host transport is closed"));
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectOperation !== null) return this.connectOperation;
    const operation = (async () => {
      if (this.lease === null || this.currentStatus.state === "failed" || this.currentStatus.state === "closed") {
        const previous = this.lease;
        this.detachLease();
        this.lease = null;
        await previous?.close().catch(() => undefined);
        if (this.closed) throw new Error("App Host transport is closed");
        const next = this.createLease();
        this.lease = next;
        this.removeMessageListener = next.subscribeMessage(frame => {
          for (const listener of this.messageListeners) listener(frame);
        });
        this.removeStatusListener = next.subscribeStatus(status => this.setStatus(status));
        this.setStatus(next.status);
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

  send(frame: string): Promise<void> {
    if (this.closed || this.lease === null) return Promise.reject(new Error("App Host transport is not open"));
    return this.lease.send(frame);
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
): { createTransport(hostId: string): DuplexTransport; close(): void } {
  let current: { port: WebSocketAppHostPort; client: MessagePortAppHostClient } | null = null;
  let disposed = false;
  return {
    createTransport(hostId) {
      if (disposed) throw new Error("App Host connection is closed");
      return new RenewableAppHostTransport(() => {
        if (disposed) throw new Error("App Host connection is closed");
        if (current === null || current.port.isClosed) {
          const url = new URL("/apphost", window.location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const id = globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const port = new WebSocketAppHostPort(url.href, createSocket);
          try { current = { port, client: new MessagePortAppHostClient(port, id) }; }
          catch (error) { port.close(); throw error; }
        }
        return current.client.createTransport(hostId);
      });
    },
    close() {
      disposed = true;
      current?.client.close();
      current = null;
    },
  };
}
