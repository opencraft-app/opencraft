import type { DesktopLoginSession } from "./lightvela-login.js";

const bases = { cn: "https://api.lightvela.com", intl: "https://api.lightvela.ai" };
export interface DesktopAccountRequest {
  url: string;
  method: string;
  contentType?: string;
  body?: Uint8Array;
}

/** Account control-plane requests only; this is not an arbitrary network proxy. */
export function validateDesktopAccountRequest(input: DesktopAccountRequest, session: DesktopLoginSession): URL {
  if (!input || typeof input.url !== "string" || typeof input.method !== "string") throw new Error("Invalid account request");
  const url = new URL(input.url);
  const method = input.method.toUpperCase();
  if (url.origin !== bases[session.region] || url.username || url.password || url.hash) throw new Error("Account authority mismatch");
  const instancePath = /^\/v1\/instances\/[a-zA-Z0-9_-]+$/;
  const allowed = (method === "GET" && (["/auth/profile", "/subscriptions/current", "/v1/passes", "/v1/instances"].includes(url.pathname) || instancePath.test(url.pathname)))
    || (method === "PUT" && url.pathname === "/auth/profile")
    || (method === "POST" && (url.pathname === "/v1/instances" || url.pathname === "/auth/profile/avatar" || /^\/v1\/instances\/[^/]+\/(tat\/session|config\/reset)$/.test(url.pathname)));
  if (!allowed || (input.body !== undefined && (!(input.body instanceof Uint8Array) || input.body.byteLength > 8 * 1024 * 1024))) throw new Error("Unsupported account request");
  if (input.contentType !== undefined && (typeof input.contentType !== "string" || input.contentType.length > 300 || /[\r\n]/.test(input.contentType))) throw new Error("Invalid content type");
  if (method === "POST" && url.pathname === "/v1/instances") {
    if (url.search || input.contentType !== "application/json" || !input.body) throw new Error("Invalid instance creation request");
    const body = JSON.parse(new TextDecoder().decode(input.body));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["name", "timeout"].includes(key))
      || typeof body.name !== "string" || !body.name.trim() || [...body.name].length > 64 || body.timeout !== 3600) throw new Error("Invalid instance creation request");
  }
  return url;
}

export async function requestDesktopAccount(input: DesktopAccountRequest, session: DesktopLoginSession, fetchImpl: typeof fetch = fetch) {
  const url = validateDesktopAccountRequest(input, session);
  const response = await fetchImpl(url, {
    method: input.method.toUpperCase(), redirect: "error", cache: "no-store",
    headers: { Authorization: `Bearer ${session.token}`, ...(input.contentType ? { "Content-Type": input.contentType } : {}) },
    body: input.body ? new Uint8Array(input.body).buffer : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 8 * 1024 * 1024) throw new Error("Account response is too large");
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}
