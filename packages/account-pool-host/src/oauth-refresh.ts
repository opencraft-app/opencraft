import type { AccountPoolAccount, AccountPoolSecret, AccountPoolStore } from "./store.js";

export type AccountCredentialRefreshReason = "expired" | "unauthorized";

/** Coordinates account-pool refreshes; the injected callback owns provider-specific renewal. */
export class AccountCredentialRefreshManager {
  private readonly flights = new Map<string, Promise<AccountPoolSecret>>();
  private readonly store: AccountPoolStore;
  private readonly now: () => number;
  private readonly refresh: (
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ) => Promise<AccountPoolSecret>;
  private readonly refreshSkewMs: number;

  constructor(options: {
    readonly store: AccountPoolStore;
    readonly now?: () => number;
    readonly refreshSkewMs?: number;
    readonly refresh: (
      account: AccountPoolAccount,
      secret: AccountPoolSecret,
      reason: AccountCredentialRefreshReason,
    ) => Promise<AccountPoolSecret>;
  }) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.refresh = options.refresh;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  resolve(
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ): Promise<AccountPoolSecret> {
    const current = this.store.readCredential(account.id);
    if (current.accessToken !== secret.accessToken) return Promise.resolve(current);
    if (reason === "expired" && (current.expiresAt === null || current.expiresAt > this.now() + this.refreshSkewMs)) {
      return Promise.resolve(current);
    }
    if (current.external) {
      return Promise.reject(new Error("Shared credentials need renewal by their external owner"));
    }
    const existing = this.flights.get(account.id);
    if (existing !== undefined) return existing;
    let operation!: Promise<AccountPoolSecret>;
    operation = this.refresh(account, current, reason).then(refreshed => {
      this.store.replaceCredential(account.id, refreshed);
      return refreshed;
    }).finally(() => {
      if (this.flights.get(account.id) === operation) this.flights.delete(account.id);
    });
    this.flights.set(account.id, operation);
    return operation;
  }
}
