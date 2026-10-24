import WebSocket from "ws";

const HISTORY_READS = new Set(["thread/read", "thread/turns/list", "thread/items/list"]);
export function isIsolatedCoreRead(message: { method?: unknown; id?: unknown }): boolean {
  return message.id !== undefined && typeof message.method === "string" && HISTORY_READS.has(message.method);
}

/** Stateless history reads have their own bounded socket, never the subscription socket.
 * A malformed/oversized reply retires only this RPC. No request or execution is replayed. */
export class CodexCoreReadIsolation {
  private closed = false;
  private readonly sockets = new Set<WebSocket>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly health: () => Promise<{ nativeSocket: string }>,
    private readonly limits = { maxPayload: 100 * 1024 * 1024, concurrency: 4, queue: 64, timeoutMs: 30_000 }) {}

  async read(message: { id: unknown; method: string; params?: unknown }): Promise<string> {
    const failure = (oversized = false) => JSON.stringify({ id: message.id, error: {
      code: oversized ? -32072 : -32073,
      message: oversized ? "History response is too large; use a smaller history page" : "History read connection is unavailable",
      data: { code: oversized ? "HISTORY_RESPONSE_TOO_LARGE" : "HISTORY_READ_UNAVAILABLE", retryable: !oversized },
    } });
    if (this.closed || this.waiters.length >= this.limits.queue) return failure();
    if (this.active >= this.limits.concurrency) await new Promise<void>(resolve => this.waiters.push(resolve));
    else this.active += 1;
    let socket: WebSocket | undefined;
    try {
      if (this.closed) return failure();
      const endpoint = await this.health();
      if (this.closed) return failure();
      socket = new WebSocket(`ws+unix://${endpoint.nativeSocket}:/`, { handshakeTimeout: 5_000, maxPayload: this.limits.maxPayload });
      this.sockets.add(socket);
      const ws = socket;
      return await new Promise<string>(resolve => {
        let settled = false, initialized = false;
        const timer = setTimeout(() => finish(failure()), this.limits.timeoutMs);
        const finish = (reply: string) => {
          if (settled) return; settled = true; clearTimeout(timer); resolve(reply); ws.terminate();
        };
        ws.on("error", error => finish(failure((error as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH")));
        ws.on("close", () => finish(failure()));
        ws.on("open", () => ws.send(JSON.stringify({ id: "opencraft-history-init", method: "initialize", params: {
          clientInfo: { name: "opencraft-history-reader", version: "0.1.0" }, capabilities: { experimentalApi: true },
        } })));
        ws.on("message", raw => {
          if (settled) return;
          try {
            const value = JSON.parse(String(raw));
            if (!initialized) {
              if (value.id !== "opencraft-history-init") return;
              if (value.error) { finish(failure()); return; }
              initialized = true; ws.send(JSON.stringify({ method: "initialized" })); ws.send(JSON.stringify(message));
            } else if (value.id === message.id && !value.method) finish(String(raw));
          } catch { finish(failure()); }
        });
      });
    } catch { return failure(); }
    finally {
      if (socket) { this.sockets.delete(socket); socket.terminate(); }
      const next = this.waiters.shift();
      if (next) next(); else this.active -= 1;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.terminate();
    for (const wake of this.waiters.splice(0)) wake();
  }
}
