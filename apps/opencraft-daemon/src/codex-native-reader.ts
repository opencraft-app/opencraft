import WebSocket from "ws";
import { CodexCoreControlClient, openCodexNativeSocket } from "@opencraft/account-pool-host";
import { createCodexRuntimeHealthReader, type CodexRuntimeEndpoints } from "./codex-native-core-transport.js";

type Value = Record<string, unknown>;

/**
 * A Host-services connection to the native Codex AppServer for
 * Thread-independent reads and metadata (models, permission profiles, pins).
 * It subscribes to no Thread and runs nothing; it answers only native
 * credential refresh with Core's broker credentials. Connects on first use and
 * again after a loss.
 */
export class CodexNativeReader {
  private socket?: WebSocket;
  private opening?: Promise<WebSocket>;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private readonly control: CodexCoreControlClient;
  private readonly readHealth: ReturnType<typeof createCodexRuntimeHealthReader>;
  private initialized?: unknown;
  private readonly notificationListeners = new Set<(method: string, params: Value) => void>();

  constructor(
    endpoint: string,
    token: string,
    private readonly timeoutMs = 30_000,
    runtime?: CodexRuntimeEndpoints,
  ) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.readHealth = createCodexRuntimeHealthReader(this.control, runtime);
  }

  private open(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("Codex native reader is closed"));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    return (this.opening ??= (async () => {
      const [health, initialAuth] = await Promise.all([this.readHealth(undefined, "native"), this.control.brokerAuth()]);
      let cachedAuth = initialAuth;
      let initialAuthFresh = true;
      const socket = openCodexNativeSocket(health.nativeSocket, {
        maxPayload: 16 * 1024 ** 2,
        handshakeTimeout: 5000,
      });
      socket.on("message", (data) => {
        let frame: Value;
        try {
          frame = JSON.parse(String(data));
        } catch {
          socket.terminate();
          return;
        }
        if (
          frame.method === "account/chatgptAuthTokens/refresh" &&
          (typeof frame.id === "string" || typeof frame.id === "number")
        ) {
          const requestId = frame.id;
          const resolveAuth = initialAuthFresh
            ? ((initialAuthFresh = false), Promise.resolve(cachedAuth))
            : this.control.brokerAuth().then(
                (fresh) => (cachedAuth = fresh),
                () => cachedAuth,
              );
          void resolveAuth.then((result) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ id: requestId, result }));
              }
            });
          return;
        }
        if (typeof frame.method === "string" && frame.id === undefined) {
          for (const listener of this.notificationListeners) listener(frame.method, (frame.params ?? {}) as Value);
          return;
        }
        if (typeof frame.id !== "number") return; // other server requests are not ours
        const request = this.pending.get(frame.id);
        if (!request) return;
        this.pending.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.error)
          request.reject(
            Object.assign(
              new Error(String((frame.error as Value).message ?? "Native request failed")),
              frame.error as Value,
            ),
          );
        else request.resolve(frame.result);
      });
      const lost = () => {
        if (this.socket === socket) this.socket = undefined;
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer);
          request.reject(new Error("Codex native connection closed"));
          this.pending.delete(id);
        }
      };
      socket.on("close", lost);
      socket.on("error", lost);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      this.socket = socket;
      this.initialized = await this.send(socket, "initialize", {
        clientInfo: { name: "opencraft-host-services", version: "1" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized", params: {} }));
      return socket;
    })().finally(() => {
      this.opening = undefined;
    }));
  }

  private send(socket: WebSocket, method: string, params: Value): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex native request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Native Codex's initialize result on this connection (connects first if needed). */
  async initializeResult(): Promise<unknown> {
    await this.open();
    return this.initialized;
  }

  /** Notifications native Codex sends this connection (not subscribed to any Thread). */
  subscribeNotification(listener: (method: string, params: Value) => void): () => void {
    this.notificationListeners.add(listener);
    return () => void this.notificationListeners.delete(listener);
  }

  async request(method: string, params: Value): Promise<unknown> {
    return this.send(await this.open(), method, params);
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex native reader is closed"));
    }
    this.pending.clear();
  }
}
