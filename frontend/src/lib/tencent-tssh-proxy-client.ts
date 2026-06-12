import { Binary, serialize } from "bson";
import type { BotTerminalSession } from "@/domain/types";
import { decodeTencentPtyFrame, extractTencentPtyError } from "@/lib/tencent-pty-client";

const DEFAULT_PROXY_CONNECT_DELAY_MS = 200;
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 30_000;

export type TsshProxyClientState = "idle" | "connecting" | "authenticating" | "ready" | "closed" | "error";
export type TsshProxyConnectionState = "connecting" | "ready" | "closed" | "error";

export interface TsshProxyClientOptions {
  connectDelayMs?: number;
  requestTimeoutMs?: number;
  WebSocketImpl?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  onStateChange?: (state: TsshProxyClientState) => void;
  onError?: (message: string) => void;
  onClose?: (event: CloseEvent) => void;
}

export interface TsshProxyTarget {
  ip?: string;
  port: number | string;
  proxyId?: string;
  channelId?: string;
}

export interface TsshProxyConnectionHandlers {
  onStateChange?: (state: TsshProxyConnectionState) => void;
  onData?: (data: Uint8Array) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

type PendingProxy = {
  proxyId: string;
  resolve: (connection: TencentTsshProxyConnection) => void;
  reject: (error: Error) => void;
  timer: number;
  connection: TencentTsshProxyConnection;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const normalizeBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value instanceof Binary) {
    return value.buffer;
  }
  if (isRecord(value) && value.buffer instanceof Uint8Array) {
    return value.buffer;
  }
  return new Uint8Array();
};

const getFrameType = (message: unknown) => (isRecord(message) && typeof message.Type === "string" ? message.Type : "");

const getEnvelope = (message: unknown) => (isRecord(message) && isRecord(message.Data) ? message.Data : null);

const getPayload = (message: unknown) => {
  const envelope = getEnvelope(message);
  return envelope && isRecord(envelope.Data) ? envelope.Data : null;
};

const makeProxyId = () => `proxy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export class TencentTsshProxyConnection {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private state: TsshProxyConnectionState = "connecting";
  private closedPromise: Promise<void>;
  private resolveClosed: (() => void) | null = null;
  private rejectClosed: ((error: Error) => void) | null = null;

  readonly readable: ReadableStream<Uint8Array>;

  constructor(
    readonly proxyId: string,
    readonly channelId: string,
    private readonly client: TencentTsshProxyClient,
    private readonly handlers: TsshProxyConnectionHandlers = {},
  ) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.close();
      },
    });
    this.closedPromise = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  write(data: Uint8Array | ArrayBuffer | string) {
    if (this.state !== "ready") {
      return false;
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    return this.client.sendProxyData(this, bytes);
  }

  close() {
    if (this.state === "closed") {
      return;
    }
    this.client.closeProxy(this);
  }

  waitClosed() {
    return this.closedPromise;
  }

  markReady() {
    this.setState("ready");
  }

  receive(data: Uint8Array) {
    if (this.state === "closed") {
      return;
    }
    this.handlers.onData?.(data);
    this.controller?.enqueue(data);
  }

  fail(error: Error) {
    if (this.state === "closed") {
      return;
    }
    this.setState("error");
    this.handlers.onError?.(error.message);
    this.controller?.error(error);
    this.rejectClosed?.(error);
  }

  markClosed() {
    if (this.state === "closed") {
      return;
    }
    this.setState("closed");
    this.controller?.close();
    this.handlers.onClose?.();
    this.resolveClosed?.();
  }

  private setState(state: TsshProxyConnectionState) {
    this.state = state;
    this.handlers.onStateChange?.(state);
  }
}

export class TencentTsshProxyClient {
  private socket: WebSocket | null = null;
  private state: TsshProxyClientState = "idle";
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingProxy>();
  private connections = new Map<string, TencentTsshProxyConnection>();

  private readonly connectDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly WebSocketImpl: new (url: string | URL, protocols?: string | string[]) => WebSocket;

  constructor(
    private readonly bootstrap: BotTerminalSession,
    private readonly options: TsshProxyClientOptions = {},
  ) {
    this.connectDelayMs = options.connectDelayMs ?? DEFAULT_PROXY_CONNECT_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.setState("connecting");
      const socket = new this.WebSocketImpl(this.bootstrap.wsUrl);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      socket.onopen = () => {
        this.setState("authenticating");
        this.sendJson({
          Type: "SessionAuth",
          Data: {
            Uin: this.bootstrap.ownerUin,
            AppId: this.bootstrap.appId,
            InstanceId: this.bootstrap.instanceId,
            SessionId: this.bootstrap.sessionId,
          },
        });

        window.setTimeout(() => {
          this.setState("ready");
          resolve();
        }, this.connectDelayMs);
      };

      socket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };

      socket.onerror = () => {
        const error = new Error("websocket error");
        this.fail(error);
        reject(error);
      };

      socket.onclose = (event) => {
        this.socket = null;
        if (this.state !== "error") {
          this.setState("closed");
        }
        for (const connection of this.connections.values()) {
          connection.markClosed();
        }
        this.connections.clear();
        this.options.onClose?.(event);
      };
    });

    return this.readyPromise;
  }

  async openProxy(target: TsshProxyTarget, handlers: TsshProxyConnectionHandlers = {}) {
    await this.connect();
    const proxyId = target.proxyId ?? makeProxyId();
    const channelId = target.channelId ?? proxyId;
    const connection = new TencentTsshProxyConnection(proxyId, channelId, this, handlers);

    return new Promise<TencentTsshProxyConnection>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(proxyId);
        this.connections.delete(proxyId);
        connection.fail(new Error("TAT proxy request timed out"));
        reject(new Error("TAT proxy request timed out"));
      }, this.requestTimeoutMs);

      this.pending.set(proxyId, { proxyId, resolve, reject, timer, connection });
      this.connections.set(proxyId, connection);
      this.sendBson("PtyProxyNew", channelId, {
        ProxyId: proxyId,
        Ip: target.ip ?? "127.0.0.1",
        Port: String(target.port),
      });
    });
  }

  sendProxyData(connection: TencentTsshProxyConnection, data: Uint8Array) {
    return this.sendBson("PtyProxyData", connection.channelId, {
      ProxyId: connection.proxyId,
      Data: new Binary(data),
    });
  }

  closeProxy(connection: TencentTsshProxyConnection) {
    this.sendBson("PtyProxyClose", connection.channelId, {
      ProxyId: connection.proxyId,
    });
    this.connections.delete(connection.proxyId);
    connection.markClosed();
  }

  close() {
    for (const connection of this.connections.values()) {
      this.closeProxy(connection);
    }
    this.socket?.close();
    this.socket = null;
  }

  private async handleMessage(data: string | Blob | ArrayBuffer) {
    try {
      const message = await decodeTencentPtyFrame(data);
      const type = getFrameType(message);
      const payload = getPayload(message);

      if (type === "PtyError" || type === "Error") {
        this.fail(new Error(extractTencentPtyError(message)));
        return;
      }

      if (payload?.Error && typeof payload.Error === "string") {
        this.rejectProxyFromPayload(payload.ProxyId, new Error(payload.Error));
        return;
      }

      if (type === "PtyProxyReady") {
        const proxyId = asString(payload?.ProxyId);
        const pending = this.pending.get(proxyId);
        if (!pending) {
          return;
        }
        window.clearTimeout(pending.timer);
        this.pending.delete(proxyId);
        pending.connection.markReady();
        pending.resolve(pending.connection);
        return;
      }

      if (type === "PtyProxyData") {
        const proxyId = asString(payload?.ProxyId);
        const connection = this.connections.get(proxyId);
        connection?.receive(normalizeBytes(payload?.Data));
        return;
      }

      if (type === "PtyProxyClose") {
        const proxyId = asString(payload?.ProxyId);
        const connection = this.connections.get(proxyId);
        this.connections.delete(proxyId);
        connection?.markClosed();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectProxyFromPayload(proxyIdValue: unknown, error: Error) {
    const proxyId = asString(proxyIdValue);
    const pending = this.pending.get(proxyId);
    if (pending) {
      window.clearTimeout(pending.timer);
      this.pending.delete(proxyId);
      pending.connection.fail(error);
      pending.reject(error);
      return;
    }
    this.connections.get(proxyId)?.fail(error);
  }

  private fail(error: Error) {
    this.setState("error");
    this.options.onError?.(error.message);
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.connection.fail(error);
      pending.reject(error);
    }
    this.pending.clear();
    for (const connection of this.connections.values()) {
      connection.fail(error);
    }
  }

  private sendBson(type: string, channelId: string, data: Record<string, unknown>) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(
      serialize({
        Type: type,
        Data: {
          SessionId: this.bootstrap.sessionId,
          ChannelId: channelId,
          CustomData: "",
          Data: data,
        },
      }),
    );
    return true;
  }

  private sendJson(frame: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private setState(state: TsshProxyClientState) {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
