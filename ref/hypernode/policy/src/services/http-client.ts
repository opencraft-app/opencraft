import { Service, type Inject } from "@deepseek-ai/cordis";
import {
  concatBytes,
  type ByteInput,
  utf8Decode as decode,
  utf8Encode as encode,
} from "../runtime/bytes.ts";
import { errorMessage } from "../types/domain.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  ClaimedTcpTransport,
  HttpClientDrainResult,
  HttpClientPort,
  HttpClientRequestOptions,
} from "../types/network.ts";
import type { CloudflareSocketPort } from "../runtime/cloudflare-sockets.ts";

const HEADER_LIMIT = 64 * 1024;
const HEADER_END = encode("\r\n\r\n");
const LINE_END = encode("\r\n");

type HttpBodyMode = "length" | "chunked" | "close";

interface ParsedHttpUrl {
  secure: boolean;
  hostname: string;
  port: number;
  target: string;
}

interface EncodedHttpRequest {
  parsed: ParsedHttpUrl;
  bytes: Uint8Array;
}

interface DecodedHttpResponse {
  status: number;
  headers: Record<string, string>;
  dataBytes: number[];
  closed: boolean;
}

interface HttpRequestState {
  socket: CloudflareSocketPort;
  transport: ClaimedTcpTransport;
  decoder: HttpResponseDecoder;
}

function indexOf(bytes: Uint8Array, sequence: Uint8Array): number {
  outer: for (let index = 0; index <= bytes.length - sequence.length; index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function parseURL(value: string): ParsedHttpUrl {
  const match = /^(https?):\/\/([^/?#:]+|\[[^\]]+\])(?::(\d+))?([^#]*)$/i.exec(value);
  if (match === null) {
    throw new Error("HTTP client URL must be an absolute http(s) URL");
  }
  const protocol = match[1];
  const host = match[2];
  if (protocol === undefined || host === undefined) {
    throw new Error("HTTP client URL is missing its protocol or host");
  }
  const secure = protocol.toLowerCase() === "https";
  const hostname = host.replace(/^\[|\]$/g, "");
  const explicitPort = match[3];
  const port = explicitPort === undefined ? (secure ? 443 : 80) : Number(explicitPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid HTTP client port");
  }
  const rawTarget = match[4] || "/";
  return {
    secure,
    hostname,
    port,
    target: rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`,
  };
}

function requestBytes(options: HttpClientRequestOptions): EncodedHttpRequest {
  const body = encode(options.body ?? "");
  const parsed = parseURL(options.url);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const hasHeader = (name: string): boolean => (
    Object.keys(headers).some((candidate) => candidate.toLowerCase() === name)
  );
  if (!hasHeader("host")) {
    headers["Host"] = parsed.port === (parsed.secure ? 443 : 80)
      ? parsed.hostname
      : `${parsed.hostname}:${parsed.port}`;
  }
  if (!hasHeader("content-length")) headers["Content-Length"] = String(body.length);
  if (!hasHeader("connection")) headers["Connection"] = "close";
  const lines = [`${String(options.method ?? "GET").toUpperCase()} ${parsed.target} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return { parsed, bytes: concatBytes(encode(`${lines.join("\r\n")}\r\n\r\n`), body) };
}

export class HttpResponseDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  status = 0;
  headers: Record<string, string> = {};
  private mode: HttpBodyMode | null = null;
  private remaining: number | null = null;
  private finished = false;

  push(bytes: ByteInput = [], transportClosed = false): DecodedHttpResponse {
    if (this.finished) {
      return { status: this.status, headers: this.headers, dataBytes: [], closed: true };
    }
    this.buffer = concatBytes(this.buffer, bytes);
    const output: number[] = [];
    if (this.status === 0) this.parseHeaders(transportClosed);
    if (this.status === 0) {
      return { status: 0, headers: {}, dataBytes: [], closed: false };
    }
    if (this.mode === "length") this.readLengthBody(output, transportClosed);
    else if (this.mode === "chunked") this.readChunkedBody(output, transportClosed);
    else if (this.mode === "close") {
      output.push(...this.buffer);
      this.buffer = new Uint8Array();
      if (transportClosed) this.finished = true;
    }
    return { status: this.status, headers: this.headers, dataBytes: output, closed: this.finished };
  }

  private parseHeaders(transportClosed: boolean): void {
    const end = indexOf(this.buffer, HEADER_END);
    if (end < 0) {
      if (this.buffer.length > HEADER_LIMIT) throw new Error("HTTP response headers are too large");
      if (transportClosed) throw new Error("HTTP response closed before headers completed");
      return;
    }
    const lines = decode(this.buffer.slice(0, end)).split("\r\n");
    const statusLine = String(lines.shift() ?? "");
    this.status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
    if (this.status === 0) throw new Error("invalid HTTP response status line");
    for (const line of lines) {
      const at = line.indexOf(":");
      if (at > 0) this.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    this.buffer = this.buffer.slice(end + HEADER_END.length);
    const transfer = String(this.headers["transfer-encoding"] ?? "").toLowerCase();
    if (transfer.split(",").map((value) => value.trim()).includes("chunked")) {
      this.mode = "chunked";
      return;
    }
    const contentLength = this.headers["content-length"];
    if (contentLength !== undefined) {
      this.mode = "length";
      this.remaining = Number(contentLength);
      if (!Number.isSafeInteger(this.remaining) || this.remaining < 0) {
        throw new Error("invalid HTTP response content-length");
      }
      return;
    }
    this.mode = "close";
  }

  private readLengthBody(output: number[], transportClosed: boolean): void {
    if (this.remaining === null) throw new Error("HTTP response length state is invalid");
    const count = Math.min(this.remaining, this.buffer.length);
    if (count > 0) output.push(...this.buffer.slice(0, count));
    this.buffer = this.buffer.slice(count);
    this.remaining -= count;
    if (this.remaining === 0) this.finished = true;
    else if (transportClosed) throw new Error("HTTP response body ended before content-length");
  }

  private readChunkedBody(output: number[], transportClosed: boolean): void {
    while (!this.finished) {
      const lineEnd = indexOf(this.buffer, LINE_END);
      if (lineEnd < 0) break;
      const sizeText = decode(this.buffer.slice(0, lineEnd)).split(";", 1)[0] ?? "";
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid HTTP chunk size");
      if (size === 0) {
        const trailerEnd = indexOf(this.buffer.slice(lineEnd + 2), HEADER_END);
        if (this.buffer.length === lineEnd + 4) {
          this.buffer = new Uint8Array();
          this.finished = true;
        } else if (trailerEnd >= 0) {
          this.buffer = this.buffer.slice(lineEnd + 2 + trailerEnd + 4);
          this.finished = true;
        }
        break;
      }
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (this.buffer.length < dataEnd + 2) break;
      if (this.buffer[dataEnd] !== 13 || this.buffer[dataEnd + 1] !== 10) {
        throw new Error("invalid HTTP chunk terminator");
      }
      output.push(...this.buffer.slice(dataStart, dataEnd));
      this.buffer = this.buffer.slice(dataEnd + 2);
    }
    if (transportClosed && !this.finished) throw new Error("chunked HTTP response ended early");
  }
}

type Dependencies = "outboundTcp";

export class HttpClientService extends Service implements HttpClientPort {
  static inject = ["outboundTcp"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  requests = new Map<string, HttpRequestState>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "httpClient");
    ctx.effect(() => () => {
      for (const id of [...this.requests.keys()]) this.close(id);
    });
  }

  open(id: string, options: HttpClientRequestOptions): void {
    if (this.requests.has(id)) throw new Error(`duplicate HTTP request id: ${id}`);
    const request = requestBytes(options);
    const address = { hostname: request.parsed.hostname, port: request.parsed.port };
    const socketOptions = {
      secureTransport: request.parsed.secure ? "on" as const : "off" as const,
      allowHalfOpen: true,
    };
    const socket = this.ctx.outboundTcp.connectInternal === undefined
      ? this.ctx.outboundTcp.connect(address, socketOptions)
      : this.ctx.outboundTcp.connectInternal(address, {
        ...socketOptions,
        telemetry: options.telemetry ?? null,
      });
    const transport = this.ctx.outboundTcp.claimTransport(socket);
    this.requests.set(id, { socket, transport, decoder: new HttpResponseDecoder() });
    try {
      transport.write(request.bytes);
      // Content-Length delimits the request. Do not half-close a TLS socket here:
      // several HTTP origins interpret TLS close_notify as an aborted request and
      // never send their response. Connection: close still bounds the exchange.
    } catch (error) {
      this.close(id);
      throw error;
    }
  }

  drain(id: string): HttpClientDrainResult {
    const state = this.requests.get(id);
    if (state === undefined) {
      return {
        status: 0,
        headers: {},
        dataBytes: [],
        closed: true,
        error: "HTTP request is not open",
      };
    }
    try {
      const result = state.transport.drain();
      const decoded = state.decoder.push(result.dataBytes, result.closed);
      if (decoded.closed) this.close(id);
      return { ...decoded, error: result.error };
    } catch (error) {
      this.close(id);
      return {
        status: state.decoder.status,
        headers: state.decoder.headers,
        dataBytes: [],
        closed: true,
        error: errorMessage(error),
      };
    }
  }

  close(id: string): void {
    const state = this.requests.get(id);
    if (state === undefined) return;
    this.requests.delete(id);
    try {
      state.transport.close();
    } catch {}
  }
}
