import { HostConnectionInterventionError, throwIfSignalAborted } from "@opencraft/workbench-runtime";
import type { LightVelaRuntimeCommandPort } from "./lightvela-runtime-command-port";
import { Utf8StreamDecoder } from "../lib/utf8";
import {
  consumeLightVelaWebLoginCallback,
  startLightVelaWebLogin,
} from "./lightvela-web-login";
import {
  LIGHTVELA_REGIONS,
  type LightVelaAccountPhase,
  type LightVelaBotInstance,
  type LightVelaRegion,
} from "./lightvela-account-contract";

export {
  LIGHTVELA_REGIONS,
  type LightVelaAccountPhase,
  type LightVelaBotInstance,
  type LightVelaRegion,
} from "./lightvela-account-contract";

export const LIGHTVELA_API_BASE = "https://api.lightvela.ai";
export const LIGHTVELA_TOKEN_KEY = "vela.lightvela.session-token.v1";
export const LIGHTVELA_ACTIVE_BOT_KEY = "vela.lightvela.active-bot.v1";
export const LIGHTVELA_REGION_KEY = "vela.lightvela.region.v1";
const SIGNED_OUT_KEY = "vela.lightvela.signed-out.v1";
const CACHE_SCOPE_KEY = "vela.lightvela.credential-scope.v1";
const UPSTREAM_AUTH_UNAUTHORIZED_EVENT = "lightclaw:auth-unauthorized";
export interface LightVelaAccountSnapshot {
  readonly region: LightVelaRegion;
  readonly authGeneration: number;
  readonly credentialScope: string;
  readonly revision: number;
  readonly phase: LightVelaAccountPhase;
  readonly bots: readonly LightVelaBotInstance[];
  /** Current physical Bot binding for the stable velahermes0 Host. */
  readonly activeBotId: string | null;
  readonly error: string | null;
  /** Account-center data is independent from the executable Bot catalog. */
  readonly details: LightVelaAccountDetailsSnapshot;
}

export interface LightVelaAccountProfile {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly pendingName: string | null;
  readonly nameAuditStatus: "pending" | "passed" | "failed" | null;
}

export interface LightVelaAccountSubscription {
  readonly code: string;
  readonly status: string;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
}

export interface LightVelaAccountPass {
  readonly passId: string;
  readonly bundleName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isolatedAt: string | null;
  readonly deletedAt: string | null;
  readonly creditsTotal: number;
  readonly creditsAvailable: number;
}

export interface LightVelaAccountDetailsSnapshot {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly profile: LightVelaAccountProfile | null;
  readonly subscription: LightVelaAccountSubscription | null;
  readonly pass: LightVelaAccountPass | null;
  readonly error: string | null;
}

interface ApiEnvelope<T> {
  readonly code: string;
  readonly data: T;
  readonly message: string;
  readonly request_id?: string;
}

interface BotListResponse {
  readonly items: readonly {
    readonly created_at: string;
    readonly instance_id: string;
    readonly name?: string;
    readonly status: string;
  }[];
}

interface AccountProfileResponse {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly avatarUrl?: string;
    readonly pendingName?: string;
    readonly nameAuditStatus?: "pending" | "passed" | "failed";
  };
}

interface CurrentSubscriptionResponse {
  readonly hasSubscription: boolean;
  readonly subscription?: {
    readonly code: string;
    readonly status: string;
    readonly currentPeriodStart?: string;
    readonly currentPeriodEnd?: string;
  } | null;
}

interface PassListResponse {
  readonly passes?: readonly {
    readonly pass_id: string;
    readonly bundle_name: string;
    readonly created_time: string;
    readonly expired_time: string;
    readonly isolated_time?: string | null;
    readonly deleted_time?: string | null;
    readonly credit_total: number;
    readonly credit_available: number;
  }[];
}

export interface LightVelaAccountServiceOptions {
  readonly apiBase?: string;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Browser-navigation-scoped PKCE transaction state; never stores credentials. */
  readonly transactionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly fetchImpl?: typeof fetch;
  readonly location?: Pick<Location, "origin" | "pathname" | "search" | "hash" | "assign">;
  readonly history?: Pick<History, "state" | "replaceState">;
  /** Optional data-plane command owner used while the matching Host is open. */
  readonly runtimeCommands?: LightVelaRuntimeCommandPort;
}

export interface LightVelaOAuthCallbackOptions {
  readonly storage?: Pick<Storage, "setItem" | "removeItem">;
  readonly location?: Pick<Location, "pathname" | "search" | "hash">;
  readonly history?: Pick<History, "state" | "replaceState">;
}

export interface LightVelaWebLoginCallbackOptions extends LightVelaAccountServiceOptions {}

/**
 * Consumes the OAuth credential before the asynchronous Workbench graph is
 * constructed. The callback belongs to the browser navigation lifetime: an
 * extension View may mount much later, or not mount at all on the returned
 * route.
 */
export function bootstrapLightVelaOAuthCallback(options: LightVelaOAuthCallbackOptions = {}): boolean {
  const storage = options.storage ?? globalThis.localStorage;
  const location = options.location ?? globalThis.location;
  const history = options.history ?? globalThis.history;
  const fragment = new URLSearchParams(location?.hash.slice(1) ?? "");
  const token = fragment.get("session_token")?.trim();
  if (!token || storage === undefined) return false;
  storage.setItem(LIGHTVELA_TOKEN_KEY, token);
  storage.removeItem(SIGNED_OUT_KEY);
  fragment.delete("session_token");
  const nextHash = fragment.toString();
  history?.replaceState(
    history.state,
    "",
    `${location?.pathname ?? "/"}${location?.search ?? ""}${nextHash ? `#${nextHash}` : ""}`,
  );
  return true;
}

export async function bootstrapLightVelaWebLoginCallback(options: LightVelaWebLoginCallbackOptions = {}): Promise<boolean> {
  const storage = options.storage ?? globalThis.localStorage;
  const transactionStorage = options.transactionStorage ?? globalThis.sessionStorage;
  const location = options.location ?? globalThis.location;
  const history = options.history ?? globalThis.history;
  if (storage === undefined || transactionStorage === undefined || location === undefined || history === undefined) return false;
  let result: Awaited<ReturnType<typeof consumeLightVelaWebLoginCallback>>;
  try {
    result = await consumeLightVelaWebLoginCallback({
      storage: transactionStorage,
      location,
      history,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      apiBases: { cn: LIGHTVELA_REGIONS.cn.apiBase, intl: LIGHTVELA_REGIONS.intl.apiBase },
    });
  } catch {
    // A failed or cancelled callback must not prevent the Workbench graph from
    // starting. The transaction owner has already retired its verifier and
    // restored the initiating same-origin route.
    return false;
  }
  if (result === null) return false;
  storage.setItem(LIGHTVELA_TOKEN_KEY, result.token);
  storage.setItem(LIGHTVELA_REGION_KEY, result.region);
  storage.removeItem(SIGNED_OUT_KEY);
  return true;
}

export interface LightVelaDebugCommandResult {
  readonly status: string;
  readonly exitCode: number;
  readonly output: string;
}

export interface LightVelaDebugCommandChunk {
  readonly stream: string;
  readonly chunk: string;
}

export interface LightVelaBotInstanceConfigResetResult {
  readonly keyId: string;
  readonly keyPrefix: string;
  readonly config: {
    readonly providerName: string;
    readonly baseUrl: string;
    readonly modelId: string;
    readonly api: string;
    readonly apiKey: string;
  };
}

export type LightVelaWhatsAppOnboardingStatus =
  | "installing"
  | "starting"
  | "waiting"
  | "connected"
  | "error"
  | "expired"
  | "cancelled";

export interface LightVelaWhatsAppOnboardingSession {
  readonly pairing_id: string;
  readonly status: LightVelaWhatsAppOnboardingStatus;
  readonly qr_payload?: string | null;
  readonly expires_at: string;
  readonly mode: "bot" | "self-chat";
  readonly allowed_users: string;
  readonly account_id?: string | null;
  readonly account_name?: string | null;
  readonly account_phone?: string | null;
  readonly error?: string | null;
}

export interface LightVelaWhatsAppOnboardingApplyResult {
  readonly ok: boolean;
  readonly platform: "whatsapp";
  readonly needs_restart?: boolean;
  readonly restart_started?: boolean;
  readonly restart_error?: string | null;
}

interface DebugExecStreamEvent {
  readonly type?: string;
  readonly stream?: string;
  readonly chunk?: string;
  readonly response?: { readonly status?: string; readonly exit_code?: number; readonly output?: string };
}

function parseDebugExecSsePart(part: string): { eventType: string; data: string } | null {
  let eventType = "";
  const dataLines: string[] = [];
  part.split("\n").forEach((rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  });
  return dataLines.length > 0 ? { eventType, data: dataLines.join("\n") } : null;
}

export class LightVelaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LightVelaApiError";
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly message?: string; readonly request_id?: string };
    return `${body.message || `HTTP ${response.status}`}${body.request_id ? ` request_id=${body.request_id}` : ""}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Owns only the LightVela browser account and Bot catalog. Hermes transports
 * borrow the current token through request(); they never persist credentials.
 */
export class LightVelaAccountService {
  private readonly apiBaseOverride?: string;
  private region: LightVelaRegion = "intl";
  private authGeneration = 0;
  private credentialScope: string = crypto.randomUUID();
  private authority = new AbortController();
  private signInOperation: Promise<void> | null = null;
  private signOutOperation: Promise<void> | null = null;
  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== SIGNED_OUT_KEY || event.newValue !== "true") return;
    this.invalidateAuthority();
    this.publish("anonymous", [], null, null);
  };
  private readonly onUpstreamUnauthorized = (): void => {
    this.storage?.removeItem(LIGHTVELA_TOKEN_KEY);
    this.storage?.setItem(SIGNED_OUT_KEY, "true");
    this.invalidateAuthority();
    this.publish("anonymous", [], null, null);
  };
  private readonly storage: LightVelaAccountServiceOptions["storage"];
  private readonly transactionStorage: LightVelaAccountServiceOptions["transactionStorage"];
  private readonly fetchImpl: typeof fetch;
  private readonly location: LightVelaAccountServiceOptions["location"];
  private readonly history: LightVelaAccountServiceOptions["history"];
  private readonly runtimeCommands: LightVelaRuntimeCommandPort | undefined;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private refreshGeneration = 0;
  private refreshOperation: Promise<readonly LightVelaBotInstance[]> | null = null;
  private detailsGeneration = 0;
  private detailsOperation: Promise<LightVelaAccountDetailsSnapshot> | null = null;
  private snapshot: LightVelaAccountSnapshot = Object.freeze({
    revision: 0,
    region: "intl",
    authGeneration: 0,
    credentialScope: "",
    phase: "anonymous",
    bots: Object.freeze([]),
    activeBotId: null,
    error: null,
    details: Object.freeze({ phase: "idle", profile: null, subscription: null, pass: null, error: null }),
  });

  constructor(options: LightVelaAccountServiceOptions = {}) {
    this.apiBaseOverride = options.apiBase?.replace(/\/$/u, "");
    this.storage = options.storage ?? globalThis.localStorage;
    this.transactionStorage = options.transactionStorage ?? globalThis.sessionStorage;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.location = options.location ?? globalThis.location;
    this.history = options.history ?? globalThis.history;
    this.runtimeCommands = options.runtimeCommands;
    this.region = this.storage?.getItem(LIGHTVELA_REGION_KEY) === "cn" ? "cn" : "intl";
    this.credentialScope = this.storage?.getItem(CACHE_SCOPE_KEY) || this.credentialScope;
    this.storage?.setItem(CACHE_SCOPE_KEY, this.credentialScope);
    this.snapshot = Object.freeze({ ...this.snapshot, region: this.region, credentialScope: this.credentialScope });
    globalThis.addEventListener?.("storage", this.onStorage);
    globalThis.addEventListener?.(UPSTREAM_AUTH_UNAUTHORIZED_EVENT, this.onUpstreamUnauthorized);
  }

  private get apiBase(): string {
    return this.apiBaseOverride ?? LIGHTVELA_REGIONS[this.region].apiBase;
  }

  selectRegion(region: LightVelaRegion): void {
    if (region !== "cn" && region !== "intl") throw new Error("Invalid LightVela region");
    if (region === this.region) return;
    if (this.hasStoredSession() || this.snapshot.phase === "authenticated" || this.signInOperation || this.signOutOperation) {
      throw new Error("Please sign out before switching LightVela region");
    }
    this.invalidateAuthority();
    this.region = region;
    this.storage?.setItem(LIGHTVELA_REGION_KEY, region);
    this.storage?.setItem(SIGNED_OUT_KEY, "true");
    this.storage?.removeItem(LIGHTVELA_ACTIVE_BOT_KEY);
    this.publish("anonymous", [], null, null);
  }

  getSnapshot = (): LightVelaAccountSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  hasStoredSession(): boolean {
    return (this.storage?.getItem(LIGHTVELA_TOKEN_KEY)?.trim().length ?? 0) > 0;
  }

  bootstrapOAuthFragment(): boolean {
    if (this.signOutOperation) return false;
    const accepted = bootstrapLightVelaOAuthCallback({
      storage: this.storage,
      location: this.location,
      history: this.history,
    });
    if (!accepted) return false;
    this.invalidateAuthority();
    return true;
  }

  async signIn(): Promise<void> {
    if (this.signInOperation) return this.signInOperation;
    if (this.signOutOperation) throw new Error("Sign out is still in progress");
    if (this.location === undefined) throw new Error("LightVela login requires a browser location");
    this.storage?.setItem(LIGHTVELA_REGION_KEY, this.region);
    if (this.transactionStorage === undefined) throw new Error("LightVela login requires browser session storage");
    const operation = startLightVelaWebLogin({
      apiBase: this.apiBase,
      region: this.region,
      storage: this.transactionStorage,
      location: this.location,
    }).catch((error: unknown) => {
      if (this.signInOperation === operation) this.signInOperation = null;
      throw error;
    });
    this.signInOperation = operation;
    return operation;
  }

  private invalidateAuthority(): void {
    this.credentialScope = crypto.randomUUID();
    this.storage?.setItem(CACHE_SCOPE_KEY, this.credentialScope);
    this.authGeneration += 1;
    this.authority.abort();
    this.authority = new AbortController();
    this.refreshGeneration += 1;
    this.refreshOperation = null;
    this.detailsGeneration += 1;
    this.detailsOperation = null;
  }

  signOut(): Promise<void> {
    if (this.signOutOperation) return this.signOutOperation;
    const apiBase = this.apiBase;
    const token = this.storage?.getItem(LIGHTVELA_TOKEN_KEY)?.trim();
    this.invalidateAuthority();
    this.storage?.removeItem(LIGHTVELA_TOKEN_KEY);
    this.storage?.removeItem(LIGHTVELA_ACTIVE_BOT_KEY);
    this.storage?.setItem(SIGNED_OUT_KEY, "true");
    this.publish("anonymous", [], null, null);
    const operation = (async () => {
      const response = await this.fetchImpl(`${apiBase}/auth/session`, {
        method: "DELETE", credentials: "include", cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok && response.status !== 401 && response.status !== 403) {
        throw new LightVelaApiError(await errorMessage(response), response.status);
      }
    })().finally(() => { this.signOutOperation = null; });
    this.signOutOperation = operation;
    return operation;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const payload = await this.requestJson<ApiEnvelope<T>>(path, init);
    return payload.data;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.storage?.getItem(SIGNED_OUT_KEY) === "true") {
      throw new LightVelaApiError("Please sign in to LightVela", 401);
    }
    const authority = this.authority;
    const headers = new Headers(init.headers);
    const token = this.storage?.getItem(LIGHTVELA_TOKEN_KEY)?.trim();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      credentials: "include",
      ...init,
      signal: init.signal ? AbortSignal.any([authority.signal, init.signal]) : authority.signal,
      // Account and Bot bindings are control-plane authority, never browser
      // cache material. A cached catalog can resurrect a deleted physical Bot
      // underneath the stable velahermes0 Host identity.
      cache: "no-store",
      headers,
    });
    throwIfSignalAborted(authority.signal);
    if (!response.ok) throw new LightVelaApiError(await errorMessage(response), response.status);
    const result = await response.json() as T;
    throwIfSignalAborted(authority.signal);
    return result;
  }

  resolveAssetUrl(path: string | null | undefined): string | null {
    const value = path?.trim();
    if (!value) return null;
    if (/^(?:https?:|data:|blob:)/iu.test(value)) return value;
    return `${this.apiBase}${value.startsWith("/") ? value : `/${value}`}`;
  }

  refreshAccountDetails(): Promise<LightVelaAccountDetailsSnapshot> {
    if (this.detailsOperation !== null) return this.detailsOperation;
    const operation = this.performAccountDetailsRefresh().finally(() => {
      if (this.detailsOperation === operation) this.detailsOperation = null;
    });
    this.detailsOperation = operation;
    return operation;
  }

  private async performAccountDetailsRefresh(): Promise<LightVelaAccountDetailsSnapshot> {
    const generation = ++this.detailsGeneration;
    this.publishDetails({ ...this.snapshot.details, phase: "loading", error: null });
    try {
      const profilePayload = await this.requestJson<AccountProfileResponse>("/auth/profile", { method: "GET" });
      const [subscriptionResult, passesResult] = await Promise.allSettled([
        this.requestJson<CurrentSubscriptionResponse>("/subscriptions/current", { method: "GET" }),
        this.request<PassListResponse>("/v1/passes", { method: "GET" }),
      ]);
      const subscriptionPayload = subscriptionResult.status === "fulfilled" ? subscriptionResult.value : null;
      const passPayload = passesResult.status === "fulfilled" ? passesResult.value : null;
      const latestPass = [...(passPayload?.passes ?? [])]
        .filter((pass) => !pass.deleted_time)
        .sort((left, right) => Date.parse(right.expired_time) - Date.parse(left.expired_time))[0] ?? null;
      const details: LightVelaAccountDetailsSnapshot = Object.freeze({
        phase: "ready",
        profile: Object.freeze({
          id: profilePayload.user.id,
          name: profilePayload.user.name?.trim() || "LightVela user",
          avatarUrl: this.resolveAssetUrl(profilePayload.user.avatarUrl),
          pendingName: profilePayload.user.pendingName?.trim() || null,
          nameAuditStatus: profilePayload.user.nameAuditStatus ?? null,
        }),
        subscription: subscriptionPayload?.hasSubscription && subscriptionPayload.subscription
          ? Object.freeze({
              code: subscriptionPayload.subscription.code,
              status: subscriptionPayload.subscription.status,
              currentPeriodStart: subscriptionPayload.subscription.currentPeriodStart ?? null,
              currentPeriodEnd: subscriptionPayload.subscription.currentPeriodEnd ?? null,
            })
          : null,
        pass: latestPass === null ? null : Object.freeze({
          passId: latestPass.pass_id,
          bundleName: latestPass.bundle_name,
          createdAt: latestPass.created_time,
          expiresAt: latestPass.expired_time,
          isolatedAt: latestPass.isolated_time ?? null,
          deletedAt: latestPass.deleted_time ?? null,
          creditsTotal: Math.max(0, latestPass.credit_total ?? 0),
          creditsAvailable: Math.max(0, latestPass.credit_available ?? 0),
        }),
        error: null,
      });
      if (generation === this.detailsGeneration) this.publishDetails(details);
      return details;
    } catch (error) {
      if (error instanceof LightVelaApiError && error.status === 401) {
        this.storage?.removeItem(LIGHTVELA_TOKEN_KEY);
        this.storage?.removeItem(LIGHTVELA_ACTIVE_BOT_KEY);
        this.storage?.setItem(SIGNED_OUT_KEY, "true");
        this.invalidateAuthority();
        this.publish("anonymous", [], null, null);
      }
      const details: LightVelaAccountDetailsSnapshot = Object.freeze({
        phase: "error",
        profile: null,
        subscription: null,
        pass: null,
        error: error instanceof Error ? error.message : String(error),
      });
      if (generation === this.detailsGeneration) this.publishDetails(details);
      throw error;
    }
  }

  async updateProfileName(name: string): Promise<LightVelaAccountProfile> {
    const normalized = name.trim();
    if (!normalized) throw new Error("Display name cannot be empty");
    const payload = await this.requestJson<AccountProfileResponse>("/auth/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: normalized }),
    });
    const profile: LightVelaAccountProfile = Object.freeze({
      id: payload.user.id,
      name: payload.user.name?.trim() || normalized,
      avatarUrl: this.resolveAssetUrl(payload.user.avatarUrl),
      pendingName: payload.user.pendingName?.trim() || null,
      nameAuditStatus: payload.user.nameAuditStatus ?? null,
    });
    this.publishDetails({ ...this.snapshot.details, phase: "ready", profile, error: null });
    return profile;
  }

  async uploadProfileAvatar(file: File): Promise<LightVelaAccountProfile> {
    const form = new FormData();
    form.append("file", file);
    const payload = await this.requestJson<AccountProfileResponse>("/auth/profile/avatar", {
      method: "PUT",
      body: form,
    });
    const profile: LightVelaAccountProfile = Object.freeze({
      id: payload.user.id,
      name: payload.user.name?.trim() || "LightVela user",
      avatarUrl: this.resolveAssetUrl(payload.user.avatarUrl),
      pendingName: payload.user.pendingName?.trim() || null,
      nameAuditStatus: payload.user.nameAuditStatus ?? null,
    });
    this.publishDetails({ ...this.snapshot.details, phase: "ready", profile, error: null });
    return profile;
  }

  async resetInstanceConfig(botId: string): Promise<LightVelaBotInstanceConfigResetResult> {
    const payload = await this.request<{
      readonly key_id: string;
      readonly key_prefix: string;
      readonly config: {
        readonly provider_name: string;
        readonly base_url: string;
        readonly model_id: string;
        readonly api: string;
        readonly api_key: string;
      };
    }>(`/v1/instances/${encodeURIComponent(botId)}/config/reset`, { method: "POST" });
    return {
      keyId: payload.key_id,
      keyPrefix: payload.key_prefix,
      config: {
        providerName: payload.config.provider_name,
        baseUrl: payload.config.base_url,
        modelId: payload.config.model_id,
        api: payload.config.api,
        apiKey: payload.config.api_key,
      },
    };
  }

  async startWhatsAppOnboarding(
    botId: string,
    input: { readonly mode?: "bot" | "self-chat"; readonly allowedUsers?: string } = {},
    signal?: AbortSignal,
  ): Promise<LightVelaWhatsAppOnboardingSession> {
    return this.requestRuntimeOrThrow(botId, "hermes/whatsapp/onboarding/start", {
      mode: input.mode ?? "bot",
      allowedUsers: input.allowedUsers ?? "",
    }, signal);
  }

  async getWhatsAppOnboarding(
    botId: string,
    pairingId: string,
    signal?: AbortSignal,
  ): Promise<LightVelaWhatsAppOnboardingSession> {
    return this.requestRuntimeOrThrow(
      botId,
      "hermes/whatsapp/onboarding/read",
      { pairingId },
      signal,
    );
  }

  async applyWhatsAppOnboarding(
    botId: string,
    pairingId: string,
    input: { readonly mode?: "bot" | "self-chat"; readonly allowedUsers?: string } = {},
    signal?: AbortSignal,
  ): Promise<LightVelaWhatsAppOnboardingApplyResult> {
    return this.requestRuntimeOrThrow(botId, "hermes/whatsapp/onboarding/apply", {
      pairingId,
      mode: input.mode ?? "bot",
      allowedUsers: input.allowedUsers ?? "",
    }, signal);
  }

  async cancelWhatsAppOnboarding(
    botId: string,
    pairingId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: boolean }> {
    return this.requestRuntimeOrThrow(
      botId,
      "hermes/whatsapp/onboarding/cancel",
      { pairingId },
      signal,
    );
  }

  private async requestRuntimeOrThrow<TResult>(
    botId: string,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const runtime = this.runtimeCommands?.requestIfAvailable;
    if (runtime === undefined) throw new Error("Hermes Host must be connected before WhatsApp setup");
    const authority = this.authority;
    const combinedSignal = signal === undefined
      ? authority.signal
      : AbortSignal.any([authority.signal, signal]);
    const result = await runtime.call(this.runtimeCommands, botId, method, params, {
      signal: combinedSignal,
      timeoutMs: 45_000,
    });
    throwIfSignalAborted(authority.signal);
    if (result === null) throw new Error("Hermes Host must be connected before WhatsApp setup");
    return result as TResult;
  }

  /**
   * The console and Workbench share this one control-plane command boundary.
   * HTTP failures carrying `details` still represent a completed command and
   * must be returned to the feature parser instead of erased as transport
   * errors.
   */
  async execDebugCommand(
    botId: string,
    command: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<LightVelaDebugCommandResult> {
    const controller = new AbortController();
    const timeout = options.timeoutMs === undefined
      ? undefined
      : globalThis.setTimeout(() => controller.abort(), options.timeoutMs);
    const authority = this.authority;
    try {
      const signal = AbortSignal.any([authority.signal, controller.signal]);
      const native = await this.runtimeCommands?.execIfAvailable(botId, command, undefined, {
        timeoutMs: options.timeoutMs,
        signal,
      });
      throwIfSignalAborted(authority.signal);
      if (native !== undefined && native !== null) return native;
      const path = `/v1/instances/${encodeURIComponent(botId)}/debug/exec`;
      const headers = new Headers({ "Content-Type": "application/json" });
      const token = this.storage?.getItem(LIGHTVELA_TOKEN_KEY)?.trim();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers,
        body: JSON.stringify({ command, run_as_user: "agentuser" }),
        signal,
      });
      const body = await response.json().catch(() => null) as {
        readonly data?: { readonly status?: string; readonly exit_code?: number; readonly output?: string };
        readonly details?: { readonly status?: string; readonly exit_code?: number; readonly output?: string };
      } | null;
      throwIfSignalAborted(authority.signal);
      const result = body?.details ?? body?.data;
      if (result && (typeof result.output === "string" || typeof result.exit_code === "number")) {
        return {
          status: result.status ?? "",
          exitCode: typeof result.exit_code === "number" ? result.exit_code : -1,
          output: result.output ?? "",
        };
      }
      if (!response.ok) {
        const failure = body as {
          readonly message?: string;
          readonly error?: string;
          readonly request_id?: string;
          readonly requestId?: string;
        } | null;
        const message = failure?.message?.trim() || failure?.error?.trim() || `HTTP ${response.status}`;
        const requestId = failure?.request_id?.trim() || failure?.requestId?.trim();
        throw new LightVelaApiError(`${message}${requestId ? ` request_id=${requestId}` : ""}`, response.status);
      }
      throw new LightVelaApiError("Invalid debug command response", response.status);
    } catch (error) {
      if (controller.signal.aborted && !authority.signal.aborted) {
        throw new Error(`Hermes command timed out after ${options.timeoutMs ?? 0} ms`);
      }
      throw error;
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }

  /** Direct copy of mono2's debug/exec SSE ownership boundary. */
  async execDebugCommandStream(
    botId: string,
    command: string,
    onChunk: (chunk: LightVelaDebugCommandChunk) => void,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<LightVelaDebugCommandResult> {
    const controller = new AbortController();
    const timeout = options.timeoutMs && options.timeoutMs > 0
      ? globalThis.setTimeout(() => controller.abort(), options.timeoutMs)
      : undefined;
    const authority = this.authority;
    try {
      const signal = AbortSignal.any([authority.signal, controller.signal]);
      const native = await this.runtimeCommands?.execIfAvailable(botId, command, onChunk, {
        timeoutMs: options.timeoutMs,
        signal,
      });
      throwIfSignalAborted(authority.signal);
      if (native !== undefined && native !== null) return native;
      const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream" });
      const token = this.storage?.getItem(LIGHTVELA_TOKEN_KEY)?.trim();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await this.fetchImpl(`${this.apiBase}/v1/instances/${encodeURIComponent(botId)}/debug/exec`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers,
        body: JSON.stringify({ command, run_as_user: "agentuser" }),
        signal,
      });
      if (!response.ok) throw new LightVelaApiError(await errorMessage(response), response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Command output stream is not readable.");
      const decoder = new Utf8StreamDecoder();
      let buffer = "";
      let output = "";
      let finalResponse: DebugExecStreamEvent["response"];
      let sawError = false;
      const consume = (part: string) => {
        const parsed = parseDebugExecSsePart(part);
        if (!parsed) return;
        let event: DebugExecStreamEvent;
        try { event = JSON.parse(parsed.data) as DebugExecStreamEvent; } catch { return; }
        const eventType = event.type || parsed.eventType;
        if ((eventType === "stdout" || eventType === "stderr") && event.chunk) {
          output += event.chunk;
          onChunk({ stream: event.stream || eventType, chunk: event.chunk });
        }
        if ((eventType === "finished" || eventType === "error") && event.response) finalResponse = event.response;
        if (eventType === "error") sawError = true;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? "";
          parts.forEach(consume);
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally { reader.releaseLock(); }
      throwIfSignalAborted(authority.signal);
      if (finalResponse) return {
        status: finalResponse.status || "FAILED",
        exitCode: typeof finalResponse.exit_code === "number" ? finalResponse.exit_code : -1,
        output: finalResponse.output || output,
      };
      return { status: output && !sawError ? "SUCCESS" : "FAILED", exitCode: output && !sawError ? 0 : -1, output };
    } catch (error) {
      if (controller.signal.aborted && !authority.signal.aborted) throw new Error(`debug_exec_timeout:${options.timeoutMs ?? 0}`);
      throw error;
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }

  refreshBots(): Promise<readonly LightVelaBotInstance[]> {
    if (this.refreshOperation !== null) return this.refreshOperation;
    const operation = this.performBotRefresh().finally(() => {
      if (this.refreshOperation === operation) this.refreshOperation = null;
    });
    this.refreshOperation = operation;
    return operation;
  }

  private async performBotRefresh(): Promise<readonly LightVelaBotInstance[]> {
    const generation = ++this.refreshGeneration;
    this.publish("loading", this.snapshot.bots, null, this.snapshot.activeBotId);
    try {
      const result = await this.request<BotListResponse>("/v1/instances?page=1&page_size=100");
      const bots = result.items
        .filter((bot) => bot.status.trim().toLowerCase() === "running")
        .map((bot) => Object.freeze({
          createdAt: bot.created_at,
          instanceId: bot.instance_id,
          name: bot.name?.trim() || "Untitled Bot",
          status: "running" as const,
        }));
      if (generation === this.refreshGeneration) {
        this.publish("authenticated", bots, null, this.reconcileActiveBot(bots));
      }
      return bots;
    } catch (error) {
      if (generation === this.refreshGeneration) {
        this.publish(
          error instanceof LightVelaApiError && error.status === 401 ? "anonymous" : "error",
          [],
          error instanceof Error ? error.message : String(error),
          null,
        );
      }
      throw error;
    }
  }

  /**
   * Changes only the physical Bot selected inside the LightVela account. The
   * Workbench Host identity remains velahermes0 and must never persist this
   * ephemeral instance ID as its namespace identity.
   */
  selectBot(instanceId: string): void {
    const normalized = instanceId.trim();
    if (this.snapshot.phase !== "authenticated") {
      throw new Error("A LightVela Bot can only be selected after authentication");
    }
    if (!this.snapshot.bots.some((bot) => bot.instanceId === normalized)) {
      throw new Error(`LightVela Bot ${normalized || "<empty>"} is not running`);
    }
    if (this.snapshot.activeBotId === normalized) return;
    this.storage?.setItem(LIGHTVELA_ACTIVE_BOT_KEY, normalized);
    this.publish("authenticated", this.snapshot.bots, null, normalized);
  }

  /** Resolves a fresh physical Bot binding for a new TAT connection. */
  async resolveActiveBot(): Promise<LightVelaBotInstance> {
    try {
      await this.refreshBots();
    } catch (cause) {
      if (this.snapshot.phase === "anonymous") {
        throw new HostConnectionInterventionError({
          code: "authentication-required",
          providerId: "lightvela.hermes",
          message: "Sign in to LightVela to continue",
          cause,
        });
      }
      throw cause;
    }
    const snapshot = this.snapshot;
    const bot = snapshot.activeBotId === null
      ? undefined
      : snapshot.bots.find((candidate) => candidate.instanceId === snapshot.activeBotId);
    if (snapshot.phase === "anonymous") {
      throw new HostConnectionInterventionError({
        code: "authentication-required",
        providerId: "lightvela.hermes",
        message: "Sign in to LightVela to continue",
      });
    }
    if (snapshot.phase !== "authenticated" || bot === undefined) {
      throw new HostConnectionInterventionError({
        code: "configuration-required",
        providerId: "lightvela.hermes",
        message: "No running LightVela Hermes Bot is available",
      });
    }
    return bot;
  }

  dispose(): void {
    globalThis.removeEventListener?.("storage", this.onStorage);
    globalThis.removeEventListener?.(UPSTREAM_AUTH_UNAUTHORIZED_EVENT, this.onUpstreamUnauthorized);
    this.invalidateAuthority();
    this.listeners.clear();
  }

  private publish(
    phase: LightVelaAccountPhase,
    bots: readonly LightVelaBotInstance[],
    error: string | null,
    activeBotId: string | null,
  ): void {
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      region: this.region,
      authGeneration: this.authGeneration,
      credentialScope: this.credentialScope,
      phase,
      bots: Object.freeze([...bots]),
      activeBotId,
      error,
      details: phase === "anonymous"
        ? Object.freeze({ phase: "idle", profile: null, subscription: null, pass: null, error: null })
        : this.snapshot.details,
    });
    for (const listener of this.listeners) listener();
  }

  private publishDetails(details: LightVelaAccountDetailsSnapshot): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      revision: ++this.revision,
      details: Object.freeze(details),
    });
    for (const listener of this.listeners) listener();
  }

  private reconcileActiveBot(bots: readonly LightVelaBotInstance[]): string | null {
    const candidates = [
      this.snapshot.activeBotId,
      this.storage?.getItem(LIGHTVELA_ACTIVE_BOT_KEY)?.trim() || null,
    ];
    const activeBotId = candidates.find((candidate) =>
      candidate !== null && bots.some((bot) => bot.instanceId === candidate))
      ?? bots[0]?.instanceId
      ?? null;
    if (activeBotId === null) this.storage?.removeItem(LIGHTVELA_ACTIVE_BOT_KEY);
    else this.storage?.setItem(LIGHTVELA_ACTIVE_BOT_KEY, activeBotId);
    return activeBotId;
  }
}
