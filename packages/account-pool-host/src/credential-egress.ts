// Model request egress with a credential lease (cloudflare-deployment §2.1): an
// engine in a workspace container sends its provider request to the egress
// with its lease token where a provider key would go; the egress redeems the
// token with the account owner for that one provider's credential, forwards
// the request to the provider with the credential in place of the token, and
// streams the provider's answer back. The credential exists only in this
// request's memory: the egress keeps no state, writes nothing and never
// returns the credential. A revoked or expired lease is refused before any
// byte reaches the provider.
//
// Runtime-neutral: Fetch `Request`/`Response` and web streams only. The edge
// egress Worker serves it over a lease exchange client to the AccountCore
// object; any runtime with `fetch` can host it.
import { CredentialLeaseError, type CredentialLeases } from "./credential-leases.js";

/** `/__opencraft_egress/<providerId>/<provider path>`: the engine's base URL for a provider is `<egress>/__opencraft_egress/<providerId>`. */
export const CREDENTIAL_EGRESS_PREFIX = "/__opencraft_egress/";

const PROVIDER_ID = /^[\x21-\x7e]{1,256}$/u;
/** Headers that belong to this hop, or that carry the engine's lease or browser state; never forwarded. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "cf-connecting-ip",
  "x-forwarded-for",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
]);

const refuse = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The lease token where the engine's SDK puts a key: `Authorization: Bearer …` or `x-api-key`. */
function leaseToken(headers: Headers): string | null {
  const bearer = /^Bearer (\S+)$/u.exec(headers.get("authorization") ?? "")?.[1];
  return bearer ?? headers.get("x-api-key");
}

/** The provider's credential header for its protocol (the same rule as the Node account Core's forwarding). */
function credentialHeader(protocol: string, credential: string): [string, string] | null {
  if (protocol === "anthropic-messages") return ["x-api-key", credential];
  if (protocol === "openai-responses" || protocol === "openai-completions")
    return ["authorization", `Bearer ${credential}`];
  return null;
}

/** `baseUrl` joined with the provider path; refuses a path that would leave the base. */
function upstreamUrl(baseUrl: string, rest: string, search: string): URL | null {
  const base = new URL(baseUrl);
  const segments = rest.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || /%2e|%2f|%5c/iu.test(segment))) return null;
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${rest}`;
  url.search = search;
  return url.origin === base.origin && url.pathname.startsWith(base.pathname.replace(/\/+$/u, "")) ? url : null;
}

export interface CredentialEgressOptions {
  /** Redeems a lease token (a lease exchange client, or the ledger itself in the owner's process). */
  readonly leases: Pick<CredentialLeases, "redeem">;
  /** The runtime's outbound fetch. */
  readonly fetch: (request: Request) => Promise<Response>;
}

/** Serves one egress request; resolves null for a path outside {@link CREDENTIAL_EGRESS_PREFIX}. */
export function credentialEgress(options: CredentialEgressOptions): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(CREDENTIAL_EGRESS_PREFIX)) return null;
    const [encodedProvider = "", ...restSegments] = url.pathname.slice(CREDENTIAL_EGRESS_PREFIX.length).split("/");
    let providerId: string;
    try {
      providerId = decodeURIComponent(encodedProvider);
    } catch {
      return refuse(404, "provider_unavailable");
    }
    if (!PROVIDER_ID.test(providerId)) return refuse(404, "provider_unavailable");
    const token = leaseToken(request.headers);
    if (!token) return refuse(401, "lease_required");
    let redemption: Awaited<ReturnType<CredentialLeases["redeem"]>>;
    try {
      redemption = await options.leases.redeem(token, providerId);
    } catch (error) {
      if (error instanceof CredentialLeaseError)
        return error.code === "provider_unavailable" || error.code === "invalid_lease_request"
          ? refuse(404, "provider_unavailable")
          : refuse(401, "lease_invalid");
      return refuse(503, "lease_unavailable");
    }
    const header = credentialHeader(redemption.protocol, redemption.credential);
    const target = upstreamUrl(redemption.baseUrl, restSegments.join("/"), url.search);
    if (!header || !target) return refuse(404, "provider_unavailable");
    const headers = new Headers();
    for (const [name, value] of request.headers) if (!DROPPED_REQUEST_HEADERS.has(name)) headers.set(name, value);
    headers.set(header[0], header[1]);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await options.fetch(
        new Request(target, {
          method: request.method,
          headers,
          body: hasBody ? request.body : null,
          redirect: "manual",
          signal: request.signal,
          ...(hasBody ? { duplex: "half" } : {}),
        } as RequestInit),
      );
    } catch {
      return refuse(502, "provider_unreachable");
    }
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers)
      if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value);
    // The provider's body streams through; the credential is not part of it.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}
