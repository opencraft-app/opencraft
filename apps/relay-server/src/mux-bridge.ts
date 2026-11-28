import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { createHash, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  MAX_MUX_PAYLOAD,
  MAX_MUX_STREAMS,
  MuxFrameType,
  MuxStreamFlowControl,
  RELAY_MUX_PING,
  RELAY_MUX_PONG,
  RELAY_MUX_PROTOCOL,
  decodeMuxFrame,
  encodeMuxFrame,
  parseMachineCredential,
  type MuxFrame,
} from "@opencraft/relay-protocol";

const MUX_TCP_TUNNEL_SUBPROTOCOL = "opencraft-tcp-tunnel.v1";

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

interface MuxPeerStream {
  readonly flow: MuxStreamFlowControl;
  duplex: Duplex;
  closed: boolean;
}

interface MuxPeerConnection {
  readonly instanceId: string;
  readonly socket: WebSocket;
  readonly streams: Map<number, MuxPeerStream>;
  nextStreamId: number;
  alive: boolean;
}

/**
 * Node-side `mux.v2` upgrade bridge for self-hosted `opencraft-relay`.
 * Multiplexes HTTP and WebSocket streams as flow-controlled virtual `Duplex`
 * channels over a single outbound WebSocket from the Host (`0` extra handshakes).
 */
export class NodeMuxRelayBridge {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MUX_PAYLOAD + 1024, perMessageDeflate: false });
  readonly #peers = new Map<string, MuxPeerConnection>();

  has(instanceId: string): boolean {
    const peer = this.#peers.get(instanceId);
    return Boolean(peer && peer.socket.readyState === WebSocket.OPEN);
  }

  activeStreams(): number {
    let count = 0;
    for (const peer of this.#peers.values()) count += peer.streams.size;
    return count;
  }

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    resolveInstanceId: (secret: string, machineId?: string) => string | undefined,
  ): boolean {
    if (req.headers["sec-websocket-protocol"] !== RELAY_MUX_PROTOCOL || req.headers.origin) return false;
    const rawAuth =
      typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : "";
    const parsedOcm = parseMachineCredential(rawAuth);
    const secret = parsedOcm ? parsedOcm.secret : /^[A-Za-z0-9_-]{43}$/u.test(rawAuth) ? rawAuth : "";
    if (!secret) return false;
    const instanceId = resolveInstanceId(secret, parsedOcm?.machineId);
    if (!instanceId) return false;

    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = this.#peers.get(instanceId);
      if (previous) this.#retire(previous);
      const peer: MuxPeerConnection = {
        instanceId,
        socket: ws,
        streams: new Map(),
        nextStreamId: 1,
        alive: true,
      };
      this.#peers.set(instanceId, peer);

      ws.on("pong", () => {
        peer.alive = true;
      });
      ws.on("error", () => {});
      ws.on("message", (raw, isBinary) => {
        peer.alive = true;
        if (!isBinary) {
          const text = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
          if (text === RELAY_MUX_PING) ws.send(RELAY_MUX_PONG);
          return;
        }
        const bytes =
          raw instanceof Uint8Array
            ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
            : Array.isArray(raw)
              ? new Uint8Array(Buffer.concat(raw))
              : new Uint8Array(raw as ArrayBuffer);
        let frame: MuxFrame;
        try {
          frame = decodeMuxFrame(bytes);
        } catch {
          ws.close(1008, "Invalid mux frame");
          return;
        }
        this.#onFrame(peer, frame);
      });
      ws.once("close", () => {
        this.#retire(peer);
      });
    });
    return true;
  }

  openDuplex(instanceId: string, signal: AbortSignal): Promise<Duplex> {
    const peer = this.#peers.get(instanceId);
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Instance unavailable or busy"));
    }
    if (peer.streams.size >= MAX_MUX_STREAMS) {
      return Promise.reject(new Error("Instance unavailable or busy"));
    }
    if (signal.aborted) return Promise.reject(new Error("Client disconnected"));

    const streamId = peer.nextStreamId;
    peer.nextStreamId = peer.nextStreamId >= 0x7fff_fffe ? 1 : peer.nextStreamId + 1;
    const emit = (frame: MuxFrame) => {
      if (peer.socket.readyState === WebSocket.OPEN) {
        peer.socket.send(encodeMuxFrame(frame));
      }
    };
    const flow = new MuxStreamFlowControl(streamId, emit);
    const entry: MuxPeerStream = { flow, duplex: undefined as never, closed: false };
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
        if (!entry.closed) {
          entry.closed = true;
          peer.streams.delete(streamId);
          emit({ type: MuxFrameType.CLOSE, streamId, code: 1000, reason: "" });
        }
        callback();
      },
      destroy(err, callback) {
        if (!entry.closed) {
          entry.closed = true;
          flow.clear();
          peer.streams.delete(streamId);
          emit({ type: MuxFrameType.CLOSE, streamId, code: err ? 1011 : 1000, reason: "" });
        }
        callback(err);
      },
    });
    entry.duplex = duplex;
    peer.streams.set(streamId, entry);
    signal.addEventListener("abort", () => duplex.destroy(), { once: true });

    emit({
      type: MuxFrameType.OPEN_WS,
      streamId,
      init: {
        path: "/",
        subprotocol: MUX_TCP_TUNNEL_SUBPROTOCOL,
        actorId: "relay-tunnel",
        scope: { role: "owner", allowExecution: true, grantEpoch: 1 },
      },
    });

    return Promise.resolve(duplex);
  }

  heartbeat(): void {
    for (const peer of this.#peers.values()) {
      if (!peer.alive) this.#retire(peer);
      else {
        peer.alive = false;
        peer.socket.ping();
      }
    }
  }

  close(): void {
    for (const peer of this.#peers.values()) this.#retire(peer);
    this.#wss.close();
  }

  #onFrame(peer: MuxPeerConnection, frame: MuxFrame): void {
    switch (frame.type) {
      case MuxFrameType.DATA_BINARY: {
        const entry = peer.streams.get(frame.streamId);
        if (!entry || entry.closed) return;
        entry.flow.onInboundConsumed(frame.data.byteLength);
        entry.duplex.push(Buffer.from(frame.data));
        if (frame.fin) entry.duplex.push(null);
        return;
      }
      case MuxFrameType.WINDOW_UPDATE: {
        const entry = peer.streams.get(frame.streamId);
        if (!entry || entry.closed) return;
        try {
          entry.flow.onWindowUpdate(frame.increment);
        } catch {
          peer.socket.close(1008, "Stream window overflow");
        }
        return;
      }
      case MuxFrameType.CLOSE: {
        const entry = peer.streams.get(frame.streamId);
        if (!entry) return;
        peer.streams.delete(frame.streamId);
        if (!entry.closed) {
          entry.closed = true;
          entry.flow.clear();
          entry.duplex.push(null);
          entry.duplex.destroy();
        }
        return;
      }
      default:
        return;
    }
  }

  #retire(peer: MuxPeerConnection): void {
    if (this.#peers.get(peer.instanceId) === peer) this.#peers.delete(peer.instanceId);
    peer.socket.terminate();
    for (const entry of peer.streams.values()) {
      entry.closed = true;
      entry.flow.clear();
      entry.duplex.destroy();
    }
    peer.streams.clear();
  }
}

export function matchRouteSecret(
  routes: Iterable<{ instanceId: string; credential: string }>,
  secret: string,
): string | undefined {
  for (const route of routes) {
    if (safeEqual(route.credential, secret)) return route.instanceId;
  }
  return undefined;
}
