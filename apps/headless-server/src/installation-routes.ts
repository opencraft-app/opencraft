// The installation's HTTP routes and its admission gate (runtime-neutral;
// gateway-split §3.1, §4.1). One definition for every front door that serves
// the installation: the Node gateway (serve-workbench-web.mjs, over node:http)
// and the InstallationCore Durable Object (cloudflare/installation-core.ts,
// over Fetch). Each front door owns only how a reply is framed on its
// transport; which service owns a path, which requests are refused before
// reaching instance services, and what a refusal says are decided here.
import type { HttpExchangeHandler, HttpExchangeResponse } from "@opencraft/http-exchange";

/** Installation services a front door can mount; an absent one answers its routes with `missing`. */
export type InstallationRouteService =
  | "account"
  | "auth"
  | "actorCollaboration"
  | "actors"
  | "serverInformation"
  | "modelDefaults"
  | "threadReads"
  | "sshKeys";

/**
 * Login, setup, Actor and personal routes, in match order. They stay reachable
 * before instance admission: each service verifies its own caller. A more
 * specific prefix precedes the one that contains it.
 */
const ROUTES: readonly (readonly [InstallationRouteService, (path: string) => boolean])[] = [
  [
    "account",
    (path) => path === "/setup" || path === "/__opencraft_account" || path.startsWith("/__opencraft_account/"),
  ],
  ["auth", (path) => path === "/__opencraft_auth" || path.startsWith("/__opencraft_auth/")],
  ["actorCollaboration", (path) => path.startsWith("/__opencraft_actors/collaboration/")],
  ["actors", (path) => path === "/__opencraft_actors" || path.startsWith("/__opencraft_actors/")],
  ["serverInformation", (path) => path === "/__opencraft_server_information"],
  ["modelDefaults", (path) => path === "/__opencraft_model_defaults"],
  ["threadReads", (path) => path === "/__opencraft_thread_reads"],
  ["sshKeys", (path) => path === "/__opencraft_ssh_keys" || path.startsWith("/__opencraft_ssh_keys/")],
];

/** The installation service that owns `pathname`, or null when the path is not an installation route. */
export function installationRoute(pathname: string): InstallationRouteService | null {
  for (const [service, owns] of ROUTES) if (owns(pathname)) return service;
  return null;
}

/** Membership administration and admission probes (`InstanceAccess.handle`), served after the gate. */
export const INSTANCE_ACCESS_PREFIX = "/__opencraft_access/";

/** Paths installation probes reach without admission. */
export function isHealthPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/__opencraft_health";
}

/** A reply decided here; the front door frames it on its transport. */
export type InstallationReply =
  | { readonly kind: "json"; readonly status: number; readonly value: unknown }
  | { readonly kind: "html"; readonly status: 401 | 403; readonly page: string };

/** An owned route whose service is absent or declined the request. */
export const MISSING: InstallationReply = Object.freeze({ kind: "json", status: 404, value: { error: "missing" } });

/** The gate's view of the request's authority; every member reads the request a front door holds. */
export interface InstallationGate<Request> {
  /** An Actor Session bearer (`ActorAccess.isSessionRequest`); absent without Actors. */
  sessionRequest?(request: Request): boolean;
  /** 204 when the request may reach instance services, otherwise why not. */
  admission(request: Request): 204 | 401 | 403;
  /** Legacy unscoped admission of a recognized Human (`ActorAccess.legacyAdmissionStatus`); absent without Actors. */
  legacyAdmission?(request: Request): 204 | 403;
  /** The deployment has a login entry (`HumanAuth`), so a refusal page links to it. */
  readonly login: boolean;
}

function refusalPage(status: 401 | 403, login: boolean): string {
  return (
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问受限</title><style>:root{color-scheme:light dark}a{color:inherit}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}</style><body style="font:16px system-ui;margin:12vh auto;padding:24px;max-width:480px"><h1>暂时无法访问</h1><p>' +
    (status === 401
      ? login
        ? "请登录后继续。"
        : "请通过认证入口重新访问。"
      : "你的账号暂未获得访问权限，请联系管理员。") +
    "</p>" +
    (login ? '<a href="/__opencraft_auth/">登录与账号</a> · ' : "") +
    '<a href="">重新检查</a></body></html>'
  );
}

/**
 * The admission gate in front of every non-installation route: a Session
 * bearer never reaches legacy unscoped interfaces, an unadmitted request is
 * refused (a page for browsers, JSON otherwise), and a recognized but
 * unadmitted Human is never downgraded to anonymous. Null admits the request.
 */
export function installationGate<Request>(
  request: Request,
  pathname: string,
  accept: string | undefined,
  gate: InstallationGate<Request>,
): InstallationReply | null {
  if (gate.sessionRequest?.(request))
    return { kind: "json", status: 403, value: { error: "actor_resource_interface_required" } };
  if (isHealthPath(pathname)) return null;
  const status = gate.admission(request);
  if (status !== 204) {
    if (accept?.includes("text/html")) return { kind: "html", status, page: refusalPage(status, gate.login) };
    return {
      kind: "json",
      status,
      value: { error: status === 401 ? "authentication_required" : "instance_access_denied" },
    };
  }
  if (gate.legacyAdmission?.(request) === 403)
    return { kind: "json", status: 403, value: { error: "actor_access_denied" } };
  return null;
}

/** HTML refusal headers, in the order the Node gateway writes them. */
export const REFUSAL_PAGE_HEADERS: readonly (readonly [string, string])[] = [
  ["cache-control", "private, no-store"],
  ["content-type", "text/html; charset=utf-8"],
  ["x-content-type-options", "nosniff"],
  ["content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"],
];

/** A reply as an exchange response, for front doors on the HTTP exchange port. */
export function installationExchangeReply(reply: InstallationReply): HttpExchangeResponse {
  if (reply.kind === "html") return { status: reply.status, headers: REFUSAL_PAGE_HEADERS, body: reply.page };
  return {
    status: reply.status,
    headers: [
      ["cache-control", "no-store"],
      ["content-type", "application/json; charset=utf-8"],
    ],
    body: `${JSON.stringify(reply.value)}\n`,
  };
}

/**
 * Serves an installation route on the exchange port: the owning service's
 * answer, or `missing` when it is absent or declines. Null for a path that is
 * not an installation route, so the front door continues.
 */
export async function serveInstallationRoute<View>(
  services: Partial<Readonly<Record<InstallationRouteService, HttpExchangeHandler<View> | null | undefined>>>,
  exchange: Parameters<HttpExchangeHandler<View>>[0],
  pathname: string,
): Promise<HttpExchangeResponse | null> {
  const service = installationRoute(pathname);
  if (!service) return null;
  const handler = services[service];
  return (handler && (await handler(exchange))) ?? installationExchangeReply(MISSING);
}
