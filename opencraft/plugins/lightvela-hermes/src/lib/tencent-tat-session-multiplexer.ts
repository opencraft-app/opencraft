import { Binary, serialize } from "bson";
import type { BotTerminalSession } from "../domain/types";
import { TatTransportError, normalizeTatTransportError } from "./tat-transport-error";
import {
  decodeTencentTatFrame,
  extractTencentTatError,
  extractTencentPtyOutput,
} from "./tencent-tat-frame-codec";
import { encodeUtf8 } from "./utf8";

const DEFAULT_PROXY_CONNECT_DELAY_MS = 200;
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TAT_PROXY_TIMEOUT_SECONDS = 3600;
const TAT_PROXY_LOG_PREFIX = "[tat-session]";

export type TsshProxyClientState = "idle" | "connecting" | "authenticating" | "ready" | "closed" | "error";
export type TsshProxyConnectionState = "connecting" | "ready" | "closed" | "error";

export interface TsshProxyClientOptions {
  connectDelayMs?: number;
  requestTimeoutMs?: number;
  /**
   * Keeps the physical TAT tunnel active when all logical channels are idle.
   * The probe is owned here (not by Hermes RPC, HTTP, or PTY) because those
   * protocols have independent lifecycles and may legitimately be silent.
   */
  idleKeepaliveIntervalMs?: number;
  idleKeepaliveTarget?: TsshProxyTarget;
  WebSocketImpl?: new (url: string | URL, protocols?: string | string[]) => WebSocket;
  onStateChange?: (state: TsshProxyClientState) => void;
  onError?: (message: string) => void;
  onClose?: (event: CloseEvent) => void;
  /** Reports evidence, never schedules or performs a new TAT session. */
  onUnhealthy?: () => void;
  diagnosticContext?: { readonly hostId: string; readonly generation: number };
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

export interface TatPtyChannelHandlers {
  onOutput?: (output: string) => void;
  onError?: (error: Error) => void;
}

export interface TatPtyOpenOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Keeps this PTY's own TAT session alive without writing bytes into the
   * shell. This is deliberately independent from proxy/dashboard keepalive.
   */
  readonly keepaliveIntervalMs?: number;
}

export interface TatPtyChannel {
  sendInput(input: string): boolean;
  resize(cols: number, rows: number): boolean;
  /** Detaches the logical consumer while the Host-owned PTY remains alive. */
  release(): void;
}

type PendingProxy = {
  proxyId: string;
  healthProbe: boolean;
  resolve: (connection: TencentTatProxyConnection) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  connection: TencentTatProxyConnection;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

const asString = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

const encodeBase64 = (value: string) => {
  const bytes = encodeUtf8(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

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

export class TencentTatProxyConnection {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private state: TsshProxyConnectionState = "connecting";
  private closedPromise: Promise<void>;
  private resolveClosed: (() => void) | null = null;
  private rejectClosed: ((error: Error) => void) | null = null;

  readonly readable: ReadableStream<Uint8Array>;

  constructor(
    readonly proxyId: string,
    readonly channelId: string,
    private readonly client: TencentTatSessionMultiplexer,
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
    const bytes = typeof data === "string" ? encodeUtf8(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
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
    if (this.state === "closed" || this.state === "error") {
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
    const controller = this.controller;
    this.controller = null;
    controller?.error(error);
    this.rejectClosed?.(error);
  }

  markClosed() {
    if (this.state === "closed") {
      return;
    }
    this.setState("closed");
    const controller = this.controller;
    this.controller = null;
    controller?.close();
    this.handlers.onClose?.();
    this.resolveClosed?.();
  }

  private setState(state: TsshProxyConnectionState) {
    this.state = state;
    this.handlers.onStateChange?.(state);
  }
}

export class TencentTatSessionMultiplexer {
  private socket: WebSocket | null = null;
  private state: TsshProxyClientState = "idle";
  private readyPromise: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private pending = new Map<string, PendingProxy>();
  private connections = new Map<string, TencentTatProxyConnection>();
  private ptyStarted = false;
  private ptyHandlers: TatPtyChannelHandlers | null = null;
  private ptyChannel: TatPtyChannel | null = null;
  private ptyReadyPromise: Promise<TatPtyChannel> | null = null;
  private resolvePtyReady: ((channel: TatPtyChannel) => void) | null = null;
  private rejectPtyReady: ((error: Error) => void) | null = null;
  private ptyReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private ptyKeepaliveIntervalMs = 0;
  private ptyDimensions: { cols: number; rows: number } | null = null;
  private lastInboundSequence = -1;
  private inboundRevision = 0;
  private healthProbe: Promise<void> | null = null;
  private idleKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTransportActivityAt = Date.now();
  private retired = false;

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
    if (this.retired) return Promise.reject(new Error("TAT tunnel is retired"));
    if (this.readyPromise) {
      if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
        return this.readyPromise;
      }
      this.socket = null;
      this.readyPromise = null;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyTimer: ReturnType<typeof setTimeout> | null = null;
      const clearReadyTimer = () => {
        if (readyTimer !== null) {
          globalThis.clearTimeout(readyTimer);
          readyTimer = null;
        }
      };
      const resolveReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.rejectReady = null;
        clearReadyTimer();
        resolve();
      };
      const rejectReady = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.rejectReady = null;
        clearReadyTimer();
        this.logDebug("connect rejected", {}, error);
        reject(error);
      };

      this.setState("connecting");
      this.rejectReady = rejectReady;
      const socket = new this.WebSocketImpl(this.bootstrap.wsUrl);
      this.lastInboundSequence = -1;
      this.lastTransportActivityAt = Date.now();
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

        readyTimer = globalThis.setTimeout(() => {
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
          this.startIdleKeepalive();
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
        this.stopIdleKeepalive();
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
        const failedConnections = new Set<TencentTatProxyConnection>();
        for (const pending of this.pending.values()) {
          globalThis.clearTimeout(pending.timer);
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
        // A terminal may use a dedicated TAT socket while the dashboard Host
        // remains healthy. Project that socket loss into the PTY owner instead
        // of leaving a process that still claims to accept input.
        this.failPty(error);
        this.options.onClose?.(event);
      };
    });

    return this.readyPromise;
  }

  async openProxy(target: TsshProxyTarget, handlers: TsshProxyConnectionHandlers = {}, healthProbe = false) {
    await this.connect();
    const proxyId = target.proxyId ?? makeProxyId();
    const channelId = target.channelId ?? proxyId;
    const connection = new TencentTatProxyConnection(proxyId, channelId, this, handlers);
    if (!healthProbe) {
      this.logDebug("open proxy requested", {
        channelId,
        proxyId,
        target,
      });
    }

    return new Promise<TencentTatProxyConnection>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(proxyId);
        this.connections.delete(proxyId);
        const error = new TatTransportError(
          "request_timeout",
          "TAT proxy request timed out",
          { phase: "open_proxy" },
        );
        if (!healthProbe) {
          this.logDebug("open proxy timed out", {
            channelId,
            proxyId,
            target,
          }, error);
        }
        connection.fail(error);
        reject(error);
        this.sendBson("PtyProxyClose", channelId, { ProxyId: proxyId });
        if (!healthProbe) this.checkHealth(target);
      }, this.requestTimeoutMs);

      this.pending.set(proxyId, { proxyId, healthProbe, resolve, reject, timer, connection });
      this.connections.set(proxyId, connection);
      const sent = this.sendBson("PtyProxyNew", channelId, {
        ProxyId: proxyId,
        Ip: target.ip ?? "127.0.0.1",
        Port: String(target.port),
      });
      if (!sent) {
        globalThis.clearTimeout(timer);
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

  private checkHealth(
    target: TsshProxyTarget,
    reason: "open_proxy_timeout" | "idle_keepalive" = "open_proxy_timeout",
  ): Promise<void> | null {
    if (this.retired) return null;
    if (this.healthProbe !== null) return this.healthProbe;
    const inboundRevision = this.inboundRevision;
    if (reason === "open_proxy_timeout") {
      console.log("[tat-health] suspect", { ...this.options.diagnosticContext, reason, targetPort: target.port });
    }
    // A fresh logical TCP channel checks the existing tunnel without minting a
    // session, touching the PTY, or replaying the failed business request.
    const operation = this.openProxy({ ip: target.ip, port: target.port }, {}, true)
      .then(connection => {
        connection.close();
        if (!this.retired && reason === "open_proxy_timeout") {
          console.log("[tat-health] recovered", { ...this.options.diagnosticContext, evidence: "proxy_ready" });
        }
      }, () => {
        if (this.retired) return;
        if (this.inboundRevision !== inboundRevision) {
          console.log("[tat-health] degraded", {
            ...this.options.diagnosticContext,
            reason: "proxy_unavailable_but_tunnel_receiving",
            trigger: reason,
          });
          return;
        }
        console.log("[tat-health] unhealthy", {
          ...this.options.diagnosticContext,
          reason: "probe_failed_without_inbound_progress",
          trigger: reason,
        });
        this.close();
        this.options.onUnhealthy?.();
      }).finally(() => {
        if (this.healthProbe === operation) this.healthProbe = null;
      });
    this.healthProbe = operation;
    return operation;
  }

  private startIdleKeepalive(): void {
    const intervalMs = this.options.idleKeepaliveIntervalMs ?? 0;
    const target = this.options.idleKeepaliveTarget;
    if (intervalMs <= 0 || target === undefined || this.retired) return;
    this.stopIdleKeepalive();
    console.log("[tat-health] idle keepalive started", {
      ...this.options.diagnosticContext,
      intervalMs,
      targetPort: target.port,
    });
    this.scheduleIdleKeepalive(intervalMs);
  }

  private scheduleIdleKeepalive(delayMs: number): void {
    if (this.retired || this.state !== "ready") return;
    const intervalMs = this.options.idleKeepaliveIntervalMs ?? 0;
    const target = this.options.idleKeepaliveTarget;
    if (intervalMs <= 0 || target === undefined) return;
    this.stopIdleKeepalive();
    const timer = globalThis.setTimeout(() => {
      if (this.idleKeepaliveTimer !== timer) return;
      this.idleKeepaliveTimer = null;
      if (this.retired || this.state !== "ready") return;
      const idleMs = Date.now() - this.lastTransportActivityAt;
      if (idleMs < intervalMs) {
        this.scheduleIdleKeepalive(intervalMs - idleMs);
        return;
      }
      const operation = this.checkHealth(target, "idle_keepalive");
      if (operation === null) return;
      void operation.finally(() => {
        if (!this.retired && this.state === "ready") {
          this.scheduleIdleKeepalive(intervalMs);
        }
      });
    }, Math.max(1, delayMs));
    // Node-based contract tests must not be kept alive by a browser timer.
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.idleKeepaliveTimer = timer;
  }

  private stopIdleKeepalive(): void {
    if (this.idleKeepaliveTimer === null) return;
    globalThis.clearTimeout(this.idleKeepaliveTimer);
    this.idleKeepaliveTimer = null;
  }

  private markTransportActivity(): void {
    this.lastTransportActivityAt = Date.now();
  }

  /**
   * Starts the one PTY carried by this authenticated TAT session. Proxy
   * channels remain independently multiplexed on the same physical socket.
   */
  async openPty(
    handlers: TatPtyChannelHandlers = {},
    options: TatPtyOpenOptions = {},
  ): Promise<TatPtyChannel> {
    await this.connect();
    if (this.ptyStarted || this.ptyReadyPromise !== null) {
      throw new Error("TAT session already owns a PTY channel");
    }
    const cols = options.cols ?? this.bootstrap.cols;
    const rows = options.rows ?? this.bootstrap.rows;
    this.ptyDimensions = { cols, rows };
    this.ptyKeepaliveIntervalMs = typeof options.keepaliveIntervalMs === "number"
      && Number.isFinite(options.keepaliveIntervalMs)
      && options.keepaliveIntervalMs > 0
      ? options.keepaliveIntervalMs
      : 0;
    this.ptyHandlers = handlers;
    const channel: TatPtyChannel = Object.freeze({
      sendInput: (input: string) => this.sendPtyInput(input),
      resize: (cols: number, rows: number) => this.resizePty(cols, rows),
      release: () => {
        if (this.ptyHandlers === handlers) {
          this.stopPtyKeepalive();
          this.ptyHandlers = null;
        }
      },
    });
    this.ptyChannel = channel;
    const ready = new Promise<TatPtyChannel>((resolve, reject) => {
      this.resolvePtyReady = resolve;
      this.rejectPtyReady = reject;
    });
    this.ptyReadyPromise = ready;
    const sent = this.sendJson({
      Type: "PtyStart",
      Data: {
        SessionId: this.bootstrap.sessionId,
        ChannelId: "",
        Cols: cols,
        Rows: rows,
        UserName: this.bootstrap.username?.trim() || "agentuser",
        Cwd: options.cwd ?? (this.bootstrap.workingDirectory?.trim() || "/home/agentuser"),
        Envs: { ...options.env },
        ...(options.program === undefined ? {} : {
          Program: options.program,
          Args: [...(options.args ?? [])],
        }),
      },
    });
    if (!sent) {
      const error = new TatTransportError(
        "connection_lost",
        "TAT websocket is not open for PTY start",
        { phase: "pty_start" },
      );
      this.failPty(error);
      return ready;
    }
    this.ptyStarted = true;
    this.ptyReadyTimer = globalThis.setTimeout(() => {
      this.failPty(new TatTransportError(
        "request_timeout",
        "TAT PTY start timed out",
        { phase: "pty_start" },
      ));
    }, this.requestTimeoutMs);
    return ready;
  }

  sendProxyData(connection: TencentTatProxyConnection, data: Uint8Array) {
    return this.sendBson("PtyProxyData", connection.channelId, {
      ProxyId: connection.proxyId,
      Data: new Binary(data),
    });
  }

  closeProxy(connection: TencentTatProxyConnection) {
    this.sendBson("PtyProxyClose", connection.channelId, {
      ProxyId: connection.proxyId,
    });
    this.connections.delete(connection.proxyId);
    connection.markClosed();
  }

  close() {
    if (this.retired) return;
    this.retired = true;
    this.stopIdleKeepalive();
    const error = new TatTransportError("connection_lost", "TAT tunnel retired", { phase: "websocket" });
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.connection.fail(error);
      pending.reject(error);
    }
    this.pending.clear();
    for (const connection of this.connections.values()) {
      this.closeProxy(connection);
    }
    if (this.ptyStarted) {
      this.sendJson({ Type: "PtyStop", Data: { SessionId: this.bootstrap.sessionId } });
    }
    this.ptyStarted = false;
    this.ptyHandlers = null;
    this.failPty(new Error("TAT session closed"));
    this.socket?.close();
    this.socket = null;
  }

  private async handleMessage(data: string | Blob | ArrayBuffer) {
    try {
      const message = await decodeTencentTatFrame(data);
      if (this.retired) return;
      // Even a duplicate protocol sequence proves that the physical tunnel is
      // receiving, so activity is sampled before replay suppression.
      this.markTransportActivity();
      const sequence = isRecord(message) && typeof message.Seq === "number"
        ? message.Seq
        : null;
      if (sequence !== null) {
        if (sequence <= this.lastInboundSequence) return;
        this.lastInboundSequence = sequence;
      }
      const type = getFrameType(message);
      this.inboundRevision += 1;
      const envelope = getEnvelope(message);
      const payload = getPayload(message);

      if (type === "PtyReady") {
        const resolve = this.resolvePtyReady;
        const channel = this.ptyChannel;
        this.resolvePtyReady = null;
        this.rejectPtyReady = null;
        this.ptyReadyPromise = null;
        if (this.ptyReadyTimer !== null) globalThis.clearTimeout(this.ptyReadyTimer);
        this.ptyReadyTimer = null;
        if (resolve !== null && channel !== null) {
          this.startPtyKeepalive();
          resolve(channel);
        }
        return;
      }

      if (type === "PtyOutput") {
        const output = extractTencentPtyOutput(message);
        if (output) this.ptyHandlers?.onOutput?.(output);
        return;
      }

      if (type === "PtyError") {
        const error = normalizeTatTransportError(
          new Error(extractTencentTatError(message)),
          "websocket",
        );
        this.failPty(error);
        return;
      }

      if (type === "Error") {
        const error = normalizeTatTransportError(
          new Error(extractTencentTatError(message)),
          "websocket",
        );
        this.logDebug("received TAT error frame", { frameType: type }, error);
        this.fail(error);
        return;
      }

      if (payload?.Error && typeof payload.Error === "string") {
        const proxyId = asString(payload.ProxyId, asString(envelope?.ChannelId));
        const error = normalizeTatTransportError(
          new Error(payload.Error),
          "open_proxy",
        );
        this.logDebug("received proxy payload error", {
          frameType: type,
          proxyId,
        }, error);
        this.rejectProxyFromPayload(proxyId, error);
        return;
      }

      if (type === "PtyProxyReady") {
        const proxyId = asString(payload?.ProxyId);
        const pending = this.pending.get(proxyId);
        if (!pending) {
          if (!this.connections.has(proxyId)) {
            this.sendBson("PtyProxyClose", asString(envelope?.ChannelId, proxyId), { ProxyId: proxyId });
          }
          return;
        }
        globalThis.clearTimeout(pending.timer);
        this.pending.delete(proxyId);
        pending.connection.markReady();
        if (!pending.healthProbe) this.logDebug("proxy ready", { proxyId });
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
      globalThis.clearTimeout(pending.timer);
      this.pending.delete(proxyId);
      pending.connection.fail(error);
      pending.reject(error);
      return;
    }
    this.connections.get(proxyId)?.fail(error);
  }

  private fail(error: Error) {
    this.stopIdleKeepalive();
    this.logDebug("client failed", {}, error);
    this.setState("error");
    this.readyPromise = null;
    this.rejectReady?.(error);
    this.rejectReady = null;
    this.socket = null;
    this.failPty(error);
    this.options.onError?.(error.message);
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.connection.fail(error);
      pending.reject(error);
    }
    this.pending.clear();
    for (const connection of this.connections.values()) {
      connection.fail(error);
    }
  }

  private sendPtyInput(input: string): boolean {
    if (!this.ptyStarted) return false;
    return this.sendJson({
      Type: "PtyInput",
      Data: {
        SessionId: this.bootstrap.sessionId,
        Input: encodeBase64(input),
      },
    });
  }

  private resizePty(cols: number, rows: number): boolean {
    if (!this.ptyStarted) return false;
    this.ptyDimensions = { cols, rows };
    return this.sendJson({
      Type: "PtyResize",
      Data: {
        SessionId: this.bootstrap.sessionId,
        ChannelId: "",
        Cols: cols,
        Rows: rows,
      },
    });
  }

  private startPtyKeepalive(): void {
    this.stopPtyKeepalive();
    if (this.ptyKeepaliveIntervalMs <= 0 || !this.ptyStarted || this.retired) return;
    this.schedulePtyKeepalive(this.ptyKeepaliveIntervalMs);
  }

  private schedulePtyKeepalive(delayMs: number): void {
    if (this.ptyKeepaliveIntervalMs <= 0 || !this.ptyStarted || this.retired) return;
    this.stopPtyKeepalive();
    const timer = globalThis.setTimeout(() => {
      if (this.ptyKeepaliveTimer !== timer) return;
      this.ptyKeepaliveTimer = null;
      if (!this.ptyStarted || this.retired) return;
      const idleMs = Date.now() - this.lastTransportActivityAt;
      if (idleMs < this.ptyKeepaliveIntervalMs) {
        this.schedulePtyKeepalive(this.ptyKeepaliveIntervalMs - idleMs);
        return;
      }
      const size = this.ptyDimensions;
      if (size === null || !this.sendJson({
        Type: "PtyResize",
        Data: {
          SessionId: this.bootstrap.sessionId,
          ChannelId: "",
          Cols: size.cols,
          Rows: size.rows,
        },
      })) {
        this.failPty(new TatTransportError(
          "connection_lost",
          "TAT PTY keepalive could not be sent",
          { phase: "websocket" },
        ));
        return;
      }
      this.schedulePtyKeepalive(this.ptyKeepaliveIntervalMs);
    }, Math.max(1, delayMs));
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.ptyKeepaliveTimer = timer;
  }

  private stopPtyKeepalive(): void {
    if (this.ptyKeepaliveTimer === null) return;
    globalThis.clearTimeout(this.ptyKeepaliveTimer);
    this.ptyKeepaliveTimer = null;
  }

  private failPty(error: Error): void {
    const reject = this.rejectPtyReady;
    const handlers = this.ptyHandlers;
    this.stopPtyKeepalive();
    if (this.ptyReadyTimer !== null) globalThis.clearTimeout(this.ptyReadyTimer);
    this.ptyReadyTimer = null;
    this.resolvePtyReady = null;
    this.rejectPtyReady = null;
    this.ptyReadyPromise = null;
    this.ptyHandlers = null;
    this.ptyChannel = null;
    this.ptyStarted = false;
    this.ptyKeepaliveIntervalMs = 0;
    this.ptyDimensions = null;
    if (reject !== null) reject(error);
    else handlers?.onError?.(error);
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
    this.markTransportActivity();
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
    this.markTransportActivity();
    return true;
  }

  private setState(state: TsshProxyClientState) {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
