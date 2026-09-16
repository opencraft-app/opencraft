import { Service, type Context } from "@deepseek-ai/cordis";
import type { AuthenticationProvider, AuthenticationResult, AuthenticationSession } from "./contract";

declare module "@deepseek-ai/cordis" {
  interface Context { authentication: AuthenticationService }
}

interface Registration {
  readonly owner: string;
  readonly provider: AuthenticationProvider;
  readonly unsubscribe: () => void;
  operation: Promise<AuthenticationResult> | null;
  cancellation: Promise<void> | null;
}

/** Application-lifetime provider broker. Platform adapters retain credential/session authority. */
export class AuthenticationService extends Service {
  private readonly providers = new Map<string, Registration>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(ctx: Context) {
    super(ctx, "authentication");
    ctx.effect(() => () => {
      this.disposed = true;
      for (const entry of this.providers.values()) this.retire(entry);
      this.providers.clear();
      this.emitChange();
      this.listeners.clear();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSession(id: string): AuthenticationSession | null {
    return this.providers.get(id)?.provider.getSession() ?? null;
  }

  register(owner: string, provider: AuthenticationProvider): () => void {
    if (this.disposed) throw new Error("Authentication service is disposed");
    if (this.providers.has(provider.id)) throw new Error(`Duplicate authentication provider: ${provider.id}`);
    const entry: Registration = { owner, provider, operation: null, cancellation: null,
      unsubscribe: provider.subscribe(() => this.emitChange()) };
    this.providers.set(provider.id, entry);
    this.emitChange();
    return () => {
      if (this.providers.get(provider.id) !== entry) return;
      this.providers.delete(provider.id);
      this.retire(entry);
      this.emitChange();
    };
  }

  async signIn(id: string, optionId?: string): Promise<AuthenticationResult> {
    const entry = this.providers.get(id);
    if (!entry) throw new Error("Authentication provider unavailable");
    // A cancelled native transaction must retire before another starts.
    if (entry.cancellation) await entry.cancellation;
    if (this.providers.get(id) !== entry) return { status: "cancelled" };
    if (entry.operation) throw new Error("Another login is still in progress. Please wait or cancel it first.");
    const operation = entry.provider.signIn(optionId);
    entry.operation = operation;
    try {
      const result = await operation;
      if (this.providers.get(id) !== entry || entry.operation !== operation) return { status: "cancelled" };
      // Explicit result, including same-account reauthentication; identity change is not completion.
      if (result.status === "authenticated") {
        const session = entry.provider.getSession();
        if (session.status !== "authenticated" || session.epoch !== result.epoch) return { status: "cancelled" };
      }
      return result;
    } finally {
      if (entry.operation === operation) entry.operation = null;
    }
  }

  cancel(id: string): Promise<void> {
    const entry = this.providers.get(id);
    if (!entry) return Promise.resolve();
    if (entry.cancellation) return entry.cancellation;
    const cancelled = entry.operation;
    const cancellation = entry.provider.cancelSignIn().then(() => {
      if (entry.operation === cancelled) entry.operation = null;
    }).finally(() => { if (entry.cancellation === cancellation) entry.cancellation = null; });
    entry.cancellation = cancellation;
    return cancellation;
  }

  private retire(entry: Registration): void {
    entry.unsubscribe();
    if (entry.operation) void entry.provider.cancelSignIn().catch(() => undefined);
  }

  private emitChange(): void { for (const listener of this.listeners) listener(); }
}
