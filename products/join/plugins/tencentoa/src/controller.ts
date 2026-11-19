import { employeePhotoUrl } from "./photo";
import { TENCENTOA_SSH_CREDENTIALS_PATH, type EmployeeSshCredential } from './contract';
import { parsePrincipal } from "@opencraft/identity-core";
import type { AuthenticationResult, AuthenticationSession } from "@opencraft/workbench-runtime";
import { identityValidUntil, TENCENTOA_CLOCK_SKEW_MS, TENCENTOA_SERVER_DIAGNOSTIC_REASONS, TENCENTOA_SESSION_PATH, type TencentOaDiagnostic, type TencentOaIdentity, type TencentOaServerDiagnostic, type TencentOaSessionResponse } from "./contract";

const CORE_SESSION_PATH = "/__opencraft_access/session";
const serverReasons = new Set<string>(TENCENTOA_SERVER_DIAGNOSTIC_REASONS);

class SessionReadError extends Error {
  constructor(readonly failureKind: "invalid_json" | "invalid_schema" | "provider_mismatch") {
    super(failureKind);
    this.name = "SessionReadError";
  }
}

/** Older enrolled Hosts expose verified core identity without the product route. */
function employeeSession(value: unknown): TencentOaSessionResponse {
  if (!value || typeof value !== "object" || !("principal" in value) || !("role" in value)) throw new SessionReadError("invalid_schema");
  if (value.role !== null && value.role !== "member" && value.role !== "admin") throw new SessionReadError("invalid_schema");
  if (value.principal === null) return { available: true, identity: null };
  const principal = parsePrincipal(value.principal);
  if (principal.provider !== "tencentoa") throw new SessionReadError("provider_mismatch");
  if (value.role === null) return { available: true, identity: null };
  // Login names come from the verified provider attribute, never displayName.
  return { available: true, identity: {
    loginName: principal.attributes?.loginName ?? "", staffId: principal.subject,
    // Core expiresAt already includes the provider's existing clock tolerance.
    expiresAt: new Date(principal.expiresAt - TENCENTOA_CLOCK_SKEW_MS).toISOString(),
  } };
}

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { name?: unknown }).name;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { message?: unknown }).message;
  return typeof value === "string" ? value : null;
}

function failureKindFor(error: unknown): "timeout" | "network_or_redirect" {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_or_redirect";
}

function serverDiagnostic(value: unknown): TencentOaServerDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const reason = candidate.reason;
  if (typeof reason !== "string" || !serverReasons.has(reason)) return null;
  const result: { reason: TencentOaServerDiagnostic["reason"]; missingHeaders?: readonly string[]; presentHeaders?: readonly string[]; skewMs?: number } = { reason: reason as TencentOaServerDiagnostic["reason"] };
  const headerNames = (field: unknown): readonly string[] | undefined => {
    if (!Array.isArray(field) || field.length > 16 || !field.every(item => typeof item === "string" && /^[a-z0-9-]{1,64}$/u.test(item))) return undefined;
    return Object.freeze([...new Set(field as string[])]);
  };
  const missingHeaders = headerNames(candidate.missingHeaders);
  if (missingHeaders) result.missingHeaders = missingHeaders;
  const presentHeaders = headerNames(candidate.presentHeaders);
  if (presentHeaders) result.presentHeaders = presentHeaders;
  if (typeof candidate.skewMs === "number" && Number.isFinite(candidate.skewMs)) result.skewMs = candidate.skewMs;
  return Object.freeze(result);
}

function responseLocation(response: Response, endpoint: string): Pick<TencentOaDiagnostic, "origin" | "pathname"> {
  try {
    const base = typeof location === "undefined" ? undefined : location.href;
    const url = new URL(response.url || endpoint, base);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { origin: null, pathname: endpoint };
  }
}

export interface TencentOaSnapshot {
  readonly revision: number;
  readonly available: boolean | null;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly identity: TencentOaIdentity | null;
  /** Previously verified display metadata; never a valid authentication session. */
  readonly displayIdentity: Readonly<Pick<TencentOaIdentity, "loginName" | "staffId">> | null;
  readonly avatarUrl: string | null;
  /** Sanitized failure snapshot; null on the initial state and after a successful read. */
  readonly diagnostic: TencentOaDiagnostic | null;
}

/** In-memory per-client projection; only the backend supplies verified identity. */
export class TencentOaController {
  private snapshot: TencentOaSnapshot = Object.freeze({ revision: 0, available: null, phase: "idle", identity: null, displayIdentity: null, avatarUrl: null, diagnostic: null });
  private session: AuthenticationSession = Object.freeze({ status: "anonymous", epoch: 0 });
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private operation: Promise<void> | null = null;
  private lastValidated = -Infinity;
  private lastAttempt = -Infinity;
  private displayUntil = 0;

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly now = Date.now) {}
  getSnapshot = (): TencentOaSnapshot => this.snapshot;
  getSession = (): AuthenticationSession => this.session;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Private key reads are view-scoped; never enter identity snapshots or persistent preferences. */
  readSshCredential(signal: AbortSignal): Promise<EmployeeSshCredential | null> {
    return this.requestSshCredential(signal);
  }
  async generateSshCredential(expectedFingerprint: string | null, signal: AbortSignal): Promise<EmployeeSshCredential> {
    const credential = await this.requestSshCredential(signal, expectedFingerprint);
    if (!credential) throw Error('SSH credential unavailable');
    return credential;
  }
  private async requestSshCredential(signal: AbortSignal, expectedFingerprint?: string | null): Promise<EmployeeSshCredential | null> {
    const identity = this.snapshot.identity;
    if (!identity || identityValidUntil(identity) <= this.now()) throw Error('Employee login required');
    const scope = `tencentoa:${identity.staffId}`;
    const writing = expectedFingerprint !== undefined;
    const response = await this.fetcher(TENCENTOA_SSH_CREDENTIALS_PATH, { method: writing ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'x-opencraft-account-scope': scope, ...(writing ? { 'x-opencraft-ssh-key-fingerprint': expectedFingerprint ?? 'none' } : {}) } });
    // Older deployments can omit this optional employee capability.
    if (!writing && response.status === 404) return null;
    if (!response.ok) throw Error('SSH credential unavailable');
    const body = await response.json();
    if (signal.aborted || this.disposed || this.snapshot.identity?.staffId !== identity.staffId
      || this.snapshot.identity.loginName !== identity.loginName || identityValidUntil(this.snapshot.identity) <= this.now()) throw Error('Employee login changed');
    if (!body || body.scope !== scope || !Object.hasOwn(body, 'credential')) throw Error('Invalid credential response');
    if (body.credential === null) return null;
    const key = body.credential;
    if (!key || key.username !== identity.loginName || typeof key.privateKey !== 'string' || key.privateKey.length > 8192
      || !key.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n') || !key.privateKey.includes('-----END OPENSSH PRIVATE KEY-----')
      || typeof key.publicKey !== 'string' || !key.publicKey.startsWith('ssh-ed25519 ') || key.publicKey.length > 2048
      || typeof key.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(key.fingerprint)) throw Error('Invalid credential response');
    return { username: key.username, privateKey: key.privateKey, publicKey: key.publicKey, fingerprint: key.fingerprint };
  }

  /** Foreground recovery reuses fresh data and one in-flight request. Explicit refresh remains forced. */
  refreshIfNeeded(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if ((this.snapshot.identity && identityValidUntil(this.snapshot.identity) < this.now())
      || (this.snapshot.displayIdentity && this.now() >= this.displayUntil)) this.publish({});
    if (this.operation) return this.operation;
    const needsVerification = this.snapshot.displayIdentity !== null && (!this.snapshot.identity || identityValidUntil(this.snapshot.identity) - this.now() <= 30_000);
    if (this.snapshot.phase === "error" && this.now() - this.lastAttempt < 15_000) return Promise.resolve();
    if (!needsVerification && this.snapshot.phase !== "error" && this.now() - this.lastValidated < 60_000) return Promise.resolve();
    return this.refresh();
  }

  refresh(): Promise<void> {
    const operation = this.readIdentity();
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = null; });
    return operation;
  }

  private async readIdentity(): Promise<void> {
    if (this.disposed) return;
    this.lastAttempt = this.now();
    const generation = ++this.generation;
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    this.publish({ phase: "loading", diagnostic: null });
    // One owned controller carries cancellation and the 10s deadline. Safari 16.6
    // has neither AbortSignal.any nor a reason to split those owners.
    const timeout = setTimeout(() => request.abort(new DOMException("The operation timed out.", "TimeoutError")), 10_000);
    let endpoint = TENCENTOA_SESSION_PATH;
    let lastResponse: Response | null = null;
    try {
      const options: RequestInit = {
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: request.signal,
      };
      let response = await this.fetcher(endpoint, options);
      if (this.disposed || this.generation !== generation) return;
      lastResponse = response;
      const coreSession = response.status === 404;
      if (coreSession) {
        endpoint = CORE_SESSION_PATH;
        lastResponse = null;
        // Reuse the same signal and timer: the fallback shares the original 10s
        // budget instead of starting a second one.
        response = await this.fetcher(endpoint, options);
        if (this.disposed || this.generation !== generation) return;
        lastResponse = response;
      }
      if (response.status === 404) {
        this.lastValidated = this.now();
        this.publish({ available: false, phase: "ready", identity: null, diagnostic: this.diagnostic(endpoint, "endpoint_404", { response }) });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        let server: TencentOaServerDiagnostic | null = null;
        try {
          const body: unknown = await response.json();
          const candidate = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).diagnostic : null;
          server = serverDiagnostic(candidate);
        } catch { /* Non-JSON denial remains an authentication failure. */ }
        if (this.disposed || this.generation !== generation) return;
        this.lastValidated = this.now();
        this.publish({ available: true, phase: "ready", identity: null, diagnostic: this.diagnostic(endpoint, "unauthenticated", { response, server }) });
        return;
      }
      if (!response.ok) {
        this.publish({ phase: "error", diagnostic: this.diagnostic(endpoint, "http_error", { response }) });
        return;
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new SessionReadError("invalid_json"); }
      if (this.disposed || this.generation !== generation) return;
      let value: unknown;
      try { value = coreSession ? employeeSession(body) : body; }
      catch (error) { throw error instanceof SessionReadError ? error : new SessionReadError("invalid_schema"); }
      if (this.disposed || this.generation !== generation) return;
      if (typeof value !== "object" || value === null || Array.isArray(value) || !("available" in value) || typeof value.available !== "boolean" || !("identity" in value)) throw new SessionReadError("invalid_schema");
      let identity: TencentOaIdentity | null = null;
      if (value.available && value.identity !== null) {
        const candidate = value.identity;
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("loginName" in candidate) || typeof candidate.loginName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(candidate.loginName)
          || !("staffId" in candidate) || typeof candidate.staffId !== "string" || !/^[1-9]\d{0,15}$/u.test(candidate.staffId)
          || !("expiresAt" in candidate) || typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new SessionReadError("invalid_schema");
        const parsed = Object.freeze({ loginName: candidate.loginName, staffId: candidate.staffId, expiresAt: candidate.expiresAt });
        if (identityValidUntil(parsed) >= this.now()) identity = parsed;
      }
      this.lastValidated = this.now();
      this.publish({ available: value.available, phase: "ready", identity, diagnostic: null });
    } catch (error) {
      if (this.disposed || this.generation !== generation) return;
      if (error instanceof SessionReadError) {
        const diagnostic = this.diagnostic(endpoint, error.failureKind, { response: lastResponse ?? undefined });
        if (error.failureKind === "provider_mismatch") this.publish({ available: false, phase: "ready", identity: null, diagnostic });
        else this.publish({ phase: "error", diagnostic });
        return;
      }
      this.publish({ phase: "error", diagnostic: this.diagnostic(endpoint, failureKindFor(error), { error }) });
    } finally {
      clearTimeout(timeout);
      if (this.request === request) this.request = null;
    }
  }

  private diagnostic(endpoint: string, failureKind: TencentOaDiagnostic["failureKind"], options: { readonly response?: Response; readonly server?: TencentOaServerDiagnostic | null; readonly error?: unknown } = {}): TencentOaDiagnostic {
    const response = options.response;
    const location = response ? responseLocation(response, endpoint) : { origin: null, pathname: endpoint };
    return Object.freeze({
      checkedAt: new Date(this.now()).toISOString(),
      endpoint,
      failureKind,
      httpStatus: response?.status ?? null,
      contentType: response?.headers.get("content-type") ?? null,
      serverReason: options.server?.reason ?? null,
      serverDiagnostic: options.server ?? null,
      errorName: errorName(options.error),
      errorMessage: errorMessage(options.error),
      origin: location.origin,
      pathname: location.pathname,
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent || null,
    });
  }

  async signIn(): Promise<AuthenticationResult> {
    const generation = this.generation + 1;
    await this.refresh();
    if (this.disposed || this.generation !== generation) return { status: "cancelled" };
    return this.session.status === "authenticated" ? { status: "authenticated", epoch: this.session.epoch } : { status: "cancelled" };
  }

  cancelSignIn = async (): Promise<void> => {
    ++this.generation;
    this.request?.abort(); this.request = null;
    if (!this.disposed && this.snapshot.phase === "loading") this.publish({ phase: "ready" });
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.generation; this.request?.abort(); this.request = null;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1, available: false, phase: "ready", identity: null, displayIdentity: null, avatarUrl: null, diagnostic: null });
    this.session = Object.freeze({ status: "anonymous", epoch: this.session.epoch + 1 });
    this.listeners.clear();
  }

  private publish(change: Partial<Omit<TencentOaSnapshot, "revision">>): void {
    if (this.disposed) return;
    const previous = this.snapshot.identity;
    let identity = change.identity === undefined ? previous : change.identity;
    if (identity && identityValidUntil(identity) < this.now()) identity = null;
    let displayIdentity = this.snapshot.displayIdentity;
    if (change.identity !== undefined) {
      displayIdentity = identity ? Object.freeze({ loginName: identity.loginName, staffId: identity.staffId }) : null;
      this.displayUntil = identity ? this.now() + 86_400_000 : 0;
    }
    if (this.now() >= this.displayUntil) displayIdentity = null;
    const changed = previous?.staffId !== identity?.staffId || previous?.loginName !== identity?.loginName;
    const avatarUrl = displayIdentity ? employeePhotoUrl(displayIdentity.loginName) : null;
    if (changed) this.session = Object.freeze({ status: identity ? "authenticated" : "anonymous", epoch: this.session.epoch + 1 });
    this.snapshot = Object.freeze({ ...this.snapshot, ...change, identity, displayIdentity, avatarUrl, revision: this.snapshot.revision + 1 });
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
    const deadline = identity ? identityValidUntil(identity) + 1 : displayIdentity ? this.displayUntil : null;
    if (deadline !== null) this.expiry = setTimeout(() => this.publish({}), Math.min(2_147_483_647, Math.max(1, deadline - this.now())));
    for (const listener of this.listeners) listener();
  }
}
