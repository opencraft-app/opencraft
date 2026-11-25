// The edge runs first, so files and SPA navigation pass the same installation
// admission as the Node Workbench. The Assets binding receives only asset
// request headers; installation credentials never travel with an asset fetch.
import { fetchResponse } from "@opencraft/http-exchange/fetch";
import { INSTANCE_ACCESS_PREFIX, MISSING, installationExchangeReply } from "../installation-routes.js";
import { WORKSPACE_HOST_OBJECT_PREFIX } from "../workspace-host-routes.js";

export interface EdgeFetchBinding {
  fetch(request: Request): Promise<Response>;
}

const UPGRADE_ROUTES = /^\/(?:apphost|appserver|ssh-apphost|desktop\/connect)(?:\/|$)/u;
const PUBLIC_PROXY_SCRIPT = "/__opencraft/opencraft-host-proxy-sw.js";
const UI_ROUTE = /^\/(?:local|settings|threads|views)\/[^/]+\/?$/u;
const FILE_EXTENSION = /[^/]\.[^/]+\/?$/u;
const HASHED_ASSET = /^\/assets\/.+-[a-zA-Z0-9_-]{6,}\.[^/]+$/u;
const ASSET_HEADERS = [
  "accept",
  "accept-encoding",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
  "range",
] as const;

function isReserved(path: string): boolean {
  return (
    path.startsWith("/__opencraft_") ||
    path.startsWith(WORKSPACE_HOST_OBJECT_PREFIX) ||
    path === "/__opencraft" ||
    (path.startsWith("/__opencraft/") && path !== PUBLIC_PROXY_SCRIPT) ||
    UPGRADE_ROUTES.test(path) ||
    path === "/health"
  );
}

function reply(status: number, error: string): Response {
  return fetchResponse(installationExchangeReply({ kind: "json", status, value: { error } }));
}

function responseFor(request: Request, response: Response): Response {
  return request.method === "HEAD" ? new Response(null, response) : response;
}

function workbenchNavigation(request: Request, pathname: string): boolean {
  return (
    request.headers.get("accept")?.includes("text/html") === true &&
    !pathname.startsWith("/assets/") &&
    (!FILE_EXTENSION.test(pathname) || UI_ROUTE.test(pathname))
  );
}

function assetResponse(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  // Authenticated responses must not become a shared cache's bypass of the
  // Worker. Browser caches can still reuse version-bound JS, CSS and media.
  const immutable = (response.ok || response.status === 304) && HASHED_ASSET.test(pathname);
  headers.set("cache-control", immutable ? "private, max-age=31536000, immutable" : "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function serveEdgeAssets(
  request: Request,
  assets: EdgeFetchBinding,
  installation: EdgeFetchBinding,
): Promise<Response> {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return responseFor(request, reply(400, "invalid_path"));
  }
  if (
    pathname.includes("\\") ||
    pathname.includes("//") ||
    /[\x00-\x1f\x7f]/u.test(pathname) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  )
    return responseFor(request, reply(400, "invalid_path"));
  if (isReserved(pathname) || pathname.toLowerCase().endsWith(".map") || request.headers.has("upgrade"))
    return responseFor(request, fetchResponse(installationExchangeReply(MISSING)));

  if (request.method !== "GET" && request.method !== "HEAD") {
    const result = reply(405, "method_not_allowed");
    result.headers.set("allow", "GET, HEAD");
    return result;
  }

  const admissionHeaders = new Headers();
  for (const name of ["accept", "authorization", "cookie", "cf-connecting-ip"]) {
    const value = request.headers.get(name);
    if (value !== null) admissionHeaders.set(name, value);
  }
  const admissionUrl = new URL(`${INSTANCE_ACCESS_PREFIX}admission`, request.url);
  let decision: Response;
  try {
    decision = await installation.fetch(new Request(admissionUrl, { headers: admissionHeaders, redirect: "manual" }));
  } catch {
    return responseFor(request, reply(503, "installation_unavailable"));
  }
  if (decision.status !== 204) {
    if (decision.status === 401 || decision.status === 403 || decision.status === 503)
      return responseFor(request, decision);
    return responseFor(request, reply(503, "installation_unavailable"));
  }

  const headers = new Headers();
  for (const name of ASSET_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const fetchAsset = (target: URL) =>
    assets.fetch(new Request(target, { method: request.method, headers, redirect: "manual" }));
  // Match the Node shell for "/" regardless of Accept. Extensionless SPA
  // routes only fall back for navigations, never script or API requests.
  if (pathname === "/") url.pathname = "/index.html";
  const response = await fetchAsset(url);
  if (response.status !== 404 || pathname === "/" || !workbenchNavigation(request, pathname))
    return assetResponse(response, url.pathname);

  await response.body?.cancel();
  url.pathname = "/index.html";
  return assetResponse(await fetchAsset(url), url.pathname);
}
