type JsonObject = Record<string, unknown>;

export class HermesGatewayError extends Error {
  constructor(readonly code: number | string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "HermesGatewayError";
  }
}

export interface HermesGatewayClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Persistent JSON-RPC client for Hermes' real TUI gateway (`/api/ws`). */
export class HermesGatewayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: JsonObject) => void>();

  constructor(private readonly options: HermesGatewayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketImpl = options.webSocketImpl ?? WebSocket;
  }

  onEvent(listener: (event: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async call<T>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    const socket = await this.connect();
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesGatewayError("timeout", `Hermes ${method} timed out`));
      }, this.options.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HermesGatewayError("aborted", `Hermes ${method} was aborted`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
      });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void { this.socket?.close(); this.socket = undefined; }

  private async connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.openSocket().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async openSocket(): Promise<WebSocket> {
    const token = this.options.token ?? await this.discoverLoopbackToken();
    const url = new URL("/api/ws", this.options.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new this.WebSocketImpl(url.toString());
      const timer = setTimeout(() => { socket.close(); reject(new HermesGatewayError("connect-timeout", "Hermes WebSocket connection timed out")); }, this.options.timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); this.socket = socket; resolve(socket); }, { once: true });
      socket.addEventListener("message", (event) => this.handleFrame(String(event.data)));
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        if (socket.readyState !== WebSocket.OPEN) reject(new HermesGatewayError("connect", "Hermes WebSocket connection failed"));
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = undefined;
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new HermesGatewayError("disconnected", "Hermes WebSocket disconnected"));
          this.pending.delete(id);
        }
      });
    });
  }

  private handleFrame(frame: string): void {
    let value: JsonObject;
    try { value = JSON.parse(frame) as JsonObject; } catch { return; }
    if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (pending === undefined) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      const error = typeof value.error === "object" && value.error !== null ? value.error as JsonObject : undefined;
      if (error !== undefined) pending.reject(new HermesGatewayError(typeof error.code === "number" || typeof error.code === "string" ? error.code : "rpc", typeof error.message === "string" ? error.message : "Hermes RPC failed", error.data));
      else pending.resolve(value.result);
      return;
    }
    if (value.method === "event" && typeof value.params === "object" && value.params !== null) {
      for (const listener of this.listeners) listener(value.params as JsonObject);
    }
  }

  private async discoverLoopbackToken(): Promise<string> {
    const response = await this.fetchImpl(new URL("/", this.options.baseUrl));
    if (!response.ok) throw new HermesGatewayError("auth", `Cannot discover Hermes session token (HTTP ${response.status})`);
    const html = await response.text();
    const match = /__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")/u.exec(html);
    if (match === null) throw new HermesGatewayError("auth", "Hermes did not expose a loopback session token");
    return JSON.parse(match[1]) as string;
  }
}
