// Runtime-neutral HTTP exchange port (gateway-split.md §4.2). Services read a
// request view and return a response value; every deployment runtime (Node,
// Docker, desktop, a Fetch-handler isolate) is a peer adapter. The contract is
// shaped by the weakest runtime: Fetch `Request`/`Response` semantics, bodies
// as bytes or web streams, no socket, filesystem or process access. No runtime
// imports: this module runs unchanged everywhere.

/**
 * Minimal structural view of the transport's request object. Adapters pass
 * their own richer object (Node passes the `IncomingMessage` itself).
 */
export interface HttpRequestView {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawHeaders?: readonly string[];
  readonly method?: string;
  readonly url?: string;
}

export interface HttpExchangeRequest<View = HttpRequestView> {
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
  /** Aborts when the client went away before the response was complete. */
  readonly signal: AbortSignal;
  /**
   * The transport's request view, handed to authentication ports. Its object
   * identity is the per-request cache key the rest of the transport also uses
   * (single-use relay assertions, admission caches), so services pass this
   * object on and never a copy.
   */
  readonly identity: View;
}

export type HttpHeaderList = readonly (readonly [name: string, value: string])[];

/**
 * A complete body, or a web stream the adapter forwards as it is produced. A
 * stream is cancelled when the client goes away; a stream error after the
 * status was sent drops the exchange like `HttpExchangeAborted`.
 */
export type HttpResponseBody = string | Uint8Array | ReadableStream<Uint8Array> | null;

export interface HttpExchangeResponse {
  readonly status: number;
  /** Lower-case names in send order; a name may repeat (several `set-cookie`). */
  readonly headers: HttpHeaderList;
  readonly body: HttpResponseBody;
}

/** Resolves null when the handler does not own the route. */
export type HttpExchangeHandler<View = HttpRequestView> = (
  request: HttpExchangeRequest<View>,
) => Promise<HttpExchangeResponse | null>;

export class HttpBodyTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "HttpBodyTooLarge";
    this.limit = limit;
  }
}

/**
 * Thrown by a handler that already committed to a response and cannot finish
 * it: the transport drops the exchange instead of answering (Node destroys the
 * connection; Fetch rejects the request).
 */
export class HttpExchangeAborted extends Error {
  constructor(options?: { cause?: unknown }) {
    super("HTTP exchange aborted", options);
    this.name = "HttpExchangeAborted";
  }
}

export function httpResponse(
  status: number,
  headers: HttpHeaderList,
  body: HttpResponseBody = null,
): HttpExchangeResponse {
  return { status, headers, body };
}

/** JSON response; `before` headers (for example `set-cookie`) are sent first. */
export function jsonResponse(
  status: number,
  value: unknown,
  headers: HttpHeaderList,
  before: HttpHeaderList = [],
): HttpExchangeResponse {
  return { status, headers: [...before, ...headers], body: JSON.stringify(value) };
}

/** UTF-8 decoding with replacement characters and no BOM removal, as Node's buffer `toString('utf8')` decodes. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export function setCookies(cookies: readonly string[]): HttpHeaderList {
  return cookies.map((cookie) => ["set-cookie", cookie] as const);
}

/** Path and query of a request target, parsed against a placeholder origin. */
export function requestUrl(request: Pick<HttpExchangeRequest<unknown>, "path">): URL {
  return new URL(request.path || "/", "http://exchange.invalid");
}
