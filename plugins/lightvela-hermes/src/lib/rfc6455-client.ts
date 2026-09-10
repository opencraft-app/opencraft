import { decodeUtf8, encodeUtf8 } from "./utf8";

const RFC6455_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_FRAME_PAYLOAD_BYTES = 16 * 1024 * 1024;
const CONTROL_OPCODES = new Set([0x8, 0x9, 0xa]);
const VALID_OPCODES = new Set([0x0, 0x1, 0x2, ...CONTROL_OPCODES]);
const PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface Rfc6455Frame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

export interface ClientHandshake {
  bytes: Uint8Array;
  key: string;
}

export interface ClientFrameOptions {
  fin?: boolean;
  maskKey?: Uint8Array;
}

/** Platform-owned SHA-1 primitive used only by the RFC 6455 handshake. */
export type Rfc6455Sha1 = (data: Uint8Array) => Promise<Uint8Array>;

export class Rfc6455ProtocolError extends Error {
  constructor(message: string, readonly closeCode = 1002) {
    super(message);
    this.name = "Rfc6455ProtocolError";
  }
}

const concatBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength === 0) {
    return right.slice();
  }
  if (right.byteLength === 0) {
    return left.slice();
  }
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const normalizeProtocols = (protocols: string | string[]) => {
  const values = typeof protocols === "string" ? [protocols] : protocols;
  const seen = new Set<string>();
  return values.map((value) => {
    const protocol = value;
    if (!PROTOCOL_TOKEN.test(protocol)) {
      throw new DOMException(`Invalid WebSocket subprotocol: ${value}`, "SyntaxError");
    }
    if (seen.has(protocol)) {
      throw new DOMException(`Duplicate WebSocket subprotocol: ${protocol}`, "SyntaxError");
    }
    seen.add(protocol);
    return protocol;
  });
};

const parseResponseHeaders = (head: string) => {
  const lines = head.replace(/\r\n\r\n$/, "").split("\r\n");
  const statusLine = lines.shift() ?? "";
  if (!/^HTTP\/1\.[01]\s+101(?:\s|$)/i.test(statusLine)) {
    throw new Rfc6455ProtocolError(`WebSocket Upgrade returned an invalid status line: ${statusLine}`);
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Rfc6455ProtocolError(`WebSocket Upgrade returned an invalid header: ${line}`);
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
};

const headerHasToken = (value: string | undefined, token: string) =>
  value?.split(",").some((candidate) => candidate.trim().toLowerCase() === token.toLowerCase()) === true;

export const createClientHandshake = (
  url: URL,
  protocols: string | string[],
  origin: string,
  keyBytes?: Uint8Array,
): ClientHandshake => {
  if (url.protocol !== "ws:") {
    throw new DOMException("TatWebSocket only supports ws:// targets", "SyntaxError");
  }
  if (url.username || url.password) {
    throw new DOMException("WebSocket URLs must not contain credentials", "SyntaxError");
  }
  const normalizedProtocols = normalizeProtocols(protocols);
  const nonce = keyBytes?.slice() ?? crypto.getRandomValues(new Uint8Array(16));
  if (nonce.byteLength !== 16) {
    throw new Error("WebSocket handshake keys must contain exactly 16 bytes");
  }
  const key = bytesToBase64(nonce);
  const requestTarget = `${url.pathname || "/"}${url.search}`;
  const lines = [
    `GET ${requestTarget} HTTP/1.1`,
    `Host: ${url.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Origin: ${origin}`,
  ];
  if (normalizedProtocols.length > 0) {
    lines.push(`Sec-WebSocket-Protocol: ${normalizedProtocols.join(", ")}`);
  }
  return {
    bytes: encodeUtf8(`${lines.join("\r\n")}\r\n\r\n`),
    key,
  };
};

export const validateServerHandshake = async (
  head: string | Uint8Array,
  requestKey: string,
  offeredProtocols: string | string[],
  sha1: Rfc6455Sha1 = async (data) => {
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
    return new Uint8Array(digest);
  },
) => {
  const headers = parseResponseHeaders(typeof head === "string" ? head : decodeUtf8(head));
  if (!headerHasToken(headers.get("upgrade"), "websocket")) {
    throw new Rfc6455ProtocolError("WebSocket Upgrade response is missing Upgrade: websocket");
  }
  if (!headerHasToken(headers.get("connection"), "upgrade")) {
    throw new Rfc6455ProtocolError("WebSocket Upgrade response is missing Connection: Upgrade");
  }
  const digest = await sha1(encodeUtf8(`${requestKey}${RFC6455_GUID}`));
  const expectedAccept = bytesToBase64(digest);
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    throw new Rfc6455ProtocolError("WebSocket Upgrade response has an invalid Sec-WebSocket-Accept value");
  }
  if (headers.has("sec-websocket-extensions")) {
    throw new Rfc6455ProtocolError("WebSocket server negotiated an unsupported extension");
  }

  const offered = normalizeProtocols(offeredProtocols);
  const protocol = headers.get("sec-websocket-protocol")?.trim() ?? "";
  if (offered.length > 0 && !protocol) {
    throw new Rfc6455ProtocolError("WebSocket server did not acknowledge the requested subprotocol");
  }
  if (protocol && !offered.includes(protocol)) {
    throw new Rfc6455ProtocolError(`WebSocket server selected an unoffered subprotocol: ${protocol}`);
  }
  return { protocol };
};

const randomMaskKey = () => crypto.getRandomValues(new Uint8Array(4));

export const encodeClientWebSocketFrame = (
  opcode: number,
  payload: Uint8Array,
  options: ClientFrameOptions = {},
) => {
  if (!VALID_OPCODES.has(opcode)) {
    throw new Rfc6455ProtocolError(`Unsupported WebSocket opcode: ${opcode}`);
  }
  const fin = options.fin ?? true;
  if (CONTROL_OPCODES.has(opcode) && (!fin || payload.byteLength > 125)) {
    throw new Rfc6455ProtocolError("WebSocket control frames must be final and at most 125 bytes");
  }
  const maskKey = options.maskKey?.slice() ?? randomMaskKey();
  if (maskKey.byteLength !== 4) {
    throw new Error("WebSocket mask keys must contain exactly 4 bytes");
  }

  const lengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const headerLength = 2 + lengthBytes + maskKey.byteLength;
  const result = new Uint8Array(headerLength + payload.byteLength);
  result[0] = (fin ? 0x80 : 0) | opcode;
  if (lengthBytes === 0) {
    result[1] = 0x80 | payload.byteLength;
  } else if (lengthBytes === 2) {
    result[1] = 0x80 | 126;
    new DataView(result.buffer).setUint16(2, payload.byteLength);
  } else {
    result[1] = 0x80 | 127;
    new DataView(result.buffer).setBigUint64(2, BigInt(payload.byteLength));
  }
  result.set(maskKey, 2 + lengthBytes);
  const payloadOffset = headerLength;
  for (let index = 0; index < payload.byteLength; index += 1) {
    result[payloadOffset + index] = payload[index]! ^ maskKey[index % 4]!;
  }
  return result;
};

export class Rfc6455FrameDecoder {
  private buffer = new Uint8Array();

  constructor(private readonly maxFramePayloadBytes = DEFAULT_MAX_FRAME_PAYLOAD_BYTES) {}

  push(chunk: Uint8Array): Rfc6455Frame[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const frames: Rfc6455Frame[] = [];

    while (this.buffer.byteLength >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (rsv !== 0) {
        throw new Rfc6455ProtocolError("WebSocket frame uses unsupported RSV bits");
      }
      if (!VALID_OPCODES.has(opcode)) {
        throw new Rfc6455ProtocolError(`Unsupported WebSocket opcode: ${opcode}`);
      }
      if (masked) {
        throw new Rfc6455ProtocolError("WebSocket server frames must not be masked");
      }

      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (this.buffer.byteLength < 4) {
          break;
        }
        payloadLength = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint16(2);
        if (payloadLength < 126) {
          throw new Rfc6455ProtocolError("WebSocket frame payload length does not use the minimal encoding");
        }
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.byteLength < 10) {
          break;
        }
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        const high = view.getUint32(2);
        const low = view.getUint32(6);
        if ((high & 0x8000_0000) !== 0) {
          throw new Rfc6455ProtocolError("WebSocket 64-bit payload length has its most significant bit set");
        }
        if (high > 0x1fffff) {
          throw new Rfc6455ProtocolError("WebSocket frame payload length exceeds the safe integer range", 1009);
        }
        payloadLength = high * 0x1_0000_0000 + low;
        if (payloadLength <= 0xffff) {
          throw new Rfc6455ProtocolError("WebSocket frame payload length does not use the minimal encoding");
        }
        headerLength = 10;
      }

      if (CONTROL_OPCODES.has(opcode) && (!fin || payloadLength > 125)) {
        throw new Rfc6455ProtocolError("WebSocket control frames must be final and at most 125 bytes");
      }
      if (payloadLength > this.maxFramePayloadBytes) {
        throw new Rfc6455ProtocolError("WebSocket frame payload exceeds the configured maximum", 1009);
      }
      const frameLength = headerLength + payloadLength;
      if (this.buffer.byteLength < frameLength) {
        break;
      }
      frames.push({
        fin,
        opcode,
        payload: this.buffer.slice(headerLength, frameLength),
      });
      this.buffer = this.buffer.slice(frameLength);
    }

    return frames;
  }
}
