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
  private cancelConnect: ((error: Error) => void) | null = null;
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

    // Publish ownership before any observer or factory can cancel/reenter.
    const generation = ++this.socketGeneration;
    let socket: AppServerWebSocket | null = null;
    let settled = false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const connectionPromise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    const isCurrentSocket = () => socket !== null && this.socket === socket && this.socketGeneration === generation;
    const cleanupConnectListeners = () => {
      socket?.removeEventListener("open", handleOpen);
      signal?.removeEventListener("abort", handleAbort);
      if (this.cancelConnect === failConnect) this.cancelConnect = null;
    };
    const failConnect = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupConnectListeners();
      if (this.connectPromise === connectionPromise) this.connectPromise = null;
      reject(error);
    };
    const handleOpen = () => {
      if (settled || !isCurrentSocket()) return;
      settled = true;
      cleanupConnectListeners();
      if (this.connectPromise === connectionPromise) this.connectPromise = null;
      this.setStatus({ state: "open" });
      resolve();
    };
    const handleAbort = () => {
      if (settled) return;
      failConnect(abortError("WebSocket connection was aborted"));
      // Native close can omit its event. Revocation is local and immediate.
      if (this.socketGeneration === generation) this.setStatus({ state: "closed" });
      try { socket?.close(1000, "aborted"); } catch { socket?.terminate?.(); }
    };
    this.connectPromise = connectionPromise;
    this.cancelConnect = failConnect;
    signal?.addEventListener("abort", handleAbort, { once: true });
    this.setStatus({ state: "connecting" });
    if (settled || this.socketGeneration !== generation) return connectionPromise;
    if (signal?.aborted) { handleAbort(); return connectionPromise; }

    const factory = this.options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    try {
      socket = factory(this.options.url, this.options.protocols);
    } catch (error) {
      failConnect(error instanceof Error ? error : new Error(String(error)));
      if (this.socketGeneration === generation) this.setStatus({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
      return connectionPromise;
    }
    if (settled || this.socketGeneration !== generation) {
      try { socket.close(1000, "cancelled attempt"); } catch { socket.terminate?.(); }
      return connectionPromise;
    }
    this.socket = socket;
    this.inboundQueue = Promise.resolve();
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
          if (!isCurrentSocket() || this.currentStatus.state !== "open") return;
          this.setStatus({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
        });
    });
    socket.addEventListener("error", () => {
      if (!isCurrentSocket()) return;
      const error = new Error(`WebSocket connection failed: ${this.options.url}`);
      failConnect(error);
      if (isCurrentSocket()) this.setStatus({ state: "failed", reason: error.message });
    });
    socket.addEventListener("close", (event) => {
      if (!isCurrentSocket()) return;
      this.socket = null;
      const reason = event.code === 1000 ? undefined : event.reason || `WebSocket closed with code ${event.code}`;
      // Settle the old attempt before status observers can start its successor.
      failConnect(new Error(reason ?? "WebSocket closed before opening"));
      this.setStatus(reason === undefined ? { state: "closed" } : { state: "closed", reason });
    });
    return connectionPromise;
  }

  async send(frame: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError("WebSocket send was aborted");
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
    // The platform may omit its close event, including after terminate().
    // Settle the original connect caller before bounded socket disposal.
    this.cancelConnect?.(new Error("WebSocket closed before opening"));
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
        if (this.socket === socket) {
          this.socket = null;
          if (this.currentStatus.state !== "closed") this.setStatus({ state: "closed" });
        }
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
