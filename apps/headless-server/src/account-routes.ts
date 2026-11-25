// The account's HTTP routes and who holds authority over them (runtime-neutral;
// gateway-split §3.1, §4.1). One definition for every front door that serves
// the account: the Node gateway (through the account module's HTTP service)
// and the AccountCore Durable Object (cloudflare/account-core.ts), which the
// entry Worker forwards these paths to.
//
// Authority stays with the installation. On Node the account's handlers ask
// the installation's services in process (`installationAccountAuthorities`);
// the AccountCore object asks the InstallationCore object the same questions
// over the account authority exchange below, and the installation answers them
// with the same function. Instance admission (the installation gate) runs
// before any account route on both.
import type { InstallationReply } from "./installation-routes.js";

/** Account services a front door can mount; an absent one answers its routes with `missing`. */
export type AccountRouteService = "policy" | "gateway";

/** The model usage policy route (`@opencraft/model-usage-policy` POLICY_PATH). */
export const MODEL_POLICY_ROUTE = "/__opencraft_model_policy";
/** The model gateway route (`@opencraft/account-pool-host` MODEL_GATEWAY_PATH). */
export const MODEL_GATEWAY_ROUTE = "/__opencraft_model_gateway";

const ROUTES: readonly (readonly [AccountRouteService, string])[] = [
  ["policy", MODEL_POLICY_ROUTE],
  ["gateway", MODEL_GATEWAY_ROUTE],
];

/** The account service that owns `pathname`, or null when the path is not an account route. */
export function accountRoute(pathname: string): AccountRouteService | null {
  for (const [service, path] of ROUTES) if (pathname === path) return service;
  return null;
}

/** What a request may do with an account service, as the installation's admission decides it. */
export interface AccountAuthority {
  readonly actor: string;
  readonly administrator: boolean;
  readonly origin: string | null;
}

/** The installation services that decide account authority, as both front doors hold them. */
export interface InstallationAuthorityServices<Request> {
  /** Actor authentication for the model gateway; the Actor must be a Human. */
  readonly actorAccess: {
    authenticate(request: Request): { actorId: string } | null | undefined;
    readonly options: { trustedOrigin?(request: Request): string | null | undefined };
  };
  readonly actorStore: { get(actorId: string): { kind: string } | null | undefined };
  /** Instance admission; absent when the deployment has no membership. */
  readonly instanceAccess?: {
    authenticate(request: Request): { provider: string; subject: string } | null | undefined;
    role(principal: { provider: string; subject: string }): string | null | undefined;
    trustedOrigin(request: Request): string | null;
  } | null;
}

export interface AccountAuthorities<Request> {
  /** Policy: any admitted member reads; an administrator writes. The actor is the instance principal. */
  policy(request: Request): AccountAuthority | null;
  /** Gateway: a Human Actor; administration follows the instance role. */
  gateway(request: Request): AccountAuthority | null;
}

export function installationAccountAuthorities<Request>({
  actorAccess,
  actorStore,
  instanceAccess,
}: InstallationAuthorityServices<Request>): AccountAuthorities<Request> {
  return {
    policy(request) {
      const principal = instanceAccess?.authenticate(request);
      if (!principal || !instanceAccess!.role(principal)) return null;
      return {
        actor: JSON.stringify([principal.provider, principal.subject]),
        administrator: instanceAccess!.role(principal) === "admin",
        origin: instanceAccess!.trustedOrigin(request),
      };
    },
    gateway(request) {
      const context = actorAccess.authenticate(request);
      if (!context || actorStore.get(context.actorId)?.kind !== "human") return null;
      const principal = instanceAccess?.authenticate(request);
      return {
        actor: context.actorId,
        administrator: !!principal && instanceAccess!.role(principal) === "admin",
        origin: actorAccess.options.trustedOrigin?.(request) ?? null,
      };
    },
  };
}

/**
 * The account authority exchange: how the account's object asks the
 * installation's object about one request it is serving. Internal to the
 * deployment (one object calls the other through its binding); the entry
 * Worker never forwards this path.
 */
export const ACCOUNT_AUTHORITY_PATH = "/__opencraft_internal/account-authority";
export const WORKSPACE_CODEX_CATALOG_PATH = "/__opencraft_internal/workspace-codex-catalog";
export const WORKSPACE_CODEX_MODEL_DIRECTORY_PATH = "/__opencraft_internal/workspace-codex-model-directory";

/**
 * `gate`: the installation's admission gate for the request (a refusal or null);
 * `policy` / `gateway`: the account authority for it.
 */
export type AccountAuthorityScope = "gate" | AccountRouteService;

/** The request as the account's front door received it. */
export interface AccountAuthorityQuery {
  readonly scope: AccountAuthorityScope;
  readonly method: string;
  /** Path and query of the original request. */
  readonly path: string;
  /** Lower-case header names, as the HTTP exchange's request view holds them (including `host`). */
  readonly headers: Readonly<Record<string, string>>;
}

export type AccountAuthorityAnswer =
  | { readonly scope: "gate"; readonly refusal: InstallationReply | null }
  | { readonly scope: AccountRouteService; readonly authority: AccountAuthority | null };

const SCOPES: readonly AccountAuthorityScope[] = ["gate", "policy", "gateway"];

/** Validates a query at the installation's side of the exchange; throws on anything else. */
export function parseAccountAuthorityQuery(value: unknown): AccountAuthorityQuery {
  const query = value as Partial<AccountAuthorityQuery> | null;
  if (
    !query ||
    typeof query !== "object" ||
    !SCOPES.includes(query.scope as AccountAuthorityScope) ||
    typeof query.method !== "string" ||
    typeof query.path !== "string" ||
    !query.path.startsWith("/") ||
    !query.headers ||
    typeof query.headers !== "object" ||
    Array.isArray(query.headers) ||
    Object.entries(query.headers).some(([name, item]) => name !== name.toLowerCase() || typeof item !== "string")
  )
    throw new TypeError("Invalid account authority query");
  return { scope: query.scope!, method: query.method, path: query.path, headers: { ...query.headers } };
}

/** The request view the installation's authentication ports read for a query (the HTTP exchange's shape). */
export function accountAuthorityRequestView(query: AccountAuthorityQuery) {
  const headers: Record<string, string | undefined> = { ...query.headers };
  return {
    headers,
    rawHeaders: Object.entries(query.headers).flat(),
    method: query.method,
    url: query.path,
  };
}

/** Validates an answer at the account's side of the exchange. */
export function parseAccountAuthorityAnswer(scope: AccountAuthorityScope, value: unknown): AccountAuthorityAnswer {
  const answer = value as Record<string, unknown> | null;
  if (!answer || answer.scope !== scope) throw new TypeError("Invalid account authority answer");
  if (scope === "gate") {
    const refusal = answer.refusal as InstallationReply | null;
    if (refusal !== null && (typeof refusal !== "object" || !["json", "html"].includes(refusal.kind)))
      throw new TypeError("Invalid account authority answer");
    return { scope, refusal };
  }
  const authority = answer.authority as AccountAuthority | null;
  if (
    authority !== null &&
    (typeof authority !== "object" ||
      typeof authority.actor !== "string" ||
      typeof authority.administrator !== "boolean" ||
      (authority.origin !== null && typeof authority.origin !== "string"))
  )
    throw new TypeError("Invalid account authority answer");
  return { scope, authority };
}
