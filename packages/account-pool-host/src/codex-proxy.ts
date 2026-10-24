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

const HOST_TOKEN_HEADER = "x-opencraft-account-pool-token";
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "thread-id",
  "user-agent",
  "x-codex-turn-metadata",
  "x-openai-internal-codex-responses-lite",
]);

function upstreamUrl(base: string, requestUrl: string): string {
  const root = new URL(base);
  if (root.protocol !== "https:" && root.protocol !== "http:") throw new TypeError("Invalid Codex upstream URL");
  if (root.username || root.password || root.search || root.hash) throw new TypeError("Invalid Codex upstream URL");
  const request = new URL(requestUrl);
  // Codex's local OpenAI-compatible provider uses /v1; ChatGPT Codex does not.
  root.pathname = `${root.pathname.replace(/\/+$/u, "")}${request.pathname.replace(/^\/v1(?=\/)/u, "")}`;
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

function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream) {
    const lower = name.toLowerCase();
    if (["content-type", "content-encoding", "cache-control", "retry-after"].includes(lower) || lower.startsWith("x-codex-")) {
      headers.set(lower, value);
    }
  }
  return headers;
}

function quotaFromHeaders(headers: Headers, now: number, status: number): AccountPoolQuotaObservation | null {
  const credits = headers.get("x-codex-credits-has-credits"), unlimited = headers.get("x-codex-credits-unlimited");
  const creditsAvailable = status === 429 ? false
    : credits !== null || unlimited !== null ? status >= 200 && status < 300 && (credits === "true" || unlimited === "true") : undefined;
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
      ...(creditsAvailable === undefined ? {} : { creditsAvailable }),
    }];
  });
  if (windows.length === 0) return null;
  return {
    utilization: windows.reduce<number | null>((maximum, window) => window.utilization === null ? maximum : Math.max(maximum ?? 0, window.utilization), null),
    resetAt: windows.reduce<number | null>((latest, window) => window.resetAt === null ? latest : Math.max(latest ?? 0, window.resetAt), null),
    limitWindows: windows,
  };
}

function isQuotaRejection(response: Response): boolean {
  if (response.status !== 429) return false;
  return ["primary", "secondary"].some(slot => {
    const prefix = `x-codex-${slot}`;
    const used = Number(response.headers.get(`${prefix}-used-percent`));
    return (Number.isFinite(used) && used >= 100)
      || response.headers.get(`${prefix}-over-limit`)?.toLowerCase() === "true";
  });
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
    headersTimeout: 60_000,
    bodyTimeout: 180_000,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
  });
  console.info("[opencraft account-pool]", JSON.stringify({
    event: "transport-config",
    protocol: "http/1.1",
    maxConnections: 16,
    pipelining: 1,
    headersTimeoutMs: 60_000,
    bodyTimeoutMs: 180_000,
  }));
  return ((input, init) => undiciFetch(input instanceof Request ? input.url : input, {
    ...init,
    dispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>) as typeof fetch;
}

export class CodexAccountPoolProxy {
  private readonly imageTurns = new Map<string, { affinityId: string; expiresAt: number }>();
  private readonly store: AccountPoolStore;
  private readonly upstreamBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly resolveCredential?: (
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ) => Promise<AccountPoolSecret>;

  constructor(options: {
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
    this.upstreamBaseUrl = options.upstreamBaseUrl;
    this.fetch = createUpstreamFetch(options.fetch);
    this.now = options.now ?? Date.now;
    this.resolveCredential = options.resolveCredential;
  }

  async handle(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    const imageRequest = request.method === "POST" && ["/v1/images/generations", "/v1/images/edits"].includes(route);
    if (!(imageRequest || (route === "/v1/responses" && request.method === "POST") || (route === "/v1/models" && request.method === "GET"))) {
      return Response.json({ error: { message: "Account Pool route not found" } }, { status: 404 });
    }
    const hostId = this.store.authenticateHostToken(request.headers.get(HOST_TOKEN_HEADER) ?? "");
    if (hostId === null) return new Response(null, { status: 401 });
    const body = request.method === "GET" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > ACCOUNT_POOL_MAX_REQUEST_BYTES) return Response.json({ error: { message: "Request too large" } }, { status: 413 });
    let identity = affinity(request, body);
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
        selection = this.store.select({ provider: "codex", hostId, ...identity, excludeAccountIds: attempted, purpose: request.method === "GET" ? "metadata" : "conversation" });
      } catch {
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
          if (!secret.external) this.store.replaceCredential(selection.account.id, secret);
        } catch {
          lastFailure = { status: 401, message: "Codex account authentication failed" };
          this.store.markAccountError(selection.account.id, "authorization-rejected");
          attempted.add(selection.account.id);
          continue;
        }
      }
      const upstreamStartedAt = this.now();
      let upstream: Response;
      try {
        upstream = await this.fetch(upstreamUrl(this.upstreamBaseUrl, request.url), {
          method: request.method,
          headers: requestHeaders(request.headers, secret.accessToken, selection.account.upstreamAccountId),
          ...(request.method === "GET" ? {} : { body }),
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
      // Image quota is independent of Codex text quota. Do not rotate accounts or
      // replay image mutations, and retain native image-specific failure details.
      if (imageRequest) {
        if (upstream.ok) selection.accept();
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers) });
      }
      const quota = quotaFromHeaders(upstream.headers, this.now(), upstream.status);
      if (quota !== null) this.store.observeQuota(selection.account.id, quota);
      if (isQuotaRejection(upstream)) {
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
            if (!refreshed.external) this.store.replaceCredential(selection.account.id, refreshed);
            continue;
          } catch {
            // The allow-listed terminal classification below owns failure state.
          }
        }
        lastFailure = { status: upstream.status, message: "Codex account authentication failed" };
        this.store.markAccountError(selection.account.id, "authorization-rejected");
        attempted.add(selection.account.id);
        await upstream.body?.cancel().catch(() => undefined);
        continue;
      }
      if (upstream.ok) selection.accept();
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers),
      });
    }
    return lastFailure === null
      ? Response.json({ error: { message: "No eligible Codex account" } }, { status: 429 })
      : Response.json({ error: { message: lastFailure.message } }, { status: lastFailure.status });
  }
}
