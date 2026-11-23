// Fetch (`Request`/`Response`) adapter for the HTTP exchange port, for
// runtimes whose entry is a fetch handler (workerd Durable Objects and
// Workers). The composition supplies the client address from its trusted edge
// (for example Cloudflare's `CF-Connecting-IP`); the adapter never trusts a
// request header for it on its own.
// Value imports go through the package export so plain `node` (type stripping, no specifier rewriting) can load this entry.
import { HttpBodyTooLarge, type HttpExchangeHandler, type HttpExchangeRequest, type HttpExchangeResponse } from "@opencraft/identity-core/http-exchange";
import type { IdentityRequest } from "./identity-request.js";

export interface FetchExchangeOptions {
  /** Peer address from the deployment's trusted edge; null when unknown. */
  readonly clientAddress?: string | null;
  /** Defaults to `request.signal`. */
  readonly signal?: AbortSignal;
}

/**
 * Request view of a fetch Request. `host` comes from the routed URL (the
 * zone/route that accepted the request), replacing any Host header value.
 */
export function fetchIdentityRequest(request: Request): IdentityRequest & { readonly headers: Record<string, string | undefined>; readonly rawHeaders: string[] } {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  const rawHeaders: string[] = [];
  request.headers.forEach((value, name) => {
    if (name === "host") return;
    // Fetch Headers already combine duplicates (", "); the raw list mirrors that view.
    headers[name] = value;
    rawHeaders.push(name, value);
  });
  headers.host = url.host;
  rawHeaders.push("host", url.host);
  return { headers, rawHeaders, method: request.method, url: url.pathname + url.search };
}

export function fetchHttpExchange(request: Request, options: FetchExchangeOptions = {}): HttpExchangeRequest {
  const identity = fetchIdentityRequest(request);
  let used = false;
  return {
    method: request.method,
    path: identity.url!,
    headers: identity.headers,
    rawHeaders: identity.rawHeaders,
    clientAddress: options.clientAddress ?? null,
    signal: options.signal ?? request.signal,
    identity,
    async readBody(limit: number): Promise<Uint8Array> {
      if (used) throw new Error("Request body already read");
      used = true;
      if (!request.body) return new Uint8Array(0);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => undefined);
          throw new HttpBodyTooLarge(limit);
        }
        chunks.push(next.value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return body;
    },
  };
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Fetch `Headers` keep every `set-cookie` value in order but iterate other
 * names in their own canonical order; HTTP gives distinct names no meaning by order.
 */
export function fetchResponse(result: HttpExchangeResponse): Response {
  const headers = new Headers();
  for (const [name, value] of result.headers) headers.append(name, value);
  // Strings go out as bytes so Response adds no implicit content-type (node:http adds none either).
  const body = NULL_BODY.has(result.status) || result.body === null ? null
    : typeof result.body === "string" ? new TextEncoder().encode(result.body) : result.body;
  return new Response(body as BodyInit | null, { status: result.status, headers });
}

/**
 * Runs a port handler for one fetch Request; resolves null when the handler
 * does not own the route. `HttpExchangeAborted` propagates (the runtime fails
 * the request instead of answering), like any other handler failure.
 */
export async function serveFetchHttpExchange(request: Request, handler: HttpExchangeHandler, options: FetchExchangeOptions = {}): Promise<Response | null> {
  const result = await handler(fetchHttpExchange(request, options));
  return result ? fetchResponse(result) : null;
}
