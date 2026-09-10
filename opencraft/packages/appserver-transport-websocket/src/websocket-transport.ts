import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { decodeUtf8 } from "@opencraft/appserver-client/utf8";

interface WebSocketEventMap {
  open: Event;
  message: { data: unknown };
  error: Event;
  close: { code: number; reason: string };
}

/**
 * The browser WebSocket surface used by the transport. `terminate` is an
 * optional Node-only escape hatch for runtimes whose peer never completes the
 * close handshake; browser callers do not need to provide it.
 */
export interface AppServerWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  addEventListener<TKey extends keyof WebSocketEventMap>(
    type: TKey,
    listener: (event: WebSocketEventMap[TKey]) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener<TKey extends keyof WebSocketEventMap>(
    type: TKey,
    listener: (event: WebSocketEventMap[TKey]) => void,
  ): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
) => AppServerWebSocket;

export interface WebSocketTransportOptions {
  url: string;
  protocols?: string | string[];
  createSocket?: WebSocketFactory;
  /** Maximum time to wait for a peer's close frame before disposing locally. */
  closeTimeoutMs?: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function messageDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return decodeUtf8(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return decodeUtf8(new Uint8Array(await data.arrayBuffer()));
  }
  throw new TypeError("AppServer WebSocket received a non-text frame");
}

export class WebSocketTransport implements DuplexTransport {
  private readonly options: WebSocketTransportOptions;
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private socket: AppServerWebSocket | null = null;
  private currentStatus: TransportStatus = { state: "idle" };
  private connectPromise: Promise<void> | null = null;
  private inboundQueue = Promise.resolve();
  private socketGeneration = 0;

  constructor(options: WebSocketTransportOptions | string) {
    this.options = typeof options === "string" ? { url: options } : options;
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectPromise !== null) return this.connectPromise;
    if (signal?.aborted) return Promise.reject(abortError("WebSocket connection was aborted"));

    this.setStatus({ state: "connecting" });
    const factory = this.options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    let socket: AppServerWebSocket;
    try {
      socket = factory(this.options.url, this.options.protocols);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.setStatus({ state: "failed", reason });
      return Promise.reject(error);
    }
    const generation = ++this.socketGeneration;
    this.socket = socket;
    this.inboundQueue = Promise.resolve();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const isCurrentSocket = () => this.socket === socket && this.socketGeneration === generation;
      const cleanupConnectListeners = () => {
        socket.removeEventListener("open", handleOpen);
        signal?.removeEventListener("abort", handleAbort);
      };
      const failConnect = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupConnectListeners();
        this.connectPromise = null;
        reject(error);
      };
      const handleOpen = () => {
        if (settled || !isCurrentSocket()) return;
        settled = true;
        cleanupConnectListeners();
        this.connectPromise = null;
        this.setStatus({ state: "open" });
        resolve();
      };
      const handleAbort = () => {
        failConnect(abortError("WebSocket connection was aborted"));
        try {
          socket.close(1000, "aborted");
        } catch {
          socket.terminate?.();
        }
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("message", (event) => {
        if (!isCurrentSocket()) return;
        this.inboundQueue = this.inboundQueue
          .then(() => messageDataToText(event.data))
          .then((frame) => {
            if (!isCurrentSocket() || this.currentStatus.state !== "open") return;
            for (const listener of this.messageListeners) listener(frame);
          })
          .catch((error: unknown) => {
            this.setStatus({
              state: "failed",
              reason: error instanceof Error ? error.message : String(error),
            });
          });
      });
      socket.addEventListener("error", () => {
        if (!isCurrentSocket()) return;
        const error = new Error(`WebSocket connection failed: ${this.options.url}`);
        this.setStatus({ state: "failed", reason: error.message });
        failConnect(error);
      });
      socket.addEventListener("close", (event) => {
        if (!isCurrentSocket()) return;
        this.socket = null;
        this.connectPromise = null;
        const reason = event.code === 1000
          ? undefined
          : event.reason || `WebSocket closed with code ${event.code}`;
        this.setStatus(reason === undefined ? { state: "closed" } : { state: "closed", reason });
        if (!settled) failConnect(new Error(reason ?? "WebSocket closed before opening"));
      });
      signal?.addEventListener("abort", handleAbort, { once: true });
    });

    return this.connectPromise;
  }

  async send(frame: string): Promise<void> {
    if (this.socket === null || this.currentStatus.state !== "open" || this.socket.readyState !== 1) {
      throw new Error("WebSocket transport is not open");
    }
    this.socket.send(frame);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === null) {
      if (this.currentStatus.state !== "closed") this.setStatus({ state: "closed" });
      return;
    }
    if (socket.readyState === 3) {
      this.socket = null;
      this.setStatus({ state: "closed" });
      return;
    }

    this.setStatus({ state: "closing" });
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeoutId);
        socket.removeEventListener("close", handleClose);
        if (this.socket === socket) this.socket = null;
        if (this.currentStatus.state !== "closed") this.setStatus({ state: "closed" });
        resolve();
      };
      const handleClose = () => finish();
      const timeoutId = globalThis.setTimeout(() => {
        // HyperNode's virtual socket can currently omit the peer close frame.
        // `ws` exposes terminate(); browsers still get a bounded dispose
        // promise and release the native socket with the page lifecycle.
        socket.terminate?.();
        finish();
      }, this.options.closeTimeoutMs ?? 1_000);
      socket.addEventListener("close", handleClose, { once: true });
      try {
        socket.close(1000, "client closing");
      } catch {
        socket.terminate?.();
        finish();
      }
    });
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
