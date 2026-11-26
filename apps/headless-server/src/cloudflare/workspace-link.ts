// Container endpoint adapters for the WorkspaceHost Durable Object
// (gateway-split §4.2 "引擎与资源通道", workspace-host-split §3.3). A Node
// Gateway reaches an owner inside a workspace container through a private local
// listener (`createSandboxEndpointListener`) and its unchanged Node clients
// (`node:http` over a Unix socket, `ws`). A Durable Object has no sockets: it
// holds the endpoint connection itself (`WorkspaceRuntime.connect`, one
// attached relay process per connection) and speaks the same protocols over
// that byte stream — one HTTP/1.1 exchange per connection, or one RFC 6455
// client WebSocket. The owners in the container are unchanged.
//
// No replay: a connection that ends early fails its request; the caller
// decides (an unknown outcome stays unknown, as with the Node clients).
import { isJsonRpcFailure, isJsonRpcSuccess, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { SandboxFault, type SandboxEndpointConnection } from "@opencraft/sandbox";

/** Opens one connection to a workspace endpoint; bytes from the owner go to `onData`. */
export type EndpointDial = (onData: (data: Uint8Array) => void) => Promise<SandboxEndpointConnection>;

export interface EndpointHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Lowercase names; the last value of a repeated header. */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
  text(): string;
  json(): unknown;
}

export interface EndpointHttpOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_LIMIT = 64 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const unavailable = (message: string) => new SandboxFault("SANDBOX_UNAVAILABLE", message);

/** A request interrupted after dialing, distinct from invalid framing or lost placement. */
export class EndpointHttpInterrupted extends SandboxFault {
  constructor(message: string) {
    super("SANDBOX_UNAVAILABLE", message);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.byteLength; i++)
    if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) return i + 1;
  return -1;
}

function requestHead(method: string, path: string, headers: Readonly<Record<string, string>>): string {
  if (!TOKEN.test(method) || !path.startsWith("/") || /[\s\0]/u.test(path))
    throw unavailable("Invalid endpoint request");
  let head = `${method} ${path} HTTP/1.1\r\nhost: workspace\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (!TOKEN.test(name) || /[\r\n\0]/u.test(value)) throw unavailable("Invalid endpoint request header");
    head += `${name}: ${value}\r\n`;
  }
  return head;
}

/** Parses a response head; null until the whole head arrived. */
function parseHead(bytes: Uint8Array): { status: number; headers: Map<string, string>; size: number } | null {
  const end = indexOfHeaderEnd(bytes);
  if (end < 0) {
    if (bytes.byteLength > HEADER_LIMIT) throw unavailable("Endpoint response head exceeds its budget");
    return null;
  }
  const lines = decoder.decode(bytes.subarray(0, end - 4)).split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/u.exec(lines[0] ?? "");
  if (!status) throw unavailable("Invalid endpoint response");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw unavailable("Invalid endpoint response header");
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, size: end };
}

/** Consumes HTTP chunks across arbitrary endpoint frame boundaries. */
function chunkedBodyReader(maxBytes: number) {
  const parts: Uint8Array[] = [];
  const sizeLine: number[] = [];
  let remaining = 0;
  let delimiter = 0;
  let declared = 0;
  return (bytes: Uint8Array): Uint8Array | undefined => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (remaining > 0) {
        const end = Math.min(offset + remaining, bytes.byteLength);
        parts.push(bytes.subarray(offset, end));
        remaining -= end - offset;
        offset = end;
        if (!remaining) delimiter = 2;
        continue;
      }
      const byte = bytes[offset++]!;
      if (delimiter > 0) {
        if (byte !== (delimiter === 2 ? 13 : 10)) throw unavailable("Invalid endpoint response chunk delimiter");
        delimiter--;
        continue;
      }
      sizeLine.push(byte);
      if (sizeLine.length > HEADER_LIMIT) throw unavailable("Endpoint response chunk header exceeds its budget");
      if (byte !== 10) continue;
      if (sizeLine.at(-2) !== 13) throw unavailable("Invalid endpoint response chunk");
      sizeLine.length -= 2;
      const hex = decoder.decode(Uint8Array.from(sizeLine)).split(";")[0]!.trim();
      sizeLine.length = 0;
      if (!/^[0-9a-f]+$/iu.test(hex)) throw unavailable("Invalid endpoint response chunk");
      remaining = Number.parseInt(hex, 16);
      if (!remaining) return concat(parts);
      declared += remaining;
      if (declared > maxBytes) throw unavailable("Endpoint response exceeds its budget");
    }
  };
}

/**
 * One HTTP/1.1 request over one endpoint connection (`connection: close`), as
 * the Node clients send it over the owner's Unix socket. The response is read
 * by `content-length`, by chunked encoding, or until the owner closes.
 */
export async function endpointHttpRequest(
  dial: EndpointDial,
  path: string,
  options: EndpointHttpOptions = {},
): Promise<EndpointHttpResponse> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const body = options.body === undefined ? undefined : encoder.encode(options.body);
  const head = encoder.encode(
    requestHead(options.method ?? "GET", path, {
      ...options.headers,
      connection: "close",
      ...(body ? { "content-length": String(body.byteLength) } : {}),
    }) + "\r\n",
  );
  const headParts: Uint8Array[] = [];
  const bodyParts: Uint8Array[] = [];
  let parsed: NonNullable<ReturnType<typeof parseHead>> | undefined;
  let readChunked: ReturnType<typeof chunkedBodyReader> | undefined;
  let contentLength: number | undefined;
  let received = 0;
  let bodyBytes = 0;
  let settle!: (value: EndpointHttpResponse | Error) => void;
  let done = false;
  const outcome = new Promise<EndpointHttpResponse | Error>((resolve) => {
    settle = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
  });
  const respond = (status: number, headers: Map<string, string>, payload: Uint8Array) =>
    settle({
      status,
      ok: status >= 200 && status < 300,
      headers,
      body: payload,
      text: () => decoder.decode(payload),
      json: () => JSON.parse(decoder.decode(payload)),
    });
  const connection = await dial((data) => {
    if (done) return;
    received += data.byteLength;
    if (received > maxBytes + HEADER_LIMIT) {
      settle(unavailable("Endpoint response exceeds its budget"));
      return;
    }
    try {
      // Own each retained endpoint frame while assembling the response.
      let bytes: Uint8Array = data.slice();
      if (!parsed) {
        headParts.push(bytes);
        const headBytes = headParts.length === 1 ? bytes : concat(headParts);
        const complete = parseHead(headBytes);
        if (!complete) return;
        parsed = complete;
        headParts.length = 0;
        bytes = headBytes.subarray(parsed.size);
        const length = parsed.headers.get("content-length");
        if (parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
          readChunked = chunkedBodyReader(maxBytes);
        } else if (length !== undefined) {
          contentLength = Number(length);
          if (!/^\d{1,12}$/u.test(length) || contentLength > maxBytes)
            throw unavailable("Invalid endpoint response length");
        }
      }
      if (readChunked) {
        const payload = readChunked(bytes);
        if (payload) respond(parsed.status, parsed.headers, payload);
        return;
      }
      const retained = contentLength === undefined ? bytes : bytes.subarray(0, contentLength - bodyBytes);
      bodyBytes += retained.byteLength;
      if (bodyBytes > maxBytes) throw unavailable("Endpoint response exceeds its budget");
      if (retained.byteLength) bodyParts.push(retained);
      if (bodyBytes === contentLength) respond(parsed.status, parsed.headers, concat(bodyParts));
    } catch (error) {
      settle(error instanceof Error ? error : unavailable("Invalid endpoint response"));
    }
  });
  void connection.closed.then(result => {
    if (done) return;
    if (result === "failed") settle(new EndpointHttpInterrupted("Endpoint connection failed before the response completed"));
    else if (!parsed) settle(new EndpointHttpInterrupted("Endpoint closed before its response"));
    else if (readChunked || contentLength !== undefined) settle(new EndpointHttpInterrupted("Endpoint response ended early"));
    else respond(parsed.status, parsed.headers, concat(bodyParts));
  });
  const timer = setTimeout(() => settle(new EndpointHttpInterrupted("Endpoint request timed out")), options.timeoutMs ?? 5000);
  try {
    await connection.write(body ? concat([head, body]) : head);
    const result = await outcome;
    if (result instanceof Error) throw result;
    return result;
  } catch (error) {
    settle(error instanceof Error ? error : unavailable("Endpoint request failed"));
    throw error;
  } finally {
    clearTimeout(timer);
    await connection.close().catch(() => {});
  }
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A client WebSocket over one endpoint connection: text messages only. */
export interface EndpointWebSocket {
  send(text: string): Promise<void>;
  /** Idempotent: sends a close frame when possible and ends the connection. */
  close(): Promise<void>;
  /** Settles once, when the socket closed for any reason. */
  readonly closed: Promise<void>;
}

export interface EndpointWebSocketOptions {
  onMessage(text: string): void;
  onError?(error: Error): void;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Largest message accepted; a larger one closes the socket. */
  readonly maxPayload?: number;
}

export class EndpointMessageTooLargeError extends Error {
  constructor() {
    super("WebSocket message exceeds its budget");
  }
}

/** A frame to the owner: FIN, the opcode, masked as RFC 6455 requires of clients. */
function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const size = payload.byteLength;
  const header = size < 126 ? 2 : size < 65536 ? 4 : 10;
  const out = new Uint8Array(header + 4 + size);
  out[0] = 0x80 | opcode;
  if (size < 126) out[1] = 0x80 | size;
  else if (size < 65536) {
    out[1] = 0x80 | 126;
    out[2] = size >>> 8;
    out[3] = size & 0xff;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(size));
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  out.set(mask, header);
  for (let i = 0; i < size; i++) out[header + 4 + i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

/** Opens a WebSocket on `path` of the owner behind the endpoint, as `ws` does over a Unix socket. */
export async function openEndpointWebSocket(
  dial: EndpointDial,
  path: string,
  options: EndpointWebSocketOptions,
): Promise<EndpointWebSocket> {
  const maxPayload = options.maxPayload ?? 1024 * 1024;
  const key = base64(crypto.getRandomValues(new Uint8Array(16)));
  const accept = base64(new Uint8Array(await crypto.subtle.digest("SHA-1", encoder.encode(key + WEBSOCKET_GUID))));
  let buffer: Uint8Array = new Uint8Array(0),
    open = false,
    finished = false,
    message: Uint8Array[] = [],
    messageSize = 0;
  let opened!: (error?: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    opened = (error) => (error ? reject(error) : resolve());
  });
  void handshake.catch(() => {});
  let closeResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  /** Set once the dial answered; frames before it cannot be sent. */
  const link: { connection?: SandboxEndpointConnection } = {};
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    if (!open) opened(error ?? unavailable("Endpoint WebSocket closed during its handshake"));
    closeResolve();
    void link.connection?.close().catch(() => {});
  };
  const send = (opcode: number, payload: Uint8Array) => {
    if (finished || !link.connection) return Promise.reject(unavailable("Endpoint WebSocket is closed"));
    return link.connection.write(frame(opcode, payload));
  };
  const parseFrames = () => {
    for (;;) {
      if (buffer.byteLength < 2) return;
      const first = buffer[0]!,
        second = buffer[1]!;
      if (second & 0x80 || first & 0x70) throw unavailable("Invalid WebSocket frame from the owner");
      let size = second & 0x7f,
        at = 2;
      if (size === 126) {
        if (buffer.byteLength < 4) return;
        size = (buffer[2]! << 8) | buffer[3]!;
        at = 4;
      } else if (size === 127) {
        if (buffer.byteLength < 10) return;
        const wide = new DataView(buffer.buffer, buffer.byteOffset + 2, 8).getBigUint64(0);
        if (wide > BigInt(maxPayload)) throw new EndpointMessageTooLargeError();
        size = Number(wide);
        at = 10;
      }
      if (size > maxPayload) throw new EndpointMessageTooLargeError();
      if (buffer.byteLength < at + size) return;
      const payload = buffer.slice(at, at + size);
      buffer = buffer.slice(at + size);
      const opcode = first & 0x0f;
      if (opcode === 8) {
        finish();
        return;
      }
      if (opcode === 9) {
        void send(10, payload).catch(() => {});
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 2 || opcode === 0) {
        if (opcode !== 0 && message.length) throw unavailable("Interleaved WebSocket message from the owner");
        message.push(payload);
        messageSize += size;
        if (messageSize > maxPayload) throw new EndpointMessageTooLargeError();
        if (first & 0x80) {
          const text = decoder.decode(concat(message));
          message = [];
          messageSize = 0;
          options.onMessage(text);
        }
        continue;
      }
      throw unavailable("Unknown WebSocket frame from the owner");
    }
  };
  const receive = (data: Uint8Array) => {
    if (finished) return;
    try {
      buffer = concat([buffer, data]);
      if (!open) {
        const parsed = parseHead(buffer);
        if (!parsed) return;
        if (
          parsed.status !== 101 ||
          parsed.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          parsed.headers.get("sec-websocket-accept") !== accept
        )
          throw unavailable("Endpoint WebSocket handshake was refused");
        buffer = buffer.slice(parsed.size);
        open = true;
        opened();
      }
      parseFrames();
    } catch (error) {
      const failure = error instanceof Error ? error : unavailable("Endpoint WebSocket failed");
      options.onError?.(failure);
      finish(failure);
    }
  };
  const connection = (link.connection = await dial(receive));
  void connection.closed.then(() => finish());
  const timer = setTimeout(
    () => finish(unavailable("Endpoint WebSocket handshake timed out")),
    options.timeoutMs ?? 5000,
  );
  try {
    await connection.write(
      encoder.encode(
        requestHead("GET", path, {
          ...options.headers,
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": key,
          "sec-websocket-version": "13",
        }) + "\r\n",
      ),
    );
    await handshake;
  } catch (error) {
    finish();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    closed,
    send: (text) => send(1, encoder.encode(text)),
    async close() {
      if (!finished) await send(8, new Uint8Array([0x03, 0xe8])).catch(() => {});
      finish();
      await closed;
    },
  };
}

export class EndpointRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * One owner-selected JSON-RPC operation over a fresh endpoint WebSocket.
 * After initialization, the caller may fence a mutation immediately before
 * dispatch. The adapter never retries a request or answers native callbacks.
 */
export async function endpointJsonRpcRequest(
  dial: EndpointDial,
  path: string,
  method: string,
  params: Record<string, unknown>,
  options: {
    readonly timeoutMs?: number;
    readonly maxPayload?: number;
    readonly signal?: AbortSignal;
    readonly beforeRequest?: () => Promise<void>;
  } = {},
): Promise<unknown> {
  const id = `workspace-rpc:${crypto.randomUUID()}`,
    init = `${id}:initialize`;
  let socket: EndpointWebSocket | undefined,
    initialized = false,
    sent = false,
    pending = true;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const result = new Promise<unknown>((accept, refuse) => {
    resolve = (value) => {
      pending = false;
      accept(value);
    };
    reject = (error) => {
      pending = false;
      refuse(error);
    };
  });
  void result.catch(() => {});
  const abort = () => reject(unavailable("Workspace RPC cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => reject(unavailable("Workspace RPC timed out")), options.timeoutMs ?? 1500);
  try {
    socket = await openEndpointWebSocket(dial, path, {
      timeoutMs: options.timeoutMs ?? 1500,
      maxPayload: options.maxPayload ?? 1024 * 1024,
      onError: reject,
      onMessage(text) {
        try {
          if (!pending) return;
          const message = parseJsonRpcMessage(text);
          if ("method" in message) return; // Never own or answer a native interaction.
          if (!initialized && message.id === init) {
            if (!isJsonRpcSuccess(message)) throw Error();
            initialized = true;
            void socket!
              .send('{"method":"initialized","params":{}}')
              .then(async () => {
                if (!pending) return;
                await options.beforeRequest?.();
                if (!pending) return;
                sent = true;
                await socket!.send(JSON.stringify({ id, method, params }));
              })
              .catch(() => reject(unavailable("Workspace RPC send failed")));
          } else if (sent && message.id === id) {
            if (isJsonRpcFailure(message)) reject(new EndpointRpcError(message.error.code, message.error.message));
            else resolve(message.result);
          }
        } catch {
          reject(unavailable("Workspace RPC unavailable"));
        }
      },
    });
    void socket.closed.then(() => reject(unavailable("Workspace RPC closed")));
    await socket.send(
      JSON.stringify({
        id: init,
        method: "initialize",
        params: {
          clientInfo: { name: "opencraft-workspace-owner", version: "1" },
          capabilities: { experimentalApi: true },
        },
      }),
    );
    return await result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await socket?.close().catch(() => {});
  }
}
