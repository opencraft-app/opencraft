// Runtime-neutral HTTP exchange port for identity and access handlers
// (gateway-split.md §3.4, §4.2). Handlers read a request view and return a
// response value; Node (`node:http`) and Fetch (`Request`/`Response`)
// adapters own the transport. No runtime imports: this module runs unchanged
// in Node and in workerd.
import type { IdentityRequest } from "./identity-request.js";

export type { IdentityRequest };

export interface HttpExchangeRequest {
  readonly method: string;
  /** Request target as received: path plus query, e.g. `/__opencraft_auth/session?x=1`. */
  readonly path: string;
  /**
   * Lower-cased names, one value each (duplicates combined by the adapter's
   * HTTP stack). `host` is the authority the transport accepted the request for.
   */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Name/value pairs as received, for duplicate detection. */
  readonly rawHeaders: readonly string[];
  /** Peer address reported by the transport or its trusted edge; null when unknown. */
  readonly clientAddress: string | null;
  /**
   * Reads the whole body once, counting streamed bytes. Rejects with
   * `HttpBodyTooLarge` as soon as the count exceeds `limit` and reads no further.
   */
  readBody(limit: number): Promise<Uint8Array>;
  /** Aborts when the client went away before the response was sent. */
  readonly signal: AbortSignal;
  /**
   * The request view identity providers authenticate. Its object identity is
   * the per-request cache key the rest of the transport also uses (single-use
   * relay assertions, admission caches), so handlers pass this object to
   * providers and never a copy.
   */
  readonly identity: IdentityRequest;
}

export type HttpHeaderList = readonly (readonly [name: string, value: string])[];

export interface HttpExchangeResponse {
  readonly status: number;
  /** Lower-case names in send order; a name may repeat (several `set-cookie`). */
  readonly headers: HttpHeaderList;
  readonly body: string | Uint8Array | null;
}

/** Resolves null when the handler does not own the route. */
export type HttpExchangeHandler = (request: HttpExchangeRequest) => Promise<HttpExchangeResponse | null>;

export class HttpBodyTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) { super(`Request body exceeds ${limit} bytes`); this.name = "HttpBodyTooLarge"; this.limit = limit; }
}

/**
 * Thrown by a handler that already committed to a response and cannot finish
 * it: the transport drops the connection instead of answering (Node destroys
 * the socket; Fetch rejects the request).
 */
export class HttpExchangeAborted extends Error {
  constructor(options?: { cause?: unknown }) { super("HTTP exchange aborted", options); this.name = "HttpExchangeAborted"; }
}

export function httpResponse(status: number, headers: HttpHeaderList, body: string | Uint8Array | null = null): HttpExchangeResponse {
  return { status, headers, body };
}

/** JSON response; `before` headers (for example `set-cookie`) are sent first. */
export function jsonResponse(status: number, value: unknown, headers: HttpHeaderList, before: HttpHeaderList = []): HttpExchangeResponse {
  return { status, headers: [...before, ...headers], body: JSON.stringify(value) };
}

/** Strict-enough UTF-8 decoding matching `Buffer#toString('utf8')` (replacement characters, no BOM removal). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export function setCookies(cookies: readonly string[]): HttpHeaderList {
  return cookies.map(cookie => ["set-cookie", cookie] as const);
}
