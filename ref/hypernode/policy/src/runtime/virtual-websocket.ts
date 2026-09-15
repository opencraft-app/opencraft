import { WebSocketPresentationQueue, presentationKeyFor } from "../services/websocket-presentation-queue.ts";
import { asciiBytes, asciiText, base64Encode, concatBytes, utf8Decode, utf8Encode } from "./bytes.ts";

type ByteArray = Uint8Array<ArrayBufferLike>;

interface VirtualWebSocketEventMap {
  message: string;
  binary: ByteArray;
  close: ByteArray;
  "presentation-drained": string;
  poll: undefined;
}

type Listener = (value: VirtualWebSocketEventMap[keyof VirtualWebSocketEventMap]) => void;

export interface VirtualWebSocketRouteMetadata {
  path: string;
  target: string;
  sessionId: string;
  [key: string]: unknown;
}

export type VirtualWebSocketRoute = (
  socket: VirtualWebSocket,
  metadata: VirtualWebSocketRouteMetadata,
) => void;

interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: ByteArray;
}

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

function sha1(bytes: Uint8Array): Uint8Array {
  const message = Array.from(bytes);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) message.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) message.push((low >>> shift) & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Int32Array(80);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] = ((message[at] ?? 0) << 24) |
        ((message[at + 1] ?? 0) << 16) |
        ((message[at + 2] ?? 0) << 8) |
        (message[at + 3] ?? 0);
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        (words[index - 3] ?? 0) ^ (words[index - 8] ?? 0) ^
          (words[index - 14] ?? 0) ^ (words[index - 16] ?? 0),
        1,
      );
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + (words[index] ?? 0)) | 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const digest: number[] = [];
  for (const value of [h0, h1, h2, h3, h4]) {
    for (let shift = 24; shift >= 0; shift -= 8) digest.push((value >>> shift) & 0xff);
  }
  return Uint8Array.from(digest);
}

function headerEnd(bytes: Uint8Array): number {
  for (let index = 3; index < bytes.length; index += 1) {
    if (bytes[index - 3] === 13 && bytes[index - 2] === 10 && bytes[index - 1] === 13 && bytes[index] === 10) {
      return index + 1;
    }
  }
  return -1;
}

function webSocketFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const header = [0x80 | opcode];
  if (payload.length < 126) header.push(payload.length);
  else if (payload.length <= 0xffff) header.push(126, (payload.length >>> 8) & 0xff, payload.length & 0xff);
  else {
    header.push(
      127, 0, 0, 0, 0,
      (payload.length >>> 24) & 0xff,
      (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff,
      payload.length & 0xff,
    );
  }
  return concatBytes(Uint8Array.from(header), payload);
}

function notifyHostOutput(): void {
  globalThis.hostEvents?.notify?.();
}

export class VirtualWebSocket {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly outbound = new WebSocketPresentationQueue({
    onPresentationDrained: (presentationKey: string) => {
      this.emit("presentation-drained", presentationKey);
    },
  });
  private sensitiveOutbound = false;

  on<Key extends keyof VirtualWebSocketEventMap>(
    type: Key,
    listener: (value: VirtualWebSocketEventMap[Key]) => void,
  ): this {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as Listener);
    this.listeners.set(type, listeners);
    return this;
  }

  get pendingFrames(): number {
    return this.outbound.length;
  }

  private emit(type: string, value?: string | ByteArray): void {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }

  send(value: unknown, sensitive = false): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text == null) throw new Error("WebSocket messages must be JSON serializable");
    let presentationKey: string | null = null;
    if (typeof value === "object" && value != null && "method" in value && value.method === "item/agentMessage/delta") {
      const params = "params" in value && typeof value.params === "object" && value.params != null ? value.params : {};
      presentationKey = presentationKeyFor(params);
    }
    this.outbound.push(webSocketFrame(1, utf8Encode(text)), presentationKey);
    this.sensitiveOutbound ||= sensitive;
    notifyHostOutput();
  }

  pong(bytes: ByteArray): void {
    this.outbound.push(webSocketFrame(10, bytes));
    notifyHostOutput();
  }

  close(bytes: ByteArray = new Uint8Array()): void {
    this.outbound.push(webSocketFrame(8, bytes));
    notifyHostOutput();
  }

  drain(limit = 512 * 1024): ByteArray {
    if (this.outbound.length === 0) return new Uint8Array();
    const chunks = this.outbound.drain(limit);
    if (this.outbound.length > 0) notifyHostOutput();
    return concatBytes(...chunks);
  }

  hasPendingPresentation(presentationKey: string): boolean {
    return this.outbound.hasPendingPresentation(presentationKey);
  }

  consumeSensitivity(): boolean {
    const sensitive = this.sensitiveOutbound;
    if (this.outbound.length === 0) this.sensitiveOutbound = false;
    return sensitive;
  }

  dispatch<Key extends keyof VirtualWebSocketEventMap>(
    type: Key,
    ...values: VirtualWebSocketEventMap[Key] extends undefined ? [] : [VirtualWebSocketEventMap[Key]]
  ): void {
    this.emit(type, values[0]);
  }
}

export class VirtualWebSocketConnection {
  private phase: "http" | "websocket" | "closed" = "http";
  private input: ByteArray = new Uint8Array();
  private socket: VirtualWebSocket | null = null;
  private fragment: ByteArray = new Uint8Array();
  private fragmentOpcode = 0;
  lastOutputSensitive = false;

  private readonly server: VirtualWebSocketServer;
  private readonly sessionId: string;
  private readonly metadata: Record<string, unknown>;

  constructor(server: VirtualWebSocketServer, sessionId: string, metadata: Record<string, unknown> = {}) {
    this.server = server;
    this.sessionId = sessionId;
    this.metadata = metadata;
  }

  feed(bytes: ByteArray): ByteArray {
    this.lastOutputSensitive = false;
    this.input = concatBytes(this.input, bytes);
    const output: ByteArray[] = [];
    if (this.phase === "http") {
      const end = headerEnd(this.input);
      if (end < 0) return new Uint8Array();
      const request = asciiText(this.input.slice(0, end));
      this.input = this.input.slice(end);
      const requestLine = request.match(/^GET\s+(\S+)\s+HTTP\/1\.[01]\r?$/m);
      const key = request.match(/^Sec-WebSocket-Key:\s*(.+?)\r?$/im)?.[1];
      const target = requestLine?.[1] ?? "";
      const path = target.split("?", 1)[0] ?? "";
      const route = requestLine == null ? undefined : this.server.routeFor(path);
      if (key == null || route == null) return utf8Encode("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      const accept = base64Encode(sha1(asciiBytes(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)));
      output.push(utf8Encode(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      ));
      this.socket = new VirtualWebSocket();
      this.phase = "websocket";
      route(this.socket, { path, target, sessionId: this.sessionId, ...this.metadata });
    }
    while (this.phase === "websocket") {
      const frame = this.readFrame();
      if (frame == null) break;
      this.handleFrame(frame);
    }
    if (this.socket != null) {
      output.push(this.socket.drain());
      this.lastOutputSensitive = this.socket.consumeSensitivity();
    }
    return concatBytes(...output);
  }

  poll(): ByteArray {
    this.lastOutputSensitive = false;
    if (this.socket == null || this.phase !== "websocket") return new Uint8Array();
    this.socket.dispatch("poll");
    const output = this.socket.drain();
    this.lastOutputSensitive = this.socket.consumeSensitivity();
    return output;
  }

  private readFrame(): WebSocketFrame | null {
    if (this.input.length < 2) return null;
    const first = this.input[0] ?? 0;
    const second = this.input[1] ?? 0;
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (this.input.length < 4) return null;
      length = ((this.input[2] ?? 0) << 8) | (this.input[3] ?? 0);
      offset = 4;
    } else if (length === 127) {
      if (this.input.length < 10) return null;
      const high = this.input.slice(2, 6).reduce((value, byte) => value * 256 + byte, 0);
      const low = this.input.slice(6, 10).reduce((value, byte) => value * 256 + byte, 0);
      if (high !== 0) throw new Error("virtual WebSocket frame is too large");
      length = low;
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    if (this.input.length < offset + maskLength + length) return null;
    const mask = masked ? this.input.slice(offset, offset + 4) : null;
    offset += maskLength;
    const payload = this.input.slice(offset, offset + length);
    this.input = this.input.slice(offset + length);
    if (mask != null) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
    }
    return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload };
  }

  private handleFrame(frame: WebSocketFrame): void {
    const socket = this.socket;
    if (socket == null) return;
    if (frame.opcode === 8) {
      socket.dispatch("close", frame.payload);
      socket.close(frame.payload);
      this.phase = "closed";
      return;
    }
    if (frame.opcode === 9) {
      socket.pong(frame.payload);
      return;
    }
    if (frame.opcode === 10) return;
    if (frame.opcode === 0) this.fragment = concatBytes(this.fragment, frame.payload);
    else {
      this.fragmentOpcode = frame.opcode;
      this.fragment = frame.payload;
    }
    if (!frame.fin) return;
    const payload = this.fragment;
    this.fragment = new Uint8Array();
    const opcode = this.fragmentOpcode;
    this.fragmentOpcode = 0;
    if (opcode === 1) socket.dispatch("message", utf8Decode(payload));
    else if (opcode === 2) socket.dispatch("binary", payload);
  }

  close(): void {
    this.socket?.dispatch("close", new Uint8Array());
    this.phase = "closed";
  }
}

export class VirtualWebSocketServer {
  private readonly routes = new Map<string, VirtualWebSocketRoute>();

  route(path: string, handler: VirtualWebSocketRoute): this {
    this.routes.set(path, handler);
    return this;
  }

  routeFor(path: string): VirtualWebSocketRoute | undefined {
    return this.routes.get(path);
  }

  connect(sessionId: string, metadata: Record<string, unknown> = {}): VirtualWebSocketConnection {
    return new VirtualWebSocketConnection(this, sessionId, metadata);
  }
}
