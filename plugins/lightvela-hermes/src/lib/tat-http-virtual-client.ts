import type { BotTerminalSession } from "../domain/types";
import { TatTransportError, normalizeTatTransportError } from "./tat-transport-error";
import { TencentTatSessionMultiplexer, type TsshProxyClientOptions, type TsshProxyTarget } from "./tencent-tat-session-multiplexer";
import { decodeUtf8, encodeUtf8 } from "./utf8";

const DEFAULT_HTTP_PROXY_HOST = "127.0.0.1";
const DEFAULT_HEADER_LIMIT_BYTES = 64 * 1024;
const DEFAULT_MAX_IDLE_PROXY_CONNECTIONS = 4;
const DEFAULT_RESPONSE_HEADER_TIMEOUT_MS = 20_000;
const DEFAULT_RESPONSE_BODY_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_DELIMITED_BODY_IDLE_TIMEOUT_MS = 1_500;
const TAT_HTTP_LOG_PREFIX = "[tat-http]";
let tatHttpRequestSeq = 0;

export interface TatHttpVirtualTarget {
  ip?: string;
  host?: string;
  port: number | string;
}

export interface TatHttpVirtualClientOptions extends TsshProxyClientOptions {
  /**
   * Buffer the decoded HTTP entity before constructing Response. React Native's
   * Response implementation does not accept a WHATWG ReadableStream body even
   * when ReadableStream itself exists.
   */
  bufferResponseBody?: boolean;
  target?: TatHttpVirtualTarget;
  headerLimitBytes?: number;
  keepAlive?: boolean;
  maxIdleProxyConnections?: number;
  proxyClient?: TencentTatSessionMultiplexer;
  responseBodyChunkTimeoutMs?: number;
  responseHeaderTimeoutMs?: number;
  closeDelimitedBodyIdleTimeoutMs?: number;
}

export interface TatHttpVirtualFetchInit extends Omit<RequestInit, "body"> {
  body?: string | Uint8Array | ArrayBuffer;
  json?: unknown;
  target?: TatHttpVirtualTarget;
}

export type TatHttpVirtualFetch = {
  (input: string | URL, init?: TatHttpVirtualFetchInit): Promise<Response>;
  json: <T>(input: string | URL, init?: TatHttpVirtualFetchInit) => Promise<T>;
  close: () => void;
};

interface ResolvedRequest {
  target: Required<TatHttpVirtualTarget>;
  path: string;
}

interface LeasedProxyConnection {
  key: string;
  connection: Awaited<ReturnType<TencentTatSessionMultiplexer["openProxy"]>>;
  reused: boolean;
}

export const HERMES_TAT_API_TARGET: TatHttpVirtualTarget = {
  ip: "127.0.0.1",
  host: "127.0.0.1",
  port: 8642,
};

export const HERMES_TAT_WEB_TARGET: TatHttpVirtualTarget = {
  ip: "127.0.0.1",
  host: "127.0.0.1",
  port: 9119,
};

export const HERMES_TAT_HTTP_TARGET = HERMES_TAT_API_TARGET;

const concatBytes = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const bufferBody = async (body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = concatBytes(chunks);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const indexOfHeaderEnd = (bytes: Uint8Array) => {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return index;
    }
  }
  return -1;
};

const indexOfLineEnd = (bytes: Uint8Array) => {
  for (let index = 0; index <= bytes.byteLength - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) {
      return index;
    }
  }
  return -1;
};

const sliceBytes = (bytes: Uint8Array, start: number, end?: number) => bytes.slice(start, end);

const encodeBody = (init: TatHttpVirtualFetchInit) => {
  if (init.body !== undefined && init.json !== undefined) {
    throw new Error("body and json cannot be used together");
  }
  if (init.json !== undefined) {
    return { bytes: encodeUtf8(JSON.stringify(init.json)), contentType: "application/json" };
  }
  if (typeof init.body === "string") {
    return { bytes: encodeUtf8(init.body), contentType: "text/plain;charset=UTF-8" };
  }
  if (init.body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(init.body), contentType: null };
  }
  return { bytes: init.body ?? new Uint8Array(), contentType: null };
};

const normalizeTarget = (target: TatHttpVirtualTarget): Required<TatHttpVirtualTarget> => ({
  ip: target.ip ?? target.host ?? DEFAULT_HTTP_PROXY_HOST,
  host: target.host ?? target.ip ?? DEFAULT_HTTP_PROXY_HOST,
  port: target.port,
});

const resolveRequest = (input: string | URL, initTarget?: TatHttpVirtualTarget, defaultTarget?: TatHttpVirtualTarget): ResolvedRequest => {
  const inputText = String(input);
  if (inputText.startsWith("http://")) {
    const url = new URL(inputText);
    const target = normalizeTarget(initTarget ?? defaultTarget ?? {
      host: url.hostname,
      ip: url.hostname,
      port: url.port || "80",
    });
    return {
      target,
      path: `${url.pathname || "/"}${url.search}`,
    };
  }
  if (inputText.startsWith("https://")) {
    throw new Error("TatHttpVirtualClient only supports plain HTTP targets. Terminate TLS before the TAT proxy or expose an HTTP loopback service.");
  }
  const target = initTarget ?? defaultTarget;
  if (!target) {
    throw new Error("TatHttpVirtualClient requires a target for relative request paths");
  }
  return {
    target: normalizeTarget(target),
    path: inputText.startsWith("/") ? inputText : `/${inputText}`,
  };
};

const getHeader = (headers: Headers, name: string) => headers.get(name)?.trim() ?? "";

const getRequestMethod = (init: TatHttpVirtualFetchInit) =>
  (init.method ?? (init.body !== undefined || init.json !== undefined ? "POST" : "GET")).toUpperCase();

const isNullBodyResponse = (method: string, status: number) =>
  method === "HEAD" || status === 204 || status === 205 || status === 304;

const proxyTargetKey = (target: Required<TatHttpVirtualTarget>) => `${target.ip}:${target.port}`;

const nextTatHttpRequestId = () => {
  tatHttpRequestSeq += 1;
  return `tat_http_${Date.now().toString(36)}_${tatHttpRequestSeq}`;
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

const logTatHttp = (
  event: string,
  context: Record<string, unknown>,
  error?: unknown,
) => {
  console.log(`${TAT_HTTP_LOG_PREFIX} ${event}`, stringifyLogPayload({
    context,
    error: error === undefined ? null : errorForLog(error),
  }));
};

const buildRequestBytes = (resolved: ResolvedRequest, init: TatHttpVirtualFetchInit, keepAlive: boolean) => {
  const method = getRequestMethod(init);
  const body = encodeBody(init);
  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    headers.set("Host", `${resolved.target.host}:${resolved.target.port}`);
  }
  if (!headers.has("accept")) {
    headers.set("Accept", "*/*");
  }
  if (!headers.has("connection")) {
    headers.set("Connection", keepAlive ? "keep-alive" : "close");
  }
  if (body.contentType && !headers.has("content-type")) {
    headers.set("Content-Type", body.contentType);
  }
  if (body.bytes.byteLength > 0 && !headers.has("content-length")) {
    headers.set("Content-Length", String(body.bytes.byteLength));
  }

  const headerLines = [`${method} ${resolved.path} HTTP/1.1`];
  headers.forEach((value, key) => {
    headerLines.push(`${key}: ${value}`);
  });
  return concatBytes([encodeUtf8(`${headerLines.join("\r\n")}\r\n\r\n`), body.bytes]);
};

const parseResponseHead = (headBytes: Uint8Array) => {
  const head = decodeUtf8(headBytes);
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine);
  if (!statusMatch) {
    throw new Error(`invalid HTTP response status line: ${statusLine}`);
  }
  const headers = new Headers();
  for (const line of headerLines) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  };
};

const readStreamChunk = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  timeoutMessage: string,
  timeoutPhase: "response_body" | "response_head",
  signal?: AbortSignal,
) =>
  new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = () => {
      finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
    };
    timeout = setTimeout(() => {
      finish(() => reject(new TatTransportError("request_timeout", timeoutMessage, {
        phase: timeoutPhase,
      })));
    }, timeoutMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });

const readResponseHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  headerLimitBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await readStreamChunk(
      reader,
      timeoutMs,
      "timed out waiting for HTTP response headers",
      "response_head",
      signal,
    );
    if (result.done) {
      throw new TatTransportError(
        "proxy_unavailable",
        "connection closed before HTTP response headers were received",
        { phase: "response_head" },
      );
    }
    chunks.push(result.value);
    total += result.value.byteLength;
    if (total > headerLimitBytes) {
      throw new TatTransportError(
        "fatal",
        "HTTP response headers exceeded the configured limit",
        { phase: "response_head", retryable: false },
      );
    }
    const combined = concatBytes(chunks);
    const headerEnd = indexOfHeaderEnd(combined);
    if (headerEnd >= 0) {
      return {
        head: sliceBytes(combined, 0, headerEnd),
        bodyPrefix: sliceBytes(combined, headerEnd + 4),
      };
    }
  }
};

const makeCloseBodyStream = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bodyPrefix: Uint8Array,
  idleTimeoutMs: number,
  onDone: (completed: boolean) => void,
  signal?: AbortSignal,
) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (bodyPrefix.byteLength > 0) {
          controller.enqueue(bodyPrefix);
        }
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await readStreamChunk(
              reader,
              idleTimeoutMs,
              "timed out waiting for more close-delimited HTTP response body bytes",
              "response_body",
              signal,
            );
          } catch (error) {
            if (error instanceof Error && error.message.includes("close-delimited HTTP response body")) {
              controller.close();
              onDone(true);
              return;
            }
            throw error;
          }
          if (result.done) {
            controller.close();
            onDone(true);
            return;
          }
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        onDone(false);
      }
    },
    cancel() {
      onDone(false);
    },
  });

const makeFixedBodyStream = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bodyPrefix: Uint8Array,
  contentLength: number,
  bodyChunkTimeoutMs: number,
  onDone: (completed: boolean) => void,
  signal?: AbortSignal,
) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      let remaining = contentLength;
      try {
        const emit = (chunk: Uint8Array) => {
          if (remaining <= 0 || chunk.byteLength === 0) {
            return;
          }
          const piece = chunk.byteLength > remaining ? sliceBytes(chunk, 0, remaining) : chunk;
          remaining -= piece.byteLength;
          controller.enqueue(piece);
        };
        emit(bodyPrefix);
        while (remaining > 0) {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          const result = await readStreamChunk(
            reader,
            bodyChunkTimeoutMs,
            "timed out waiting for the declared HTTP response body bytes",
            "response_body",
            signal,
          );
          if (result.done) {
            throw new TatTransportError(
              "proxy_unavailable",
              "connection closed before the declared HTTP response body was complete",
              { phase: "response_body" },
            );
          }
          emit(result.value);
        }
        controller.close();
        onDone(true);
      } catch (error) {
        controller.error(error);
        onDone(false);
      }
    },
    cancel() {
      onDone(false);
    },
  });

const makeChunkedBodyStream = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bodyPrefix: Uint8Array,
  bodyChunkTimeoutMs: number,
  onDone: (completed: boolean) => void,
  signal?: AbortSignal,
) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = bodyPrefix;
      const ensureBytes = async (count: number) => {
        while (buffer.byteLength < count) {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          const result = await readStreamChunk(
            reader,
            bodyChunkTimeoutMs,
            "timed out waiting for HTTP chunk bytes",
            "response_body",
            signal,
          );
          if (result.done) {
            throw new TatTransportError(
              "proxy_unavailable",
              "connection closed before the chunked HTTP response body was complete",
              { phase: "response_body" },
            );
          }
          buffer = concatBytes([buffer, result.value]);
        }
      };
      const ensureLine = async () => {
        while (indexOfLineEnd(buffer) < 0) {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          const result = await readStreamChunk(
            reader,
            bodyChunkTimeoutMs,
            "timed out waiting for HTTP chunk line",
            "response_body",
            signal,
          );
          if (result.done) {
            throw new TatTransportError(
              "proxy_unavailable",
              "connection closed before the chunked HTTP response body was complete",
              { phase: "response_body" },
            );
          }
          buffer = concatBytes([buffer, result.value]);
        }
      };

      try {
        while (true) {
          await ensureLine();
          const lineEnd = indexOfLineEnd(buffer);
          const sizeLine = decodeUtf8(sliceBytes(buffer, 0, lineEnd)).split(";", 1)[0]?.trim() ?? "";
          const size = Number.parseInt(sizeLine, 16);
          if (!Number.isFinite(size)) {
            throw new Error(`invalid HTTP chunk size: ${sizeLine}`);
          }
          buffer = sliceBytes(buffer, lineEnd + 2);
          if (size === 0) {
            controller.close();
            onDone(true);
            return;
          }
          await ensureBytes(size + 2);
          controller.enqueue(sliceBytes(buffer, 0, size));
          buffer = sliceBytes(buffer, size + 2);
        }
      } catch (error) {
        controller.error(error);
        onDone(false);
      }
    },
    cancel() {
      onDone(false);
    },
  });

export class TatHttpVirtualClient {
  private readonly proxyClient: TencentTatSessionMultiplexer;
  private readonly ownsProxyClient: boolean;
  private readonly headerLimitBytes: number;
  private readonly keepAlive: boolean;
  private readonly maxIdleProxyConnections: number;
  private readonly responseBodyChunkTimeoutMs: number;
  private readonly responseHeaderTimeoutMs: number;
  private readonly closeDelimitedBodyIdleTimeoutMs: number;
  private readonly idleConnections = new Map<string, LeasedProxyConnection["connection"][]>();

  constructor(
    bootstrap: BotTerminalSession,
    private readonly options: TatHttpVirtualClientOptions = {},
  ) {
    this.proxyClient = options.proxyClient ?? new TencentTatSessionMultiplexer(bootstrap, options);
    this.ownsProxyClient = !options.proxyClient;
    this.headerLimitBytes = options.headerLimitBytes ?? DEFAULT_HEADER_LIMIT_BYTES;
    this.keepAlive = options.keepAlive ?? true;
    this.maxIdleProxyConnections = options.maxIdleProxyConnections ?? DEFAULT_MAX_IDLE_PROXY_CONNECTIONS;
    this.responseBodyChunkTimeoutMs = options.responseBodyChunkTimeoutMs ?? DEFAULT_RESPONSE_BODY_CHUNK_TIMEOUT_MS;
    this.responseHeaderTimeoutMs = options.responseHeaderTimeoutMs ?? DEFAULT_RESPONSE_HEADER_TIMEOUT_MS;
    this.closeDelimitedBodyIdleTimeoutMs = options.closeDelimitedBodyIdleTimeoutMs ?? DEFAULT_CLOSE_DELIMITED_BODY_IDLE_TIMEOUT_MS;
  }

  async fetch(input: string | URL, init: TatHttpVirtualFetchInit = {}) {
    const resolved = resolveRequest(input, init.target, this.options.target);
    const requestId = nextTatHttpRequestId();
    const method = getRequestMethod(init);
    const signal = init.signal ?? undefined;
    const proxyTarget: TsshProxyTarget = {
      ip: resolved.target.ip,
      port: resolved.target.port,
    };
    const requestContext = {
      input: String(input),
      keepAlive: this.keepAlive,
      method,
      path: resolved.path,
      requestId,
      target: resolved.target,
    };
    logTatHttp("request start", requestContext);
    let leased: LeasedProxyConnection | null = null;
    let connection: LeasedProxyConnection["connection"] | null = null;
    const abort = () => {
      logTatHttp("request aborted by signal", {
        ...requestContext,
        proxyId: connection?.proxyId,
      });
      connection?.close();
    };

    try {
      leased = await this.acquireConnection(resolved.target, proxyTarget);
      connection = leased.connection;
      logTatHttp("connection acquired", {
        ...requestContext,
        proxyId: connection.proxyId,
        reused: leased.reused,
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const requestBytes = buildRequestBytes(resolved, init, this.keepAlive);
      if (!connection.write(requestBytes)) {
        logTatHttp("connection not writable; retrying with fresh proxy", {
          ...requestContext,
          proxyId: connection.proxyId,
          reused: leased.reused,
        });
        connection.close();
        leased = await this.acquireConnection(resolved.target, proxyTarget, { forceNew: true });
        connection = leased.connection;
        logTatHttp("fresh connection acquired after write failure", {
          ...requestContext,
          proxyId: connection.proxyId,
          reused: leased.reused,
        });
        if (!connection.write(requestBytes)) {
          throw new TatTransportError(
            "proxy_unavailable",
            "TAT proxy connection is not writable",
            { phase: "request" },
          );
        }
      }
      let reader = connection.readable.getReader();
      let headAndPrefix: Awaited<ReturnType<typeof readResponseHead>>;
      try {
        headAndPrefix = await readResponseHead(reader, this.headerLimitBytes, this.responseHeaderTimeoutMs, signal);
      } catch (error) {
        logTatHttp("read response head failed", {
          ...requestContext,
          proxyId: connection.proxyId,
          reused: leased.reused,
        }, error);
        try {
          reader.releaseLock();
        } catch {
          // The timed-out read may still be pending until the proxy connection is closed.
        }
        connection.close();
        if (!leased.reused) {
          throw normalizeTatTransportError(error, "response_head");
        }
        leased = await this.acquireConnection(resolved.target, proxyTarget, { forceNew: true });
        connection = leased.connection;
        logTatHttp("fresh connection acquired after response-head failure", {
          ...requestContext,
          proxyId: connection.proxyId,
          reused: leased.reused,
        });
        if (!connection.write(requestBytes)) {
          throw new TatTransportError(
            "proxy_unavailable",
            "TAT proxy connection is not writable",
            { phase: "request" },
          );
        }
        reader = connection.readable.getReader();
        headAndPrefix = await readResponseHead(reader, this.headerLimitBytes, this.responseHeaderTimeoutMs, signal);
      }
      const { head, bodyPrefix } = headAndPrefix;
      const responseHead = parseResponseHead(head);
      const responseLease = leased;
      const responseConnectionHandle = connection;
      if (!responseLease || !responseConnectionHandle) {
        throw new TatTransportError(
          "proxy_unavailable",
          "TAT proxy connection disappeared before response handling",
          { phase: "response_head" },
        );
      }
      const transferEncoding = getHeader(responseHead.headers, "transfer-encoding").toLowerCase();
      const contentLengthText = getHeader(responseHead.headers, "content-length");
      const responseConnection = getHeader(responseHead.headers, "connection").toLowerCase();
      const canReuseConnection =
        this.keepAlive &&
        Boolean(contentLengthText) &&
        !transferEncoding.includes("chunked") &&
        !responseConnection.includes("close") &&
        !isNullBodyResponse(method, responseHead.status);
      let finalized = false;
      const onDone = (completed: boolean) => {
        if (finalized) {
          return;
        }
        finalized = true;
        logTatHttp("response body finalized", {
          ...requestContext,
          completed,
          proxyId: responseConnectionHandle.proxyId,
          status: responseHead.status,
        });
        signal?.removeEventListener("abort", abort);
        try {
          reader.releaseLock();
        } catch {
          // A timeout can intentionally close a close-delimited response while a read is still pending.
        }
        if (canReuseConnection && completed) {
          this.releaseConnection(responseLease);
        } else {
          responseConnectionHandle.close();
        }
      };
      if (isNullBodyResponse(method, responseHead.status)) {
        finalized = true;
        signal?.removeEventListener("abort", abort);
        reader.releaseLock();
        responseConnectionHandle.close();
        logTatHttp("response returned without body", {
          ...requestContext,
          proxyId: responseConnectionHandle.proxyId,
          status: responseHead.status,
        });
        return new Response(null, responseHead);
      }
      const body =
        transferEncoding.includes("chunked")
          ? makeChunkedBodyStream(reader, bodyPrefix, this.responseBodyChunkTimeoutMs, onDone, signal)
          : contentLengthText
            ? makeFixedBodyStream(reader, bodyPrefix, Number(contentLengthText), this.responseBodyChunkTimeoutMs, onDone, signal)
            : makeCloseBodyStream(reader, bodyPrefix, this.closeDelimitedBodyIdleTimeoutMs, onDone, signal);

      logTatHttp("response head received", {
        ...requestContext,
        contentLength: contentLengthText || null,
        proxyId: responseConnectionHandle.proxyId,
        status: responseHead.status,
        transferEncoding: transferEncoding || null,
      });
      if (this.options.bufferResponseBody === true) {
        return new Response(await bufferBody(body), responseHead);
      }
      return new Response(body, responseHead);
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      logTatHttp("request failed", {
        ...requestContext,
        proxyId: connection?.proxyId,
        reused: leased?.reused,
      }, error);
      connection?.close();
      throw normalizeTatTransportError(error, "request");
    }
  }

  async fetchJson<T>(input: string | URL, init: TatHttpVirtualFetchInit = {}) {
    const response = await this.fetch(input, {
      ...init,
      headers: {
        Accept: "application/json",
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    if (this.options.bufferResponseBody === true) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return JSON.parse(decodeUtf8(bytes)) as T;
    }
    return (await response.json()) as T;
  }

  close() {
    for (const connections of this.idleConnections.values()) {
      for (const connection of connections) {
        connection.close();
      }
    }
    this.idleConnections.clear();
    if (this.ownsProxyClient) {
      this.proxyClient.close();
    }
  }

  private async acquireConnection(
    target: Required<TatHttpVirtualTarget>,
    proxyTarget: TsshProxyTarget,
    input: { forceNew?: boolean } = {},
  ): Promise<LeasedProxyConnection> {
    const key = proxyTargetKey(target);
    const idle = this.idleConnections.get(key);
    if (!input.forceNew && idle) {
      const connection = idle.pop();
      if (idle.length === 0) {
        this.idleConnections.delete(key);
      }
      if (connection) {
        return { key, connection, reused: true };
      }
    }
    return {
      key,
      connection: await this.proxyClient.openProxy(proxyTarget),
      reused: false,
    };
  }

  private releaseConnection(leased: LeasedProxyConnection) {
    const idle = this.idleConnections.get(leased.key) ?? [];
    if (idle.length >= this.maxIdleProxyConnections) {
      leased.connection.close();
      return;
    }
    idle.push(leased.connection);
    this.idleConnections.set(leased.key, idle);
  }
}

export const createTatHttpFetch = (bootstrap: BotTerminalSession, options: TatHttpVirtualClientOptions): TatHttpVirtualFetch => {
  const client = new TatHttpVirtualClient(bootstrap, options);
  const tatFetch = ((input: string | URL, init?: TatHttpVirtualFetchInit) => client.fetch(input, init)) as TatHttpVirtualFetch;
  tatFetch.json = <T>(input: string | URL, init?: TatHttpVirtualFetchInit) => client.fetchJson<T>(input, init);
  tatFetch.close = () => client.close();
  return tatFetch;
};

export const createTatPortFetch = (
  bootstrap: BotTerminalSession,
  port: number | string,
  options: Omit<TatHttpVirtualClientOptions, "target"> & {
    host?: string;
    ip?: string;
    target?: Omit<TatHttpVirtualTarget, "port">;
  } = {},
) =>
  createTatHttpFetch(bootstrap, {
    ...options,
    target: {
      ip: options.ip ?? options.target?.ip ?? DEFAULT_HTTP_PROXY_HOST,
      host: options.host ?? options.target?.host ?? options.ip ?? options.target?.ip ?? DEFAULT_HTTP_PROXY_HOST,
      port,
    },
  });

export const createTatHermesFetch = (
  bootstrap: BotTerminalSession,
  options: Omit<TatHttpVirtualClientOptions, "target"> & { target?: TatHttpVirtualTarget } = {},
) =>
  createTatHttpFetch(bootstrap, {
    ...options,
    target: options.target ?? HERMES_TAT_API_TARGET,
  });

export const createTatHermesWebFetch = (
  bootstrap: BotTerminalSession,
  options: Omit<TatHttpVirtualClientOptions, "target"> & { target?: TatHttpVirtualTarget } = {},
) =>
  createTatHttpFetch(bootstrap, {
    ...options,
    target: options.target ?? HERMES_TAT_WEB_TARGET,
  });
