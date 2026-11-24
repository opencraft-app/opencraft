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

/** Decodes a complete chunked body; null while more bytes are needed. */
function dechunk(bytes: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    let line = -1;
    for (let i = at + 1; i < bytes.byteLength; i++)
      if (bytes[i - 1] === 13 && bytes[i] === 10) {
        line = i - 1;
        break;
      }
    if (line < 0) return null;
    const size = Number.parseInt(decoder.decode(bytes.subarray(at, line)).split(";")[0]!.trim(), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw unavailable("Invalid endpoint response chunk");
    at = line + 2;
    if (size === 0) return concat(parts);
    if (bytes.byteLength < at + size + 2) return null;
    parts.push(bytes.subarray(at, at + size));
    at += size + 2;
  }
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
  const chunks: Uint8Array[] = [];
  let received = 0,
    settle!: (value: EndpointHttpResponse | Error) => void,
    done = false;
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
  /** Settles once the response is complete; `ended` when the owner closed the connection. */
  const evaluate = (ended: boolean) => {
    try {
      const bytes = concat(chunks);
      const parsed = parseHead(bytes);
      if (!parsed) {
        if (ended) settle(unavailable("Endpoint closed before its response"));
        return;
      }
      const rest = bytes.subarray(parsed.size);
      const length = parsed.headers.get("content-length");
      if (parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
        const decoded = dechunk(rest);
        if (decoded) respond(parsed.status, parsed.headers, decoded);
        else if (ended) settle(unavailable("Endpoint response ended early"));
      } else if (length !== undefined) {
        const size = Number(length);
        if (!/^\d{1,12}$/u.test(length) || size > maxBytes) throw unavailable("Invalid endpoint response length");
        if (rest.byteLength >= size) respond(parsed.status, parsed.headers, rest.slice(0, size));
        else if (ended) settle(unavailable("Endpoint response ended early"));
      } else if (ended) respond(parsed.status, parsed.headers, rest.slice());
    } catch (error) {
      settle(error instanceof Error ? error : unavailable("Invalid endpoint response"));
    }
  };
  const connection = await dial((data) => {
    if (done) return;
    received += data.byteLength;
    if (received > maxBytes + HEADER_LIMIT) {
      settle(unavailable("Endpoint response exceeds its budget"));
      return;
    }
    chunks.push(data.slice());
    evaluate(false);
  });
  void connection.closed.then(() => evaluate(true));
  const timer = setTimeout(() => settle(unavailable("Endpoint request timed out")), options.timeoutMs ?? 5000);
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
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Largest message accepted; a larger one closes the socket. */
  readonly maxPayload?: number;
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
        if (wide > BigInt(maxPayload)) throw unavailable("WebSocket message exceeds its budget");
        size = Number(wide);
        at = 10;
      }
      if (size > maxPayload) throw unavailable("WebSocket message exceeds its budget");
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
        if (messageSize > maxPayload) throw unavailable("WebSocket message exceeds its budget");
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
      finish(error instanceof Error ? error : unavailable("Endpoint WebSocket failed"));
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

/**
 * One read-only JSON-RPC request to an App Server over a fresh endpoint
 * WebSocket: `initialize`, `initialized`, the request, then close. Server
 * requests and notifications are ignored, never answered, as the Node
 * execution reader does (`createWebSocketExecutionTurnInspector`).
 */
export async function endpointJsonRpcRead(
  dial: EndpointDial,
  path: string,
  method: string,
  params: Record<string, unknown>,
  options: { readonly timeoutMs?: number; readonly maxPayload?: number; readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  const id = `execution-read:${crypto.randomUUID()}`,
    init = `${id}:initialize`;
  let socket: EndpointWebSocket | undefined,
    initialized = false;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const result = new Promise<unknown>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  void result.catch(() => {});
  const abort = () => reject(unavailable("Execution read cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => reject(unavailable("Execution read timed out")), options.timeoutMs ?? 1500);
  try {
    socket = await openEndpointWebSocket(dial, path, {
      timeoutMs: options.timeoutMs ?? 1500,
      maxPayload: options.maxPayload ?? 1024 * 1024,
      onMessage(text) {
        try {
          const message = JSON.parse(text);
          if (!message || typeof message !== "object" || Array.isArray(message)) throw Error();
          if (typeof message.method === "string") return; // Never own or answer a native interaction.
          if (!initialized && message.id === init) {
            if (message.error || !("result" in message)) throw Error();
            initialized = true;
            void socket!.send('{"method":"initialized","params":{}}');
            void socket!.send(JSON.stringify({ id, method, params }));
          } else if (initialized && message.id === id) {
            if (message.error || !("result" in message)) throw Error();
            resolve(message.result);
          }
        } catch {
          reject(unavailable("Execution read unavailable"));
        }
      },
    });
    void socket.closed.then(() => reject(unavailable("Execution read closed")));
    await socket.send(
      JSON.stringify({
        id: init,
        method: "initialize",
        params: {
          clientInfo: { name: "opencraft-execution-history-reader", version: "1" },
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
