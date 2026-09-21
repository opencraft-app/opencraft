import {
  Rfc6455FrameDecoder,
  Rfc6455ProtocolError,
  createClientHandshake,
  encodeClientWebSocketFrame,
  validateServerHandshake,
  type ClientHandshake,
  type Rfc6455Sha1,
  type Rfc6455Frame,
} from "./rfc6455-client";
import type { TencentTatProxyConnection, TencentTatSessionMultiplexer } from "./tencent-tat-session-multiplexer";
import { decodeUtf8, encodeUtf8 } from "./utf8";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"]);

type WebSocketProtocols = string | string[];
type SocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

export interface TatWebSocketOptions {
  closeTimeoutMs?: number;
  maxMessageBytes?: number;
  onError?: (error: Error) => void;
  origin?: string;
  /** Platform crypto boundary; React Native supplies this via expo-crypto. */
  sha1?: Rfc6455Sha1;
}

const createCompatibleCloseEvent = (code: number, reason: string, wasClean: boolean): CloseEvent => {
  const CloseEventConstructor = globalThis.CloseEvent;
  if (typeof CloseEventConstructor === "function") {
    return new CloseEventConstructor("close", { code, reason, wasClean });
  }

  // React Native implements EventTarget/Event but does not expose the browser's
  // CloseEvent constructor. Keep the WebSocket-facing contract without making
  // the transport lifecycle depend on a DOM-only global.
  const event = new Event("close") as CloseEvent;
  Object.defineProperties(event, {
    code: { configurable: true, enumerable: true, value: code },
    reason: { configurable: true, enumerable: true, value: reason },
    wasClean: { configurable: true, enumerable: true, value: wasClean },
  });
  return event;
};

const createCompatibleErrorEvent = (error: Error): Event => {
  const event = new Event("error") as Event & { readonly error?: Error; readonly message?: string };
  Object.defineProperties(event, {
    error: { configurable: true, enumerable: true, value: error },
    message: { configurable: true, enumerable: true, value: error.message },
  });
  return event;
};

const createCompatibleMessageEvent = (
  data: string | Blob | ArrayBuffer,
  origin: string,
): MessageEvent => {
  const MessageEventConstructor = globalThis.MessageEvent;
  if (typeof MessageEventConstructor === "function") {
    return new MessageEventConstructor("message", { data, origin });
  }

  // React Native exposes EventTarget/Event but not MessageEvent. Construct the
  // smallest standards-compatible event at the platform boundary so every
  // consumer can continue to speak the ordinary WebSocket contract.
  const event = new Event("message") as MessageEvent;
  Object.defineProperties(event, {
    data: { configurable: true, enumerable: true, value: data },
    origin: { configurable: true, enumerable: true, value: origin },
    lastEventId: { configurable: true, enumerable: true, value: "" },
    ports: { configurable: true, enumerable: true, value: [] },
    source: { configurable: true, enumerable: true, value: null },
  });
  return event;
};

const concatBytes = (chunks: Uint8Array[]) => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const indexOfHeaderEnd = (bytes: Uint8Array) => {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index;
    }
  }
  return -1;
};

const normalizeProtocols = (protocols?: WebSocketProtocols) =>
  protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];

const isValidReceivedCloseCode = (code: number) =>
  code === 1000
  || code === 1001
  || code === 1002
  || code === 1003
  || (code >= 1007 && code <= 1014)
  || (code >= 3000 && code <= 4999);

const isValidApplicationCloseCode = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

const encodeClosePayload = (code: number, reasonBytes: Uint8Array = new Uint8Array()) => {
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  new DataView(payload.buffer).setUint16(0, code);
  payload.set(reasonBytes, 2);
  return payload;
};

const applicationClosePayload = (code?: number, reason = "") => {
  if (code === undefined) {
    if (reason) {
      throw new DOMException("A WebSocket close reason requires a close code", "InvalidAccessError");
    }
    return new Uint8Array();
  }
  if (!isValidApplicationCloseCode(code)) {
    throw new DOMException(`Invalid WebSocket close code: ${code}`, "InvalidAccessError");
  }
  const reasonBytes = encodeUtf8(reason);
  if (reasonBytes.byteLength > 123) {
    throw new DOMException("WebSocket close reason exceeds 123 UTF-8 bytes", "SyntaxError");
  }
  return encodeClosePayload(code, reasonBytes);
};

const parseClosePayload = (payload: Uint8Array) => {
  if (payload.byteLength === 0) {
    return { code: 1005, reason: "" };
  }
  if (payload.byteLength === 1) {
    throw new Rfc6455ProtocolError("WebSocket close frame has a one-byte payload");
  }
  const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0);
  if (!isValidReceivedCloseCode(code)) {
    throw new Rfc6455ProtocolError(`WebSocket peer sent an invalid close code: ${code}`);
  }
  try {
    return { code, reason: decodeUtf8(payload.slice(2), { fatal: true }) };
  } catch {
    throw new Rfc6455ProtocolError("WebSocket close reason is not valid UTF-8", 1007);
  }
};

const prepareData = (data: SocketData) => {
  if (typeof data === "string") {
    const payload = encodeUtf8(data);
    return { size: payload.byteLength, materialize: async () => ({ opcode: 0x1, payload }) };
  }
  if (data instanceof Blob) {
    return {
      size: data.size,
      materialize: async () => ({ opcode: 0x2, payload: new Uint8Array(await data.arrayBuffer()) }),
    };
  }
  if (ArrayBuffer.isView(data)) {
    const payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    return {
      size: payload.byteLength,
      materialize: async () => ({ opcode: 0x2, payload }),
    };
  }
  const payload = new Uint8Array(data).slice();
  return { size: payload.byteLength, materialize: async () => ({ opcode: 0x2, payload }) };
};

const asSocketData = (data: unknown): SocketData => {
  if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data;
  }
  throw new TypeError("TatWebSocket.send() accepts strings, Blob, ArrayBuffer, or ArrayBufferView values");
};

export const createTatWebSocketConstructor = (
  proxyClient: TencentTatSessionMultiplexer,
  options: TatWebSocketOptions = {},
): typeof WebSocket => {
  const origin = options.origin ?? window.location.origin;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

  class TatWebSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readonly url: string;
    readonly extensions = "";
    protocol = "";
    readyState = CONNECTING;
    bufferedAmount = 0;
    private currentBinaryType: BinaryType = "blob";
    private openHandler: ((this: WebSocket, event: Event) => unknown) | null = null;
    private messageHandler: ((this: WebSocket, event: MessageEvent) => unknown) | null = null;
    private errorHandler: ((this: WebSocket, event: Event) => unknown) | null = null;
    private closeHandler: ((this: WebSocket, event: CloseEvent) => unknown) | null = null;

    private readonly target: URL;
    private readonly offeredProtocols: string[];
    private readonly handshake: ClientHandshake;
    private readonly decoder = new Rfc6455FrameDecoder(maxMessageBytes);
    private connection: TencentTatProxyConnection | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private finalized = false;
    private closeSent = false;
    private closeTimer: number | null = null;
    private fragmentOpcode: 0x1 | 0x2 | null = null;
    private fragmentChunks: Uint8Array[] = [];
    private fragmentBytes = 0;
    private sendQueue = Promise.resolve();

    constructor(url: string | URL, protocols?: WebSocketProtocols) {
      super();
      this.target = new URL(String(url));
      if (this.target.hash) {
        throw new DOMException("WebSocket URLs must not contain fragments", "SyntaxError");
      }
      if (!LOOPBACK_HOSTS.has(this.target.hostname)) {
        throw new DOMException(`TatWebSocket target must be loopback, got ${this.target.hostname}`, "SecurityError");
      }
      this.offeredProtocols = normalizeProtocols(protocols);
      this.handshake = createClientHandshake(this.target, this.offeredProtocols, origin);
      this.url = this.target.toString();
      void this.run();
    }

    get binaryType() {
      return this.currentBinaryType;
    }

    set binaryType(value: BinaryType) {
      if (value !== "blob" && value !== "arraybuffer") {
        throw new TypeError(`Invalid WebSocket binaryType: ${String(value)}`);
      }
      this.currentBinaryType = value;
    }

    get onopen() {
      return this.openHandler;
    }

    set onopen(value) {
      this.replaceEventHandler("open", this.openHandler, value);
      this.openHandler = value;
    }

    get onmessage() {
      return this.messageHandler;
    }

    set onmessage(value) {
      this.replaceEventHandler("message", this.messageHandler, value);
      this.messageHandler = value;
    }

    get onerror() {
      return this.errorHandler;
    }

    set onerror(value) {
      this.replaceEventHandler("error", this.errorHandler, value);
      this.errorHandler = value;
    }

    get onclose() {
      return this.closeHandler;
    }

    set onclose(value) {
      this.replaceEventHandler("close", this.closeHandler, value);
      this.closeHandler = value;
    }

    send(data: SocketData) {
      if (this.readyState === CONNECTING) {
        throw new DOMException("TatWebSocket is still connecting", "InvalidStateError");
      }
      const queued = prepareData(asSocketData(data));
      const size = queued.size;
      if (this.readyState !== OPEN) {
        this.bufferedAmount += size;
        return;
      }
      this.bufferedAmount += size;
      this.sendQueue = this.sendQueue
        .then(async () => {
          const message = await queued.materialize();
          if (this.finalized || !this.connection?.write(encodeClientWebSocketFrame(message.opcode, message.payload))) {
            throw new Error("TAT proxy connection closed while sending a WebSocket message");
          }
        })
        .catch((error: unknown) => {
          this.fail(error);
        })
        .finally(() => {
          this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
        });
    }

    close(code?: number, reason = "") {
      const payload = applicationClosePayload(code, reason);
      if (this.readyState === CLOSED || this.readyState === CLOSING) {
        return;
      }
      if (this.readyState === CONNECTING) {
        this.readyState = CLOSING;
        this.finalizeClose(1006, "", false);
        return;
      }
      this.readyState = CLOSING;
      this.closeSent = true;
      this.sendQueue = this.sendQueue
        .then(() => {
          if (!this.finalized && !this.connection?.write(encodeClientWebSocketFrame(0x8, payload))) {
            throw new Error("TAT proxy connection closed during the WebSocket close handshake");
          }
          this.scheduleCloseTimeout();
        })
        .catch((error: unknown) => {
          this.fail(error);
        });
    }

    private async run() {
      try {
        this.connection = await proxyClient.openProxy({
          ip: this.target.hostname,
          port: this.target.port || "80",
        });
        if (this.readyState !== CONNECTING) {
          this.connection.close();
          return;
        }
        this.reader = this.connection.readable.getReader();
        if (!this.connection.write(this.handshake.bytes)) {
          throw new Error("TAT proxy connection rejected the WebSocket handshake");
        }

        const bodyPrefix = await this.readHandshake();
        const negotiated = await validateServerHandshake(
          this.handshakeHead,
          this.handshake.key,
          this.offeredProtocols,
          options.sha1,
        );
        if (this.finalized) {
          return;
        }
        this.protocol = negotiated.protocol;
        this.readyState = OPEN;
        this.emit(new Event("open"));
        // Native WebSocket dispatches `open` and the first `message` as
        // separate event-loop tasks. The TAT tunnel can deliver the HTTP 101
        // and gateway.ready frame in one chunk; yielding here preserves the
        // browser contract so an `await open` continuation can attach its
        // message listener before buffered frames are published.
        await Promise.resolve();
        if (bodyPrefix.byteLength > 0) {
          this.processFrames(this.decoder.push(bodyPrefix));
        }

        while (!this.finalized) {
          const result = await this.reader.read();
          if (result.done) {
            if (!this.finalized) {
              this.fail(new Error("TAT proxy channel closed without a WebSocket close frame"));
            }
            return;
          }
          this.processFrames(this.decoder.push(result.value));
        }
      } catch (error) {
        this.fail(error);
      }
    }

    private handshakeHead = new Uint8Array();

    private async readHandshake() {
      let buffered = new Uint8Array();
      while (true) {
        const result = await this.reader!.read();
        if (result.done) {
          throw new Error("TAT proxy channel closed during the WebSocket handshake");
        }
        buffered = concatBytes([buffered, result.value]);
        const headerEnd = indexOfHeaderEnd(buffered);
        if (headerEnd >= 0) {
          this.handshakeHead = buffered.slice(0, headerEnd);
          return buffered.slice(headerEnd + 4);
        }
        if (buffered.byteLength > MAX_HANDSHAKE_BYTES) {
          throw new Rfc6455ProtocolError("WebSocket Upgrade response headers exceed 64 KiB");
        }
      }
    }

    private processFrames(frames: Rfc6455Frame[]) {
      for (const frame of frames) {
        if (this.finalized) {
          return;
        }
        this.processFrame(frame);
      }
    }

    private processFrame(frame: Rfc6455Frame) {
      switch (frame.opcode) {
        case 0x0:
          if (this.fragmentOpcode === null) {
            throw new Rfc6455ProtocolError("WebSocket continuation frame has no initial data frame");
          }
          this.addFragment(frame.payload);
          if (frame.fin) {
            const opcode = this.fragmentOpcode;
            const payload = concatBytes(this.fragmentChunks);
            this.clearFragments();
            this.emitMessage(opcode, payload);
          }
          return;
        case 0x1:
        case 0x2:
          if (this.fragmentOpcode !== null) {
            throw new Rfc6455ProtocolError("WebSocket received a new data frame before fragmented message completion");
          }
          if (frame.fin) {
            this.emitMessage(frame.opcode, frame.payload);
          } else {
            this.fragmentOpcode = frame.opcode;
            this.addFragment(frame.payload);
          }
          return;
        case 0x8:
          this.handlePeerClose(frame.payload);
          return;
        case 0x9:
          if (!this.connection?.write(encodeClientWebSocketFrame(0xa, frame.payload))) {
            throw new Error("TAT proxy connection closed while replying to WebSocket Ping");
          }
          return;
        case 0xa:
          return;
        default:
          throw new Rfc6455ProtocolError(`Unsupported WebSocket opcode: ${frame.opcode}`);
      }
    }

    private addFragment(payload: Uint8Array) {
      this.fragmentBytes += payload.byteLength;
      if (this.fragmentBytes > maxMessageBytes) {
        throw new Rfc6455ProtocolError("WebSocket message exceeds the configured maximum", 1009);
      }
      this.fragmentChunks.push(payload);
    }

    private clearFragments() {
      this.fragmentOpcode = null;
      this.fragmentChunks = [];
      this.fragmentBytes = 0;
    }

    private emitMessage(opcode: 0x1 | 0x2, payload: Uint8Array) {
      let data: string | Blob | ArrayBuffer;
      if (opcode === 0x1) {
        try {
          data = decodeUtf8(payload, { fatal: true });
        } catch {
          throw new Rfc6455ProtocolError("WebSocket text message is not valid UTF-8", 1007);
        }
      } else if (this.binaryType === "arraybuffer") {
        data = payload.slice().buffer;
      } else {
        data = new Blob([payload.slice()]);
      }
      this.emit(createCompatibleMessageEvent(data, this.target.origin));
    }

    private handlePeerClose(payload: Uint8Array) {
      const close = parseClosePayload(payload);
      if (!this.closeSent) {
        this.closeSent = true;
        this.readyState = CLOSING;
        this.connection?.write(encodeClientWebSocketFrame(0x8, payload));
      }
      this.finalizeClose(close.code, close.reason, true);
    }

    private fail(error: unknown) {
      if (this.finalized) {
        return;
      }
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const protocolError = normalizedError instanceof Rfc6455ProtocolError ? normalizedError : null;
      if (protocolError && this.readyState === OPEN && this.connection) {
        try {
          this.connection.write(encodeClientWebSocketFrame(0x8, encodeClosePayload(protocolError.closeCode)));
        } catch {
          // The following abnormal close remains authoritative.
        }
      }
      options.onError?.(normalizedError);
      this.emit(createCompatibleErrorEvent(normalizedError));
      this.finalizeClose(1006, "", false);
    }

    private finalizeClose(code: number, reason: string, wasClean: boolean) {
      if (this.finalized) {
        return;
      }
      this.finalized = true;
      this.readyState = CLOSED;
      if (this.closeTimer !== null) {
        window.clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      try {
        this.reader?.releaseLock();
      } catch {
        // A just-settled read may retain the lock until its microtask completes.
      }
      try {
        this.connection?.close();
      } catch {
        // The raw transport may already be closed by the peer.
      }
      this.emit(createCompatibleCloseEvent(code, reason, wasClean));
    }

    private emit(event: Event) {
      this.dispatchEvent(event);
    }

    private replaceEventHandler<TEvent extends Event>(
      type: string,
      previous: ((this: WebSocket, event: TEvent) => unknown) | null,
      next: ((this: WebSocket, event: TEvent) => unknown) | null,
    ) {
      if (previous) {
        this.removeEventListener(type, previous as EventListener);
      }
      if (next) {
        this.addEventListener(type, next as EventListener);
      }
    }

    private scheduleCloseTimeout() {
      if (this.closeTimer !== null || closeTimeoutMs <= 0) {
        return;
      }
      this.closeTimer = window.setTimeout(() => {
        this.fail(new Error("Timed out waiting for the WebSocket close handshake."));
      }, closeTimeoutMs);
    }
  }

  Object.setPrototypeOf(TatWebSocket.prototype, WebSocket.prototype);
  return TatWebSocket as unknown as typeof WebSocket;
};
