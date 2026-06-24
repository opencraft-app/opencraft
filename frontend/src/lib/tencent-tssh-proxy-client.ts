import { Binary, serialize } from "bson";
import type { BotTerminalSession } from "@/domain/types";
import { TatTransportError, normalizeTatTransportError } from "@/lib/tat-transport-error";
import { decodeTencentPtyFrame, extractTencentPtyError } from "@/lib/tencent-pty-client";

const DEFAULT_PROXY_CONNECT_DELAY_MS = 200;
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TAT_PROXY_TIMEOUT_SECONDS = 3600;
const TAT_PROXY_LOG_PREFIX = "[tat-proxy]";

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

const websocketReadyStateName = (readyState: number | undefined) => {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return readyState === undefined ? "none" : `unknown:${readyState}`;
  }
};

const redactedUrlSummary = (urlText: string) => {
  try {
    const url = new URL(urlText);
    return {
      hash: url.hash ? "<redacted>" : "",
      host: url.host,
      pathname: url.pathname,
      protocol: url.protocol,
      search: url.search ? "<redacted>" : "",
    };
  } catch {
    return "<invalid-url>";
  }
};

const errorForLog = (error: unknown) =>
  error instanceof Error
    ? {
        cause: error.cause,
        message: error.message,
        name: error.name,
        stack: error.stack,
      }
    : { message: String(error) };

const stringifyLogPayload = (payload: unknown) => {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      stringify_error: error instanceof Error ? error.message : String(error),
    });
  }
};

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
    this.closedPromise.catch(() => {
      // waitClosed() is optional for callers; a proxy-level failure must not
      // become an unhandled rejection when the caller only awaited openProxy().
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
    if (this.state === "closed" || this.state === "error") {
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

  private debugContext(extra: Record<string, unknown> = {}) {
    return {
      appId: this.bootstrap.appId,
      connectionIds: [...this.connections.keys()],
      instanceId: this.bootstrap.instanceId,
      pendingProxyIds: [...this.pending.keys()],
      sessionId: this.bootstrap.sessionId,
      socketReadyState: websocketReadyStateName(this.socket?.readyState),
      state: this.state,
      timeoutSeconds: this.bootstrap.timeoutSeconds ?? DEFAULT_TAT_PROXY_TIMEOUT_SECONDS,
      wsUrl: redactedUrlSummary(this.bootstrap.wsUrl),
      ...extra,
    };
  }

  private logDebug(event: string, context: Record<string, unknown> = {}, error?: unknown) {
    console.log(`${TAT_PROXY_LOG_PREFIX} ${event}`, stringifyLogPayload({
      context: this.debugContext(context),
      error: error === undefined ? null : errorForLog(error),
    }));
  }

  connect() {
    if (this.readyPromise) {
      if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
        return this.readyPromise;
      }
      this.socket = null;
      this.readyPromise = null;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyTimer: ReturnType<typeof window.setTimeout> | null = null;
      const clearReadyTimer = () => {
        if (readyTimer !== null) {
          window.clearTimeout(readyTimer);
          readyTimer = null;
        }
      };
      const resolveReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearReadyTimer();
        resolve();
      };
      const rejectReady = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearReadyTimer();
        this.logDebug("connect rejected", {}, error);
        reject(error);
      };

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
            MaxIdleTime: this.bootstrap.timeoutSeconds ?? DEFAULT_TAT_PROXY_TIMEOUT_SECONDS,
          },
        });

        readyTimer = window.setTimeout(() => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
            const error = new TatTransportError(
              "connection_lost",
              "TAT proxy websocket is not open",
              { phase: "connect" },
            );
            this.logDebug("connect ready timer found websocket not open", {
              actualSocketReadyState: websocketReadyStateName(socket.readyState),
              currentSocketMatches: this.socket === socket,
            }, error);
            rejectReady(error);
            return;
          }
          this.setState("ready");
          resolveReady();
        }, this.connectDelayMs);
      };

      socket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };

      socket.onerror = () => {
        const error = new TatTransportError("connection_lost", "websocket error", {
          phase: "websocket",
        });
        this.logDebug("websocket error", {
          socketReadyStateAtError: websocketReadyStateName(socket.readyState),
        }, error);
        this.fail(error);
        rejectReady(error);
      };

      socket.onclose = (event) => {
        const error = new TatTransportError(
          "connection_lost",
          "TAT proxy websocket closed",
          { phase: "websocket" },
        );
        this.logDebug("websocket closed", {
          close: {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          },
          socketReadyStateAtClose: websocketReadyStateName(socket.readyState),
        }, error);
        rejectReady(error);
        if (this.socket === socket) {
          this.socket = null;
          this.readyPromise = null;
        }
        if (this.state !== "error") {
          this.setState("closed");
        }
        const failedConnections = new Set<TencentTsshProxyConnection>();
        for (const pending of this.pending.values()) {
          window.clearTimeout(pending.timer);
          failedConnections.add(pending.connection);
          pending.connection.fail(error);
          pending.reject(error);
        }
        this.pending.clear();
        for (const connection of this.connections.values()) {
          if (failedConnections.has(connection)) {
            continue;
          }
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
    this.logDebug("open proxy requested", {
      channelId,
      proxyId,
      target,
    });

    return new Promise<TencentTsshProxyConnection>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(proxyId);
        this.connections.delete(proxyId);
        const error = new TatTransportError(
          "request_timeout",
          "TAT proxy request timed out",
          { phase: "open_proxy" },
        );
        this.logDebug("open proxy timed out", {
          channelId,
          proxyId,
          target,
        }, error);
        connection.fail(error);
        reject(error);
      }, this.requestTimeoutMs);

      this.pending.set(proxyId, { proxyId, resolve, reject, timer, connection });
      this.connections.set(proxyId, connection);
      const sent = this.sendBson("PtyProxyNew", channelId, {
        ProxyId: proxyId,
        Ip: target.ip ?? "127.0.0.1",
        Port: String(target.port),
      });
      if (!sent) {
        window.clearTimeout(timer);
        this.pending.delete(proxyId);
        this.connections.delete(proxyId);
        const error = new TatTransportError(
          "connection_lost",
          "TAT proxy websocket is not open",
          { phase: "open_proxy" },
        );
        this.logDebug("open proxy send failed because websocket is not open", {
          channelId,
          proxyId,
          target,
        }, error);
        connection.fail(error);
        reject(error);
      }
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
        const error = normalizeTatTransportError(
          new Error(extractTencentPtyError(message)),
          "websocket",
        );
        this.logDebug("received TAT error frame", { frameType: type }, error);
        this.fail(error);
        return;
      }

      if (payload?.Error && typeof payload.Error === "string") {
        const error = normalizeTatTransportError(
          new Error(payload.Error),
          "open_proxy",
        );
        this.logDebug("received proxy payload error", {
          frameType: type,
          proxyId: asString(payload.ProxyId),
        }, error);
        this.rejectProxyFromPayload(payload.ProxyId, error);
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
        this.logDebug("proxy ready", { proxyId });
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
      const normalizedError = normalizeTatTransportError(error, "websocket");
      this.logDebug("failed to handle websocket frame", {}, normalizedError);
      this.fail(normalizedError);
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
    this.logDebug("client failed", {}, error);
    this.setState("error");
    this.readyPromise = null;
    this.socket = null;
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
      this.logDebug("sendBson skipped because websocket is not open", {
        channelId,
        frameType: type,
        socketReadyStateAtSend: websocketReadyStateName(this.socket?.readyState),
      });
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
      this.logDebug("sendJson skipped because websocket is not open", {
        frame,
        socketReadyStateAtSend: websocketReadyStateName(this.socket?.readyState),
      });
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
