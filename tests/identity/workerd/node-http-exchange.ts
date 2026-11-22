// Fetch Request/Response adapter for the node:http-shaped login handlers
// (HumanAuth.handle, LocalAccountApplication.handle). It implements only the
// members those handlers touch, which is the proposed runtime-neutral port
// (gateway-split.md, "登录入口原型结果"):
//   request:  method, url (path+query), lower-cased headers, rawHeaders,
//             client address, body as an async byte iterable
//   response: writeHead / setHeader (set-cookie may be a list) / end,
//             headersSent, destroyed, destroy
// Prototype only: it lives with the workerd test, not in a package.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface IdentityHeaders {
  readonly headers: Record<string, string | undefined>;
  readonly rawHeaders: string[];
  readonly method: string;
  readonly url: string;
}

/**
 * Header view of a fetch Request. `host` is taken from the routed URL: in
 * Workers the URL host is the zone/route that accepted the request.
 */
export function identityRequest(request: Request): IdentityHeaders {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  const rawHeaders: string[] = [];
  request.headers.forEach((value, name) => {
    if (name === "host") return;
    headers[name] = value;
    rawHeaders.push(name, value);
  });
  headers.host = url.host;
  rawHeaders.push("host", url.host);
  return { headers, rawHeaders, method: request.method, url: url.pathname + url.search };
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/** Runs a node:http-style handler; resolves null when it did not own the path. */
export async function handleNodeStyle(request: Request, handler: Handler): Promise<Response | null> {
  const view = identityRequest(request);
  const body = request.body;
  const incoming = {
    ...view,
    socket: { remoteAddress: request.headers.get("cf-connecting-ip") ?? "unknown" },
    async *[Symbol.asyncIterator]() {
      if (body) for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) yield chunk;
    },
  };
  let status = 200;
  let ended: string | null = null;
  let destroyed = false;
  const headers = new Map<string, string | string[]>();
  const setHeader = (name: string, value: string | number | readonly string[]) => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? [...value] : String(value));
  };
  const outgoing = {
    get headersSent() {
      return ended !== null;
    },
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
    },
    setHeader,
    writeHead(code: number, values: Record<string, string | number | readonly string[]> = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) setHeader(name, value);
      return outgoing;
    },
    end(chunk?: string) {
      ended = chunk ?? "";
    },
  };
  const owned = await handler(incoming as unknown as IncomingMessage, outgoing as unknown as ServerResponse);
  if (!owned) return null;
  if (destroyed || ended === null) return new Response(null, { status: 500 });
  const result = new Headers();
  for (const [name, value] of headers) for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  return new Response(status === 204 || status === 304 || ended === "" ? null : ended, { status, headers: result });
}
