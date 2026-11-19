import { CodexAccountOperationError } from "./account-diagnostics.js";
import { requiresModelGateway } from "./model-gateway-connection.js";
import { bindModelGatewaySponsor } from "./model-gateway-sponsor.js";
import { configuredModelGatewayPath, ModelGatewayError } from "./model-gateway-store.js";
import { meteredModelRequest } from "./model-gateway-meter.js";
import { creditBalanceText, ExternalCodexCredentialError } from "./store.js";
import { EXTERNAL_CODEX_REAUTH_MESSAGE } from "./codex-auth-file.js";
import type {
  AccountPoolAccount,
  AccountPoolLimitWindow,
  AccountPoolQuotaObservation,
  AccountPoolSecret,
  AccountPoolStore,
} from "./store.js";
import type { AccountCredentialRefreshReason } from "./oauth-refresh.js";
import { ACCOUNT_POOL_MAX_REQUEST_BYTES } from "./request-limits.js";
import { Agent, fetch as undiciFetch } from "undici";
import { CONFIGURED_CODEX_MODEL_PREFIX, type ConfiguredCodexResponses } from "./configured-responses.js";
import { responsesPayloadForOpenAI } from "./foreign-history.js";
import { decodeResponsesRequestBody, forwardConfiguredResponses, forwardedResponseHeaders } from "./configured-forward.js";

const HOST_TOKEN_HEADER = "x-opencraft-account-pool-token";
/** Host-token identities for non-Codex model callers. They may only use provider passthrough. */
export const PROXY_CALLER_PREFIX = "caller:";
export const PROXY_CALLERS = Object.freeze(["caller:pi", "caller:dsh", "caller:assistant"]);
// SDKs join base URLs differently (Anthropic appends /v1/messages, OpenAI /responses); accept up to two /v1 prefixes.
const PROVIDER_ROUTE = /^\/providers\/([^/]{1,256})(?:\/v1){0,2}\/(messages|responses)$/u;
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-encoding",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "thread-id",
  "user-agent",
  "x-codex-turn-metadata",
  "x-openai-internal-codex-responses-lite",
  "x-openai-product-sku",
]);

function upstreamUrl(base: string, requestUrl: string): string {
  const root = new URL(base);
  if (root.protocol !== "https:" && root.protocol !== "http:") throw new TypeError("Invalid Codex upstream URL");
  if (root.username || root.password || root.search || root.hash) throw new TypeError("Invalid Codex upstream URL");
  const request = new URL(requestUrl);
  // Codex's local OpenAI-compatible provider uses /v1; ChatGPT Codex does not.
  root.pathname = request.pathname === "/api/codex/ps/mcp"
    ? `${root.pathname.replace(/\/codex\/?$/u, "")}/ps/mcp`
    : `${root.pathname.replace(/\/+$/u, "")}${request.pathname.replace(/^\/v1(?=\/)/u, "")}`;
  root.search = request.search;
  return root.toString();
}

function parseJson(body: Uint8Array): Record<string, unknown> | null {
  if (body.byteLength === 0) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 512 ? value.trim() : null;
}

function affinity(request: Request, body: Uint8Array): { affinityId: string; parentAffinityId: string | null } {
  const parsed = parseJson(body);
  const client = object(parsed?.client_metadata);
  const turn = (() => {
    const raw = request.headers.get("x-codex-turn-metadata");
    if (!raw) return null;
    try { return object(JSON.parse(raw)); } catch { return null; }
  })();
  const affinityId = text(request.headers.get("thread-id"))
    ?? text(turn?.thread_id)
    ?? text(client?.thread_id)
    ?? text(request.headers.get("session-id"))
    ?? text(request.headers.get("session_id"))
    ?? text(client?.session_id)
    ?? text(parsed?.prompt_cache_key)
    ?? "catalog";
  const parentAffinityId = text(turn?.forked_from_thread_id)
    ?? text(request.headers.get("x-codex-parent-thread-id"))
    ?? text(client?.["x-codex-parent-thread-id"]);
  return { affinityId, parentAffinityId: parentAffinityId === affinityId ? null : parentAffinityId };
}

function requestHeaders(inbound: Headers, accessToken: string, upstreamAccountId: string): Headers {
  const headers = new Headers();
  for (const [name, value] of inbound) {
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.has(lower) || lower.startsWith("x-codex-") || lower.startsWith("x-stainless-")) {
      headers.set(lower, value);
    }
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("chatgpt-account-id", upstreamAccountId);
  return headers;
}

const responseHeaders = forwardedResponseHeaders;

function quotaFromHeaders(headers: Headers, now: number, status: number): AccountPoolQuotaObservation | null {
  const credits = headers.get("x-codex-credits-has-credits"), unlimited = headers.get("x-codex-credits-unlimited");
  const creditsAvailable = status === 429 ? false
    : credits !== null || unlimited !== null ? status >= 200 && status < 300 && (credits?.toLowerCase() === "true" || unlimited?.toLowerCase() === "true") : undefined;
  const windows = (["primary", "secondary"] as const).flatMap<AccountPoolLimitWindow>(slot => {
    const prefix = `x-codex-${slot}`;
    const raw = headers.get(`${prefix}-used-percent`);
    const overLimit = headers.get(`${prefix}-over-limit`)?.toLowerCase() === "true";
    const percent = raw === null ? null : Number(raw);
    const resetAt = Number(headers.get(`${prefix}-reset-at`));
    const resetAfter = Number(headers.get(`${prefix}-reset-after-seconds`));
    const windowMinutes = Number(headers.get(`${prefix}-window-minutes`));
    const utilization = overLimit
      ? 1
      : percent !== null && Number.isFinite(percent)
        ? Math.max(0, Math.min(1, percent / 100))
        : null;
    const reset = Number.isFinite(resetAt) && resetAt > 0
        ? Math.round(resetAt * 1_000)
        : Number.isFinite(resetAfter) && resetAfter > 0
          ? now + Math.round(resetAfter * 1_000)
          : null;
    if (utilization === null && reset === null && !overLimit) return [];
    return [{
      slot,
      windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.round(windowMinutes) : null,
      utilization,
      resetAt: reset,
      status: overLimit || utilization === 1 ? "rejected" : null,
      observedAt: now,
      source: "header",
      ...(creditsAvailable === undefined ? {} : {
        creditsAvailable,
        creditsUnlimited: unlimited?.toLowerCase() === "true",
        creditBalance: creditBalanceText(headers.get("x-codex-credits-balance")),
      }),
    }];
  });
  if (windows.length === 0) return null;
  return {
    utilization: windows.reduce<number | null>((maximum, window) => window.utilization === null ? maximum : Math.max(maximum ?? 0, window.utilization), null),
    resetAt: windows.reduce<number | null>((latest, window) => window.resetAt === null ? latest : Math.max(latest ?? 0, window.resetAt), null),
    limitWindows: windows,
  };
}

async function isQuotaRejection(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  if (["primary", "secondary"].some(slot => {
    const prefix = `x-codex-${slot}`;
    const used = Number(response.headers.get(`${prefix}-used-percent`));
    return (Number.isFinite(used) && used >= 100)
      || response.headers.get(`${prefix}-over-limit`)?.toLowerCase() === "true";
  })) return true;
  // Native Codex also recognizes an explicit usage rejection without quota
  // headers. Ordinary burst rate limits must retain the original response.
  try {
    const payload = object(await response.clone().json());
    return object(payload?.error)?.type === "usage_limit_reached";
  } catch { return false; }
}

function transportError(error: unknown): { code: string | null; name: string | null; message: string | null } {
  const detail = error !== null && typeof error === "object"
    ? error as { cause?: unknown; code?: unknown; name?: unknown; message?: unknown }
    : null;
  const cause = detail?.cause !== null && typeof detail?.cause === "object"
    ? detail.cause as { code?: unknown; name?: unknown; message?: unknown }
    : detail;
  return {
    code: typeof cause?.code === "string" ? cause.code : null,
    name: typeof cause?.name === "string" ? cause.name : null,
    message: typeof cause?.message === "string" ? cause.message.slice(0, 200) : null,
  };
}

function createUpstreamFetch(override?: typeof fetch): typeof fetch {
  if (override !== undefined) return override;
  const dispatcher = new Agent({
    connections: 16,
    pipelining: 1,
    allowH2: false,
    headersTimeout: 120_000,
    bodyTimeout: 180_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
  });
  console.info("[opencraft account-pool]", JSON.stringify({
    event: "transport-config",
    protocol: "http/1.1",
    maxConnections: 16,
    pipelining: 1,
    headersTimeoutMs: 120_000,
    bodyTimeoutMs: 180_000,
  }));
  return ((input, init) => undiciFetch(input instanceof Request ? input.url : input, {
    ...init,
    dispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof fetch;
}

export class CodexAccountPoolProxy {
  handoffAffinities() { return [...this.imageTurns].sort(([a], [b]) => a.localeCompare(b)); }
  restoreAffinities(rows: ReturnType<CodexAccountPoolProxy["handoffAffinities"]>): void {
    if (!Array.isArray(rows) || rows.length > 8192) throw new Error("Invalid image affinities");
    for (const [key, row] of rows) {
      if (typeof key !== "string" || key.length > 2048 || !row || typeof row.affinityId !== "string"
        || row.affinityId.length > 512 || !Number.isSafeInteger(row.expiresAt) || this.imageTurns.has(key)) throw new Error("Invalid image affinity");
      this.imageTurns.set(key, row);
    }
  }
  private readonly imageTurns = new Map<string, { affinityId: string; expiresAt: number }>();
  private readonly store: AccountPoolStore;
  private readonly privateHostId?: string;
  private readonly personalRoute?: (request: Request) => Promise<Response | null>;
  private readonly upstreamBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly configuredResponses?: ConfiguredCodexResponses;
  private readonly resolveCredential?: (
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ) => Promise<AccountPoolSecret>;

  constructor(options: {
    readonly privateHostId?: string;
    readonly personalRoute?: (request: Request) => Promise<Response | null>;
    readonly configuredResponses?: ConfiguredCodexResponses;
    readonly store: AccountPoolStore;
    readonly upstreamBaseUrl: string;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly resolveCredential?: (
      account: AccountPoolAccount,
      secret: AccountPoolSecret,
      reason: AccountCredentialRefreshReason,
    ) => Promise<AccountPoolSecret>;
  }) {
    this.store = options.store;
    this.privateHostId = options.privateHostId;
    this.personalRoute = options.personalRoute;
    this.configuredResponses = options.configuredResponses;
    this.upstreamBaseUrl = options.upstreamBaseUrl;
    this.fetch = createUpstreamFetch(options.fetch);
    this.now = options.now ?? Date.now;
    this.resolveCredential = options.resolveCredential;
  }

  async handle(request: Request, onDispatch?: () => void): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/providers/")) return this.handleProvider(request, onDispatch);
    const personal = await this.personalRoute?.(request);
    if (personal) return personal;
    const path = configuredModelGatewayPath();
    if (!path) return this.handleUnmetered(request, onDispatch);
    const route = new URL(request.url).pathname;
    if (route !== "/v1/responses" || request.method !== "POST") {
      return this.handleUnmetered(request, onDispatch);
    }
    if (this.store.authenticateHostToken(request.headers.get(HOST_TOKEN_HEADER) ?? "") === null)
      return new Response(null, {status:401});
    try {
      const bytes = new Uint8Array(await request.clone().arrayBuffer());
      if (bytes.byteLength > ACCOUNT_POOL_MAX_REQUEST_BYTES) return new Response(null,{status:413});
      const decoded = await decodeResponsesRequestBody(request.headers.get("content-encoding"), bytes);
      if (decoded instanceof Response) return decoded;
      const payload = parseJson(decoded), identity = affinity(request, decoded);
      if (!requiresModelGateway(payload?.model, path)) return this.handleUnmetered(request, onDispatch);
      if (identity.affinityId === "catalog" || typeof payload?.model !== "string")
        throw new ModelGatewayError("gateway_human_sponsor_required",403);
      if (identity.parentAffinityId) bindModelGatewaySponsor(identity.affinityId,null,
        id => id === identity.affinityId ? identity.parentAffinityId : null,path);
      let turn: string | null = null;
      try {turn=text(object(JSON.parse(request.headers.get("x-codex-turn-metadata")??"null"))?.turn_id);}catch{/* Modern execution admission fails closed below. */}
      return await meteredModelRequest({path,thread:identity.affinityId,turn,model:payload.model,signal:request.signal,
        send: dispatch => this.handleUnmetered(request, credential => {dispatch(credential);onDispatch?.();})});
    } catch (error) {
      const known = error instanceof ModelGatewayError;
      const code = known ? error.kind : "gateway_unavailable";
      return Response.json({error:{message:code,code}},{status:known ? error.status : 503});
    }
  }

  /** Native-protocol passthrough to an installation-configured provider for non-Codex callers. The caller presents
   * only its proxy token; the provider credential is resolved here and never returned. No retry, no conversion. */
  private async handleProvider(request: Request, onDispatch?: () => void): Promise<Response> {
    const url = new URL(request.url), match = PROVIDER_ROUTE.exec(url.pathname);
    // Anthropic SDKs add ?beta=true; query parameters are not forwarded.
    if (!match || request.method !== "POST" || [...url.searchParams.keys()].some(key => key !== "beta")) return Response.json({ error: { message: "Proxy provider route not found" } }, { status: 404 });
    if (this.privateHostId) return new Response(null, { status: 401 });
    const presented = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? request.headers.get(HOST_TOKEN_HEADER) ?? "";
    const caller = this.store.authenticateHostToken(presented);
    if (caller === null || !caller.startsWith(PROXY_CALLER_PREFIX)) return new Response(null, { status: 401 });
    let providerId: string;
    try { providerId = decodeURIComponent(match[1]!); } catch { return Response.json({ error: { message: "Invalid provider" } }, { status: 404 }); }
    const protocol = match[2] === "messages" ? "anthropic-messages" : "openai-responses";
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > ACCOUNT_POOL_MAX_REQUEST_BYTES) return Response.json({ error: { message: "Request too large" } }, { status: 413 });
    const payload = parseJson(body), model = text(payload?.model);
    if (!payload || !model) return Response.json({ error: { message: "A model is required" } }, { status: 400 });
    const publicModel = CONFIGURED_CODEX_MODEL_PREFIX + encodeURIComponent(providerId) + "/" + encodeURIComponent(model);
    const meteredPath = configuredModelGatewayPath();
    if (meteredPath && requiresModelGateway(publicModel, meteredPath))
      return Response.json({ error: { message: "gateway_human_sponsor_required", code: "gateway_human_sponsor_required" } }, { status: 403 });
    let configured;
    try { configured = await this.configuredResponses?.resolve(publicModel); }
    catch { return Response.json({ error: { message: "Configured model connection is unavailable" } }, { status: 503 }); }
    if (!configured) return Response.json({ error: { message: "Configured model is disabled or unavailable" } }, { status: 404 });
    if ((configured.protocol ?? "openai-responses") !== protocol) return Response.json({ error: { message: "Provider protocol mismatch" } }, { status: 400 });
    const endpoint = new URL(configured.baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      return Response.json({ error: { message: "Invalid configured model endpoint" } }, { status: 503 });
    const anthropic = protocol === "anthropic-messages";
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") + (anthropic ? "/messages" : "/responses");
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["accept", ...(anthropic ? ["anthropic-version", "anthropic-beta"] : [])]) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    if (anthropic && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    if (configured.apiKey) headers.set(anthropic ? "x-api-key" : "authorization", anthropic ? configured.apiKey : `Bearer ${configured.apiKey}`);
    request.signal.throwIfAborted();
    onDispatch?.();
    const startedAt = this.now();
    let upstream: Response;
    try {
      upstream = await this.fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...payload, model: configured.model }), signal: request.signal, redirect: "error" });
    } catch (error) {
      console.warn(JSON.stringify({ event: "proxy-provider-failure", caller, provider: providerId, model, durationMs: this.now() - startedAt }));
      throw error;
    }
    console.info(JSON.stringify({ event: "proxy-provider-forward", caller, provider: providerId, model, status: upstream.status, headersMs: this.now() - startedAt }));
    return new Response(upstream.body, { status: upstream.status, headers: forwardedResponseHeaders(upstream.headers) });
  }

  private async handleUnmetered(request: Request, onDispatch?: (credential?: string) => void): Promise<Response> {
    const route = new URL(request.url).pathname;
    const imageRequest = request.method === "POST" && ["/v1/images/generations", "/v1/images/edits"].includes(route);
    const mcpRequest = route === "/api/codex/ps/mcp" && ["GET", "POST", "DELETE"].includes(request.method);
    if (!(mcpRequest || imageRequest || (route === "/v1/responses" && request.method === "POST") || (route === "/v1/models" && request.method === "GET"))) {
      return Response.json({ error: { message: "Account Pool route not found" } }, { status: 404 });
    }
    const hostId = mcpRequest
      ? this.store.authenticateHostToken(request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "", new URL(request.url).origin)
      : this.store.authenticateHostToken(request.headers.get(HOST_TOKEN_HEADER) ?? "");
    if (hostId === null || hostId.startsWith(PROXY_CALLER_PREFIX)
      || (this.privateHostId ? hostId !== this.privateHostId : hostId.startsWith("personal-subscription:"))) return new Response(null, { status: 401 });
    const body = request.method === "GET" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > ACCOUNT_POOL_MAX_REQUEST_BYTES) return Response.json({ error: { message: "Request too large" } }, { status: 413 });
    // Resolve configured models before touching OAuth account affinity, quotas or credentials.
    let decoded: Uint8Array = body;
    if (route === "/v1/responses") {
      const result = await decodeResponsesRequestBody(request.headers.get("content-encoding"), body);
      if (result instanceof Response) return result;
      decoded = result;
    }
    const payload = route === "/v1/responses" ? parseJson(decoded) : null;
    if (typeof payload?.model === "string" && payload.model.startsWith(CONFIGURED_CODEX_MODEL_PREFIX)) {
      let configured;
      try { configured = await this.configuredResponses?.resolve(payload.model); }
      catch { return Response.json({ error: { message: "Configured Codex model connection is unavailable" } }, { status: 503 }); }
      if (!configured) return Response.json({ error: { message: "Configured Codex model is disabled or unavailable" } }, { status: 404 });
      // Never forward local Host/OAuth headers; never retry or fall back across providers.
      return forwardConfiguredResponses({ configured, payload, publicModel: payload.model, accept: request.headers.get("accept"),
        signal: request.signal, fetch: this.fetch, onDispatch: () => onDispatch?.(payload.model as string) });
    }
    // After a switch away from a configured Anthropic model, its bridge-only history must not reach OpenAI.
    const sanitized = payload ? responsesPayloadForOpenAI(payload) : null;
    const forwardBody = sanitized ? new TextEncoder().encode(JSON.stringify(sanitized)) : body;
    let extraModels: readonly Record<string, unknown>[] = [];
    if (route === "/v1/models") {
      try { extraModels = await this.configuredResponses?.catalog() ?? []; }
      catch { console.warn("[opencraft account-pool] configured model catalog is unavailable"); }
    }
    const catalogResponse = async (upstream: Response) => {
      if (!extraModels.length || !upstream.ok || route !== "/v1/models") return upstream;
      const catalog = object(await upstream.json());
      if (!catalog || !Array.isArray(catalog.models)) throw new Error("Invalid Codex model catalog");
      const ids = new Set(catalog.models.map(model => object(model)?.slug));
      return Response.json({ ...catalog, models: [...catalog.models, ...extraModels.filter(model => !ids.has(model.slug))] });
    };
    let identity = affinity(request, body);
    if (mcpRequest) {
      const metadata = object(object(parseJson(body)?.params)?._meta);
      identity = { affinityId: text(metadata?.threadId) ?? "catalog", parentAffinityId: null };
    }
    // Images carry the native turn ID instead of the Responses thread metadata.
    // Never admit an image as a new, unrelated pooled conversation.
    if (imageRequest) {
      const turnId = text(request.headers.get("x-codex-image-turn-id"));
      const turn = turnId === null ? undefined : this.imageTurns.get(`${hostId}\0${turnId}`);
      if (turn === undefined || turn.expiresAt <= this.now()) {
        return Response.json({ error: { message: "Image generation requires a known active Codex turn" } }, { status: 409 });
      }
      identity = { affinityId: turn.affinityId, parentAffinityId: null };
    } else if (route === "/v1/responses") {
      let metadata: Record<string, unknown> | null = null;
      try { metadata = object(JSON.parse(request.headers.get("x-codex-turn-metadata") ?? "null")); } catch { /* No native turn metadata. */ }
      const turnId = text(metadata?.turn_id);
      if (turnId !== null && identity.affinityId !== "catalog") {
        for (const [key, turn] of this.imageTurns) if (turn.expiresAt <= this.now()) this.imageTurns.delete(key);
        const key = `${hostId}\0${turnId}`;
        this.imageTurns.delete(key);
        this.imageTurns.set(key, { affinityId: identity.affinityId, expiresAt: this.now() + 24 * 60 * 60 * 1_000 });
        while (this.imageTurns.size > 8_192) this.imageTurns.delete(this.imageTurns.keys().next().value!);
      }
    }
    const attempted = new Set<string>();
    const refreshedAfterUnauthorized = new Set<string>();
    let lastFailure: { status: number; message: string } | null = null;
    while (attempted.size < 64) {
      let selection;
      try {
        selection = this.store.select({ provider: "codex", hostId, ...identity, excludeAccountIds: attempted,
          purpose: request.method === "GET" || (mcpRequest && identity.affinityId === "catalog") ? "metadata" : "conversation" });
      } catch (error) {
        if (error instanceof ExternalCodexCredentialError) {
          this.store.markAccountError(error.accountId, "authorization-rejected");
          attempted.add(error.accountId);
          lastFailure = { status: 401, message: error.message };
          continue;
        }
        if (lastFailure === null && error instanceof Error && error.message === "No eligible account") {
          const externalIds = new Set(this.store.listAccounts()
            .filter(account => account.enabled && account.credentialSource === "external-file").map(account => account.id));
          if (this.store.listAccountStates().some(state => externalIds.has(state.accountId) && state.error === "authorization-rejected")) {
            lastFailure = { status: 401, message: EXTERNAL_CODEX_REAUTH_MESSAGE };
          }
        }
        if (route === "/v1/models" && extraModels.length) return Response.json({ models: extraModels });
        return lastFailure === null
          ? Response.json({ error: { message: "No eligible Codex account" } }, { status: 429 })
          : Response.json({ error: { message: lastFailure.message } }, { status: lastFailure.status });
      }
      if (selection.keepsAffinity && selection.retryAfterMs > 0) {
        return Response.json(
          { error: { message: "The current Codex account is temporarily rate limited" } },
          { status: 429, headers: { "retry-after": String(Math.ceil(selection.retryAfterMs / 1_000)) } },
        );
      }
      let secret = selection.secret;
      if (this.resolveCredential !== undefined && secret.expiresAt !== null && secret.expiresAt <= this.now() + 60_000) {
        try {
          secret = await this.resolveCredential(selection.account, secret, "expired");
          if (!secret.external) this.store.replaceCredential(selection.account.id, secret, { preserveAuthorizationError: true });
        } catch (error) {
          if (error instanceof CodexAccountOperationError && error.diagnostic.retryable) {
            // Retryability describes renewal, not eligibility for this request.
            // No usable credential: exclude only this request's candidate without
            // disabling the account or claiming permanent authorization failure.
            lastFailure = { status: 503, message: error.message };
            attempted.add(selection.account.id);
            continue;
          }
          lastFailure = { status: 401, message: secret.external ? EXTERNAL_CODEX_REAUTH_MESSAGE : "Codex account authentication failed" };
          this.store.markAccountError(selection.account.id, "authorization-rejected");
          attempted.add(selection.account.id);
          continue;
        }
      }
      const upstreamStartedAt = this.now();
      let upstream: Response;
      try {
        const target = upstreamUrl(this.upstreamBaseUrl, request.url);
        const headers = requestHeaders(request.headers, secret.accessToken, selection.account.upstreamAccountId);
        if (sanitized) headers.delete("content-encoding"); // The rewritten body is sent decoded.
        request.signal.throwIfAborted();
        onDispatch?.(selection.account.id);
        upstream = await this.fetch(target, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "DELETE" ? {} : { body: forwardBody }),
          signal: request.signal,
        });
      } catch (error) {
        const detail = transportError(error);
        console.warn("[opencraft account-pool]", JSON.stringify({
          event: "upstream-transport-failure",
          affinityId: identity.affinityId,
          accountId: selection.account.id,
          durationMs: this.now() - upstreamStartedAt,
          ...detail,
        }));
        throw error;
      }
      const upstreamDurationMs = this.now() - upstreamStartedAt;
      if (upstreamDurationMs >= 10_000) {
        console.warn("[opencraft account-pool]", JSON.stringify({
          event: "upstream-slow-headers",
          affinityId: identity.affinityId,
          accountId: selection.account.id,
          durationMs: upstreamDurationMs,
          status: upstream.status,
        }));
      }
      // Image and hosted-tool failures do not describe text quota. Never replay
      // these mutations or mark an inference account unhealthy on their behalf.
      if (imageRequest || mcpRequest) {
        if (upstream.ok) selection.accept();
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers) });
      }
      const quota = quotaFromHeaders(upstream.headers, this.now(), upstream.status);
      if (quota !== null) this.store.observeQuota(selection.account.id, quota);
      if (await isQuotaRejection(upstream)) {
        lastFailure = { status: 429, message: "Codex account quota exhausted" };
        attempted.add(selection.account.id);
        await upstream.body?.cancel().catch(() => undefined);
        continue;
      }
      if (upstream.status === 401 || upstream.status === 403) {
        if (this.resolveCredential !== undefined && !refreshedAfterUnauthorized.has(selection.account.id)) {
          refreshedAfterUnauthorized.add(selection.account.id);
          await upstream.body?.cancel().catch(() => undefined);
          try {
            const refreshed = await this.resolveCredential(selection.account, secret, "unauthorized");
            if (!refreshed.external) this.store.replaceCredential(selection.account.id, refreshed, { preserveAuthorizationError: true });
            continue;
          } catch (error) {
            if (error instanceof CodexAccountOperationError && error.diagnostic.retryable) {
              // Retryability describes renewal, not eligibility for this request.
            // No usable credential: exclude only this request's candidate without
            // disabling the account or claiming permanent authorization failure.
            lastFailure = { status: 503, message: error.message };
            attempted.add(selection.account.id);
            continue;
            }
            // Only explicit terminal rejection below marks authorization failed.
          }
        }
        lastFailure = { status: upstream.status, message: secret.external ? EXTERNAL_CODEX_REAUTH_MESSAGE : "Codex account authentication failed" };
        this.store.markAccountError(selection.account.id, "authorization-rejected");
        attempted.add(selection.account.id);
        await upstream.body?.cancel().catch(() => undefined);
        continue;
      }
      if (upstream.ok) {
        if (this.store.readCredential(selection.account.id).accessToken === secret.accessToken) this.store.clearAuthorizationError(selection.account.id);
        selection.accept();
      }
      return catalogResponse(new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers),
      }));
    }
    return lastFailure === null
      ? Response.json({ error: { message: "No eligible Codex account" } }, { status: 429 })
      : Response.json({ error: { message: lastFailure.message } }, { status: lastFailure.status });
  }
}
