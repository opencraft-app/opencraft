import type { AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { ReplayTransport } from "@opencraft/appserver-transport-replay";
import { DeferredDuplexTransport, type DuplexTransport } from "@opencraft/appserver-client/transport";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";

type SocketEventName = "open" | "message" | "error" | "close";

export class StatusSocket implements AppServerWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  terminated = false;
  autoClose = true;
  throwOnClose = false;

  private readonly listeners = new Map<SocketEventName, Set<(event: never) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.throwOnClose) throw new Error("synthetic close failure");
    this.readyState = 2;
    if (this.autoClose) this.emitClose(1000, "");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  addEventListener(type: SocketEventName, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventName, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  private emit(type: SocketEventName, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}


export const statusAdapters = ["memory", "websocket", "replay", "deferred", "apphost"] as const;
export function statusTransportFixture(kind: typeof statusAdapters[number]) {
  let transport: DuplexTransport, socket: StatusSocket | undefined, host: MessagePortAppHostClient | undefined;
  if (kind === "memory") transport = new MemoryTransport({ server: { receive() {} } });
  else if (kind === "replay") transport = new ReplayTransport([]);
  else if (kind === "deferred") transport = new DeferredDuplexTransport(async () => new MemoryTransport({ server: { receive() {} } }));
  else if (kind === "websocket") {
    transport = new WebSocketTransport({ url: "ws://fixture.invalid/rpc", closeTimeoutMs: 20, createSocket: () => { socket = new StatusSocket(); return socket; } });
  } else {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const receive = (data: unknown) => listener?.({ data } as MessageEvent<unknown>);
    host = new MessagePortAppHostClient({
      postMessage(message) {
        if ("requestId" in message) queueMicrotask(() => receive({ type: "response", requestId: message.requestId, ok: true,
          result: { hostId: "status-host", generation: 1 } }));
      },
      addEventListener(_type, next) { listener = next; }, removeEventListener() { listener = undefined; },
      start() {}, close() {},
    }, "status-owner");
    receive({ type: "ready", protocolVersion: 2, services: ["appserver"] });
    transport = host.createTransport("status-host");
  }
  return { transport, get socket() { return socket; }, initialSample: ["memory", "websocket", "replay"].includes(kind),
    async connect() {
      const promise = transport.connect(); void promise.catch(() => {});
      socket?.emitOpen(); await promise;
    },
    async close() { try { await transport.close(); } finally { host?.close(); } },
  };
}
