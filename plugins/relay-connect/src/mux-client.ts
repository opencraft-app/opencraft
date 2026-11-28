import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import {
  DEFAULT_MUX_BATCH_MS,
  MAX_MUX_PAYLOAD,
  MAX_MUX_STREAMS,
  MuxFrameType,
  MuxOutboundBatcher,
  MuxStreamFlowControl,
  RELAY_MUX_PATH,
  RELAY_MUX_PING,
  RELAY_MUX_PONG,
  RELAY_MUX_PROTOCOL,
  decodeMuxFrame,
  encodeMuxFrame,
  parseMachineCredential,
  validateDirectRouteCandidate,
  type DirectRouteCandidate,
  type MuxFrame,
  type MuxOpenHttpInit,
  type MuxOpenWsInit,
} from "@opencraft/relay-protocol";
import { bridgeRelayDuplex } from "@opencraft/relay-protocol/node";

export const MUX_TCP_TUNNEL_SUBPROTOCOL = "opencraft-tcp-tunnel.v1";
export const DEFAULT_MUX_HEARTBEAT_MS = 45_000;

export interface MuxSocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

export interface RelayMuxWsStream {
  readonly streamId: number;
  readonly init: MuxOpenWsInit;
  sendText(text: string, options?: { transientDelta?: boolean }): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onText(handler: (text: string) => void): void;
  onBinary(handler: (data: Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
}

export interface RelayMuxHttpRequest {
  readonly streamId: number;
  readonly init: MuxOpenHttpInit;
  readonly body: Uint8Array;
}

export interface RelayMuxHttpResponse {
  readonly status: number;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: Uint8Array | string;
}

export type RelayMuxClientOptions = {
  readonly relay: string;
  readonly credential: string;
  readonly allowLoopbackInsecure?: boolean;
  readonly ca?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly batchWindowMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly initialRoutes?: readonly DirectRouteCandidate[];
  readonly createSocket?: (url: string, subprotocol: string, headers: Record<string, string>) => MuxSocketLike;
  readonly onConnected?: () => void;
  readonly onDisconnected?: (code: number) => void;
  readonly onAudienceChange?: (activeWatchers: number) => void;
} & (
  | {
      readonly targetPort: number;
      readonly acceptStream?: never;
      readonly onOpenWs?: never;
      readonly onOpenHttp?: never;
    }
  | {
      readonly targetPort?: never;
      readonly acceptStream: (stream: Duplex) => void;
      readonly onOpenWs?: never;
      readonly onOpenHttp?: never;
    }
  | {
      readonly targetPort?: never;
      readonly acceptStream?: never;
      readonly onOpenWs: (stream: RelayMuxWsStream, init: MuxOpenWsInit) => void | Promise<void>;
      readonly onOpenHttp?: (
        request: RelayMuxHttpRequest,
        init: MuxOpenHttpInit,
      ) => Promise<RelayMuxHttpResponse> | RelayMuxHttpResponse;
    }
);

export interface RelayMuxClientConnection {
  connected(): boolean;
  activeWatchers(): number;
  advertiseRoutes(candidates: readonly DirectRouteCandidate[]): void;
  close(): void;
}

function isValidMuxCredential(credential: string): boolean {
  return parseMachineCredential(credential) !== null || /^[A-Za-z0-9_-]{43}$/u.test(credential);
}

/**
 * Heuristic detector for high-frequency transient streaming deltas so hosts
 * using loopback WebSocket forwarding automatically suppress intermediate deltas
 * when `activeWatchers === 0` while preserving final responses and state commits.
 */
export function isTransientDeltaPayload(text: string): boolean {
  if (text.length === 0 || text[0] !== "{") return false;
  if (!text.includes("delta") && !text.includes("Delta")) return false;
  try {
    const parsed = JSON.parse(text) as { id?: unknown; method?: unknown; type?: unknown; frame?: unknown };
    if (parsed.type === "host/frame" && typeof parsed.frame === "string") {
      return isTransientDeltaPayload(parsed.frame);
    }
    if (parsed.id !== undefined) return false; // Never drop RPC responses or requests!
    const tag = typeof parsed.method === "string" ? parsed.method : typeof parsed.type === "string" ? parsed.type : "";
    return /(?:\/delta|Delta|\.delta)$/u.test(tag);
  } catch {
    return false;
  }
}

function defaultWsFactory(ca?: string) {
  return (url: string, subprotocol: string, headers: Record<string, string>): MuxSocketLike => {
    const ws = new WebSocket(url, subprotocol, {
      ca,
      headers,
      perMessageDeflate: false,
      maxPayload: MAX_MUX_PAYLOAD + 1024,
      handshakeTimeout: 10_000,
    });
    return {
      get readyState() {
        return ws.readyState;
      },
      send(data) {
        ws.send(data);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
      terminate() {
        ws.terminate();
      },
      onOpen(handler) {
        ws.once("open", handler);
      },
      onMessage(handler) {
        ws.on("message", (raw, isBinary) => {
          if (!isBinary) {
            handler(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
            return;
          }
          if (raw instanceof Uint8Array) {
            handler(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
          } else if (Array.isArray(raw)) {
            handler(new Uint8Array(Buffer.concat(raw)));
          } else {
            handler(new Uint8Array(raw as ArrayBuffer));
          }
        });
      },
      onClose(handler) {
        ws.once("close", (code, reason) => handler(code, reason.toString("utf8")));
      },
      onError(handler) {
        ws.on("error", handler);
      },
    };
  };
}

interface ActiveWsEntry {
  readonly kind: "ws";
  readonly flow: MuxStreamFlowControl;
  readonly textHandlers: Set<(text: string) => void>;
  readonly binaryHandlers: Set<(data: Uint8Array) => void>;
  readonly closeHandlers: Set<(code: number, reason: string) => void>;
  closed: boolean;
}

interface ActiveHttpEntry {
  readonly kind: "http";
  readonly init: MuxOpenHttpInit;
  readonly chunks: Uint8Array[];
  totalBytes: number;
  aborted: boolean;
}

interface ActiveDuplexEntry {
  readonly kind: "duplex";
  readonly flow: MuxStreamFlowControl;
  duplex: Duplex;
  closed: boolean;
}

type ActiveStreamEntry = ActiveWsEntry | ActiveHttpEntry | ActiveDuplexEntry;

export function connectRelayMux(options: RelayMuxClientOptions): RelayMuxClientConnection {
  const endpoint = new URL(options.relay);
  const allowInsecure =
    options.allowLoopbackInsecure === true &&
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".test"));
  const validTarget =
    typeof options.onOpenWs === "function"
      ? options.targetPort === undefined && options.acceptStream === undefined
      : typeof options.acceptStream === "function"
        ? options.targetPort === undefined
        : Number.isInteger(options.targetPort) &&
          Number(options.targetPort) >= 1 &&
          Number(options.targetPort) <= 65_535;
  if (
    endpoint.origin !== options.relay ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol !== "https:" && !allowInsecure) ||
    !isValidMuxCredential(options.credential) ||
    !validTarget
  ) {
    throw new Error("Invalid mux relay connection configuration");
  }

  let currentRoutes: readonly DirectRouteCandidate[] = (options.initialRoutes ?? []).map(validateDirectRouteCandidate);
  let socket: MuxSocketLike | undefined;
  let batcher: MuxOutboundBatcher | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let watchers = 1;
  let lastInboundAt = Date.now();
  let lastOutboundAt = Date.now();
  const activeStreams = new Map<number, ActiveStreamEntry>();
  const makeSocket = options.createSocket ?? defaultWsFactory(options.ca);
  const wsUrl = endpoint.origin.replace(/^http/u, "ws") + RELAY_MUX_PATH;

  const sendOnSocket = (ws: MuxSocketLike, payload: string | Uint8Array) => {
    lastOutboundAt = Date.now();
    ws.send(payload);
  };

  const cleanupStreams = (code: number, reason: string) => {
    for (const entry of activeStreams.values()) {
      if (entry.kind === "ws" && !entry.closed) {
        entry.closed = true;
        entry.flow.clear();
        for (const fn of entry.closeHandlers) fn(code, reason);
      } else if (entry.kind === "http") {
        entry.aborted = true;
      } else if (entry.kind === "duplex" && !entry.closed) {
        entry.closed = true;
        entry.flow.clear();
        entry.duplex.destroy();
      }
    }
    activeStreams.clear();
  };

  const forwardHttpToLoopback = (targetPort: number, req: RelayMuxHttpRequest): Promise<RelayMuxHttpResponse> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of req.init.headers) headers[k] = v;
      headers["x-opencraft-actor-id"] = req.init.actorId;
      headers["x-opencraft-access-role"] = req.init.scope.role;
      if (req.init.grantId) headers["x-opencraft-grant-id"] = req.init.grantId;

      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: targetPort,
          method: req.init.method,
          path: req.init.path,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > 8 * 1024 * 1024) {
              upstream.destroy(new Error("Inline mux HTTP response exceeded 8 MiB; use R2 blob offload"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const responseHeaders: [string, string][] = [];
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === undefined || ["connection", "transfer-encoding", "keep-alive"].includes(k.toLowerCase()))
                continue;
              responseHeaders.push([k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v]);
            }
            resolve({
              status: res.statusCode ?? 502,
              headers: responseHeaders,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          res.on("error", reject);
        },
      );
      upstream.setTimeout(30_000, () => upstream.destroy(new Error("Loopback HTTP timeout")));
      upstream.on("error", reject);
      if (req.body.byteLength > 0) upstream.write(req.body);
      upstream.end();
    });

  const bridgeWsToLoopback = (targetPort: number, stream: RelayMuxWsStream, init: MuxOpenWsInit) => {
    const localWs = new WebSocket(
      `ws://127.0.0.1:${targetPort}${init.path}`,
      init.subprotocol ? [init.subprotocol] : undefined,
      {
        headers: {
          "x-opencraft-actor-id": init.actorId,
          "x-opencraft-access-role": init.scope.role,
          ...(init.grantId ? { "x-opencraft-grant-id": init.grantId } : {}),
        },
        perMessageDeflate: false,
      },
    );
    const pendingInbound: { binary: boolean; payload: string | Uint8Array }[] = [];
    let isOpen = false;

    stream.onText((text) => {
      if (isOpen && localWs.readyState === WebSocket.OPEN) localWs.send(text);
      else if (!isOpen && pendingInbound.length < 128) pendingInbound.push({ binary: false, payload: text });
    });
    stream.onBinary((data) => {
      if (isOpen && localWs.readyState === WebSocket.OPEN) localWs.send(data);
      else if (!isOpen && pendingInbound.length < 128) pendingInbound.push({ binary: true, payload: data });
    });
    stream.onClose((code, reason) => {
      if (localWs.readyState === WebSocket.OPEN || localWs.readyState === WebSocket.CONNECTING) {
        localWs.close(code >= 1000 && code <= 4999 ? code : 1000, reason.slice(0, 120));
      }
    });

    localWs.once("open", () => {
      isOpen = true;
      for (const item of pendingInbound.splice(0)) {
        localWs.send(item.payload);
      }
    });
    localWs.on("message", (raw, isBinary) => {
      if (!isBinary) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
        stream.sendText(text, { transientDelta: isTransientDeltaPayload(text) });
      } else {
        const bytes =
          raw instanceof Uint8Array
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : Array.isArray(raw)
              ? new Uint8Array(Buffer.concat(raw))
              : new Uint8Array(raw as ArrayBuffer);
        stream.sendBinary(bytes);
      }
    });
    localWs.once("close", (code, reason) => {
      stream.close(code || 1000, reason.toString("utf8").slice(0, 120));
    });
    localWs.on("error", () => {
      stream.close(1011, "Local Host unavailable");
    });
  };

  const openRawTunnelDuplex = (streamId: number, emitFrame: (frame: MuxFrame) => void): ActiveDuplexEntry => {
    const flow = new MuxStreamFlowControl(streamId, emitFrame);
    const entry: ActiveDuplexEntry = { kind: "duplex", flow, duplex: undefined as never, closed: false };
    const duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        try {
          flow.sendBinary(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
      final(callback) {
        try {
          if (!entry.closed) {
            entry.closed = true;
            activeStreams.delete(streamId);
            emitFrame({ type: MuxFrameType.CLOSE, streamId, code: 1000, reason: "" });
          }
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
      destroy(err, callback) {
        if (!entry.closed) {
          entry.closed = true;
          flow.clear();
          activeStreams.delete(streamId);
          emitFrame({ type: MuxFrameType.CLOSE, streamId, code: err ? 1011 : 1000, reason: "" });
        }
        callback(err);
      },
    });
    entry.duplex = duplex;
    return entry;
  };

  const dispatchHttpRequest = async (
    entry: ActiveHttpEntry,
    streamId: number,
    emitFrame: (frame: MuxFrame) => void,
  ) => {
    activeStreams.delete(streamId);
    if (entry.aborted) return;
    const body = new Uint8Array(entry.totalBytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      let response: RelayMuxHttpResponse;
      if (options.onOpenHttp) {
        response = await options.onOpenHttp({ streamId, init: entry.init, body }, entry.init);
      } else if (options.targetPort !== undefined) {
        response = await forwardHttpToLoopback(options.targetPort, { streamId, init: entry.init, body });
      } else {
        response = {
          status: 501,
          headers: [["content-type", "application/json"]],
          body: '{"error":"http_not_supported"}',
        };
      }
      if (entry.aborted) return;
      const bodyBytes =
        response.body === undefined
          ? new Uint8Array(0)
          : typeof response.body === "string"
            ? new TextEncoder().encode(response.body)
            : response.body;
      emitFrame({
        type: MuxFrameType.HTTP_RESPONSE,
        streamId,
        fin: bodyBytes.byteLength === 0,
        init: { status: response.status, headers: response.headers ?? [] },
      });
      if (bodyBytes.byteLength > 0) {
        const flow = new MuxStreamFlowControl(streamId, emitFrame, {
          maxBufferedBytes: Math.max(8 * 1024 * 1024, bodyBytes.byteLength + 1024),
        });
        flow.sendBinary(bodyBytes, { fin: true });
      }
    } catch {
      if (!entry.aborted) {
        emitFrame({
          type: MuxFrameType.HTTP_RESPONSE,
          streamId,
          fin: true,
          init: { status: 502, headers: [["content-type", "application/json"]] },
        });
      }
    }
  };

  const openConnection = () => {
    if (stopped) return;
    const ws = makeSocket(wsUrl, RELAY_MUX_PROTOCOL, {
      ...options.headers,
      authorization: `Bearer ${options.credential}`,
    });
    socket = ws;
    const localBatcher = new MuxOutboundBatcher((encoded) => {
      if (socket === ws && ws.readyState === 1) {
        sendOnSocket(ws, encoded);
      }
    }, options.batchWindowMs ?? DEFAULT_MUX_BATCH_MS);
    batcher = localBatcher;

    const emitFrame = (frame: MuxFrame) => {
      if (socket !== ws || ws.readyState !== 1) return;
      localBatcher.send(frame);
    };

    ws.onOpen(() => {
      if (stopped || socket !== ws) {
        ws.close(1000, "Stopped");
        return;
      }
      attempts = 0;
      const now = Date.now();
      lastInboundAt = now;
      lastOutboundAt = now;
      if (currentRoutes.length > 0) {
        sendOnSocket(ws, encodeMuxFrame({ type: MuxFrameType.ROUTE_ADVERTISE, candidates: currentRoutes }));
      }
      options.onConnected?.();
    });

    ws.onMessage((raw) => {
      if (stopped || socket !== ws) return;
      lastInboundAt = Date.now();
      if (typeof raw === "string") {
        if (raw === RELAY_MUX_PING) sendOnSocket(ws, RELAY_MUX_PONG);
        return;
      }
      let frame: MuxFrame;
      try {
        frame = decodeMuxFrame(raw);
      } catch {
        ws.close(1008, "Invalid mux frame");
        return;
      }

      switch (frame.type) {
        case MuxFrameType.AUDIENCE_STATE:
          watchers = frame.activeWatchers;
          localBatcher.setActiveWatchers(watchers);
          options.onAudienceChange?.(watchers);
          return;

        case MuxFrameType.OPEN_WS: {
          if (activeStreams.size >= MAX_MUX_STREAMS || activeStreams.has(frame.streamId)) {
            emitFrame({ type: MuxFrameType.CLOSE, streamId: frame.streamId, code: 1013, reason: "Busy" });
            return;
          }
          // Raw Duplex tunnel mode used by self-hosted Node `relay-server` mux bridge
          if (
            frame.init.subprotocol === MUX_TCP_TUNNEL_SUBPROTOCOL &&
            (options.acceptStream !== undefined || options.targetPort !== undefined)
          ) {
            const tunnelEntry = openRawTunnelDuplex(frame.streamId, emitFrame);
            activeStreams.set(frame.streamId, tunnelEntry);
            if (options.acceptStream) {
              try {
                options.acceptStream(tunnelEntry.duplex);
              } catch {
                tunnelEntry.duplex.destroy();
              }
            } else if (options.targetPort !== undefined) {
              const tcp = createConnection({ host: "127.0.0.1", port: options.targetPort });
              bridgeRelayDuplex(tunnelEntry.duplex, tcp);
            }
            return;
          }

          const flow = new MuxStreamFlowControl(frame.streamId, emitFrame);
          const entry: ActiveWsEntry = {
            kind: "ws",
            flow,
            textHandlers: new Set(),
            binaryHandlers: new Set(),
            closeHandlers: new Set(),
            closed: false,
          };
          activeStreams.set(frame.streamId, entry);
          const streamHandle: RelayMuxWsStream = {
            streamId: frame.streamId,
            init: frame.init,
            sendText(text, sendOpts) {
              if (entry.closed) return;
              flow.sendText(text, {
                transientDelta: sendOpts?.transientDelta ?? isTransientDeltaPayload(text),
              });
            },
            sendBinary(data) {
              if (entry.closed) return;
              flow.sendBinary(data);
            },
            close(code = 1000, reason = "") {
              if (entry.closed) return;
              entry.closed = true;
              flow.clear();
              activeStreams.delete(frame.streamId);
              emitFrame({ type: MuxFrameType.CLOSE, streamId: frame.streamId, code, reason: reason.slice(0, 120) });
            },
            onText(fn) {
              entry.textHandlers.add(fn);
            },
            onBinary(fn) {
              entry.binaryHandlers.add(fn);
            },
            onClose(fn) {
              entry.closeHandlers.add(fn);
            },
          };
          if (options.onOpenWs) {
            void Promise.resolve(options.onOpenWs(streamHandle, frame.init)).catch(() => {
              streamHandle.close(1011, "Host stream error");
            });
          } else if (options.targetPort !== undefined) {
            bridgeWsToLoopback(options.targetPort, streamHandle, frame.init);
          } else {
            streamHandle.close(1011, "Unsupported stream mode");
          }
          return;
        }

        case MuxFrameType.OPEN_HTTP: {
          if (activeStreams.size >= MAX_MUX_STREAMS || activeStreams.has(frame.streamId)) {
            emitFrame({
              type: MuxFrameType.HTTP_RESPONSE,
              streamId: frame.streamId,
              fin: true,
              init: { status: 503, headers: [["content-type", "application/json"]] },
            });
            return;
          }
          const entry: ActiveHttpEntry = {
            kind: "http",
            init: frame.init,
            chunks: [],
            totalBytes: 0,
            aborted: false,
          };
          activeStreams.set(frame.streamId, entry);
          if (frame.fin) {
            void dispatchHttpRequest(entry, frame.streamId, emitFrame);
          }
          return;
        }

        case MuxFrameType.DATA_TEXT: {
          const entry = activeStreams.get(frame.streamId);
          if (!entry) return;
          if (entry.kind === "ws" && !entry.closed) {
            entry.flow.onInboundConsumed(new TextEncoder().encode(frame.text).byteLength);
            for (const fn of entry.textHandlers) fn(frame.text);
          } else if (entry.kind === "http" && !entry.aborted) {
            const bytes = new TextEncoder().encode(frame.text);
            entry.chunks.push(bytes);
            entry.totalBytes += bytes.byteLength;
            if (frame.fin) void dispatchHttpRequest(entry, frame.streamId, emitFrame);
          }
          return;
        }

        case MuxFrameType.DATA_BATCH: {
          const entry = activeStreams.get(frame.streamId);
          if (!entry || entry.kind !== "ws" || entry.closed) return;
          let consumed = 0;
          for (const msg of frame.messages) {
            consumed += new TextEncoder().encode(msg).byteLength;
            for (const fn of entry.textHandlers) fn(msg);
          }
          entry.flow.onInboundConsumed(consumed);
          return;
        }

        case MuxFrameType.DATA_BINARY: {
          const entry = activeStreams.get(frame.streamId);
          if (!entry) return;
          if (entry.kind === "ws" && !entry.closed) {
            entry.flow.onInboundConsumed(frame.data.byteLength);
            for (const fn of entry.binaryHandlers) fn(frame.data);
          } else if (entry.kind === "duplex" && !entry.closed) {
            entry.flow.onInboundConsumed(frame.data.byteLength);
            entry.duplex.push(Buffer.from(frame.data));
            if (frame.fin) entry.duplex.push(null);
          } else if (entry.kind === "http" && !entry.aborted) {
            if (entry.totalBytes + frame.data.byteLength > 8 * 1024 * 1024) {
              entry.aborted = true;
              activeStreams.delete(frame.streamId);
              emitFrame({
                type: MuxFrameType.HTTP_RESPONSE,
                streamId: frame.streamId,
                fin: true,
                init: { status: 413, headers: [["content-type", "application/json"]] },
              });
              return;
            }
            entry.chunks.push(frame.data);
            entry.totalBytes += frame.data.byteLength;
            if (frame.fin) void dispatchHttpRequest(entry, frame.streamId, emitFrame);
          }
          return;
        }

        case MuxFrameType.WINDOW_UPDATE: {
          const entry = activeStreams.get(frame.streamId);
          if (entry && (entry.kind === "ws" || entry.kind === "duplex")) {
            try {
              entry.flow.onWindowUpdate(frame.increment);
            } catch {
              ws.close(1008, "Stream window overflow");
            }
          }
          return;
        }

        case MuxFrameType.CLOSE: {
          const entry = activeStreams.get(frame.streamId);
          if (!entry) return;
          activeStreams.delete(frame.streamId);
          if (entry.kind === "ws" && !entry.closed) {
            entry.closed = true;
            entry.flow.clear();
            for (const fn of entry.closeHandlers) fn(frame.code, frame.reason);
          } else if (entry.kind === "duplex" && !entry.closed) {
            entry.closed = true;
            entry.flow.clear();
            entry.duplex.push(null);
            entry.duplex.destroy();
          } else if (entry.kind === "http") {
            entry.aborted = true;
          }
          return;
        }

        default:
          return;
      }
    });

    ws.onError(() => {});

    ws.onClose((code) => {
      localBatcher.dispose();
      cleanupStreams(code || 1006, "Relay mux disconnected");
      if (socket === ws) options.onDisconnected?.(code);
      if (!stopped && socket === ws) {
        attempts += 1;
        const delay = Math.min(30_000, 250 * 2 ** Math.min(attempts, 7)) + Math.floor(Math.random() * 250);
        reconnectTimer = setTimeout(openConnection, delay);
        (reconnectTimer as unknown as { unref?: () => void })?.unref?.();
      }
    });
  };

  const heartbeatInterval = options.heartbeatIntervalMs ?? DEFAULT_MUX_HEARTBEAT_MS;
  const checkCadence = Math.min(15_000, Math.max(1_000, Math.floor(heartbeatInterval / 3)));
  const heartbeat = setInterval(() => {
    if (!socket || socket.readyState !== 1) return;
    const now = Date.now();
    if (now - lastInboundAt > heartbeatInterval * 2 + 15_000) {
      socket.terminate ? socket.terminate() : socket.close(1001, "Heartbeat timeout");
      return;
    }
    // Demand-driven keepalive: skip ping when real traffic already flowed within heartbeatInterval
    if (now - lastOutboundAt < heartbeatInterval && now - lastInboundAt < heartbeatInterval) {
      return;
    }
    try {
      sendOnSocket(socket, RELAY_MUX_PING);
    } catch {
      socket.terminate ? socket.terminate() : socket.close(1001, "Send failed");
    }
  }, checkCadence);
  (heartbeat as unknown as { unref?: () => void })?.unref?.();

  openConnection();

  return {
    connected: () => socket?.readyState === 1,
    activeWatchers: () => watchers,
    advertiseRoutes(candidates) {
      currentRoutes = candidates.map(validateDirectRouteCandidate);
      if (socket?.readyState === 1) {
        sendOnSocket(socket, encodeMuxFrame({ type: MuxFrameType.ROUTE_ADVERTISE, candidates: currentRoutes }));
      }
    },
    close() {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearInterval(heartbeat);
      batcher?.dispose();
      cleanupStreams(1000, "Client closed");
      if (socket) {
        socket.terminate ? socket.terminate() : socket.close(1000, "Client closed");
        socket = undefined;
      }
    },
  };
}
