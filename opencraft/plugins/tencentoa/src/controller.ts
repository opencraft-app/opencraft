import type { AuthenticationResult, AuthenticationSession } from "@opencraft/workbench-runtime";
import { identityValidUntil, TENCENTOA_SESSION_PATH, type TencentOaIdentity } from "./contract";

export interface TencentOaSnapshot {
  readonly revision: number;
  readonly available: boolean | null;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly identity: TencentOaIdentity | null;
}

/** In-memory per-client projection; only the backend supplies verified identity. */
export class TencentOaController {
  private snapshot: TencentOaSnapshot = Object.freeze({ revision: 0, available: null, phase: "idle", identity: null });
  private session: AuthenticationSession = Object.freeze({ status: "anonymous", epoch: 0 });
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly now = Date.now) {}
  getSnapshot = (): TencentOaSnapshot => this.snapshot;
  getSession = (): AuthenticationSession => this.session;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    this.publish({ phase: "loading" });
    try {
      const response = await this.fetcher(TENCENTOA_SESSION_PATH, {
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      if (this.disposed || this.generation !== generation) return;
      if (response.status === 404) { this.publish({ available: false, phase: "ready", identity: null }); return; }
      if (!response.ok && response.status !== 401) throw new Error("Identity unavailable");
      const value: unknown = await response.json();
      if (this.disposed || this.generation !== generation) return;
      if (typeof value !== "object" || value === null || !("available" in value) || typeof value.available !== "boolean" || !("identity" in value)) throw new Error("Invalid identity response");
      let identity: TencentOaIdentity | null = null;
      if (response.ok && value.available && value.identity !== null) {
        const candidate = value.identity;
        if (typeof candidate !== "object" || !("loginName" in candidate) || typeof candidate.loginName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(candidate.loginName)
          || !("staffId" in candidate) || typeof candidate.staffId !== "string" || !/^[1-9]\d{0,15}$/u.test(candidate.staffId)
          || !("expiresAt" in candidate) || typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new Error("Invalid identity response");
        const parsed = Object.freeze({ loginName: candidate.loginName, staffId: candidate.staffId, expiresAt: candidate.expiresAt });
        if (identityValidUntil(parsed) >= this.now()) identity = parsed;
      }
      this.publish({ available: value.available, phase: "ready", identity });
    } catch {
      if (!this.disposed && this.generation === generation) this.publish({ phase: "error" });
    } finally {
      if (this.request === request) this.request = null;
    }
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
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1, available: false, phase: "ready", identity: null });
    this.session = Object.freeze({ status: "anonymous", epoch: this.session.epoch + 1 });
    this.listeners.clear();
  }

  private publish(change: Partial<Omit<TencentOaSnapshot, "revision">>): void {
    if (this.disposed) return;
    const previous = this.snapshot.identity;
    let identity = change.identity === undefined ? previous : change.identity;
    if (identity && identityValidUntil(identity) < this.now()) identity = null;
    const changed = previous?.staffId !== identity?.staffId || previous?.loginName !== identity?.loginName || previous?.expiresAt !== identity?.expiresAt;
    if (changed) this.session = Object.freeze({ status: identity ? "authenticated" : "anonymous", epoch: this.session.epoch + 1 });
    this.snapshot = Object.freeze({ ...this.snapshot, ...change, identity, revision: this.snapshot.revision + 1 });
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
    if (identity) this.expiry = setTimeout(() => this.publish({}), Math.min(2_147_483_647, Math.max(1, identityValidUntil(identity) - this.now() + 1)));
    for (const listener of this.listeners) listener();
  }
}
