import { accountFailure, classifyAccountFailure, logAccountFailure } from "./account-diagnostics.js";
import type { AccountPoolAccount, AccountPoolSecret, AccountPoolStore } from "./store.js";

export type AccountCredentialRefreshReason = "expired" | "unauthorized";

/** Coordinates account-pool refreshes; the injected callback owns provider-specific renewal. */
export class AccountCredentialRefreshManager {
  activeCount(): number { return this.flights.size; }
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
    if (current.external) {
      const usable = current.expiresAt === null || current.expiresAt > this.now() + this.refreshSkewMs;
      if (usable && (reason === "expired" || current.accessToken !== secret.accessToken)) return Promise.resolve(current);
      const failure = accountFailure(usable ? "authorization-rejected" : "credential-expired", "renewal", false);
      this.store.observeAccountMaintenance(account.id, { state: "error", checkedAt: this.now(),
        lastSuccessAt: this.store.accountMaintenance(account.id)?.lastSuccessAt ?? null, failure: failure.diagnostic });
      logAccountFailure(failure, { accountId: account.id });
      return Promise.reject(failure);
    }
    if (current.accessToken !== secret.accessToken && (current.expiresAt === null || current.expiresAt > this.now())) return Promise.resolve(current);
    if (reason === "expired" && (current.expiresAt === null || current.expiresAt > this.now() + this.refreshSkewMs)) {
      return Promise.resolve(current);
    }
    const existing = this.flights.get(account.id);
    if (existing !== undefined) return existing;
    const startedAt = this.now();
    this.store.observeAccountMaintenance(account.id, { state: "checking", checkedAt: startedAt,
      lastSuccessAt: this.store.accountMaintenance(account.id)?.lastSuccessAt ?? null });
    let operation!: Promise<AccountPoolSecret>;
    operation = this.refresh(account, current, reason).then(refreshed => {
      if (refreshed.expiresAt !== null && refreshed.expiresAt <= this.now()
        || reason === "unauthorized" && refreshed.accessToken === current.accessToken) {
        throw accountFailure("renewal-incomplete", "renewal", true);
      }
      const latest = this.store.readCredential(account.id);
      if (latest.accessToken !== current.accessToken) {
        if (latest.expiresAt === null || latest.expiresAt > this.now()) return latest;
        throw accountFailure("service-unavailable", "renewal", true);
      }
      // A local file write is not proof that the provider accepted a renewal.
      this.store.replaceCredential(account.id, refreshed, { preserveAuthorizationError: true });
      this.store.observeAccountMaintenance(account.id, { state: "unverified", checkedAt: this.now(),
        lastSuccessAt: this.store.accountMaintenance(account.id)?.lastSuccessAt ?? null });
      return refreshed;
    }).catch(error => {
      const failure = classifyAccountFailure(error, "renewal");
      if (this.store.listAccounts().some(candidate => candidate.id === account.id)) {
        this.store.observeAccountMaintenance(account.id, { state: "error", checkedAt: this.now(),
          lastSuccessAt: this.store.accountMaintenance(account.id)?.lastSuccessAt ?? null, failure: failure.diagnostic });
      }
      logAccountFailure(failure, { accountId: account.id, durationMs: this.now() - startedAt });
      throw failure;
    }).finally(() => {
      if (this.flights.get(account.id) === operation) this.flights.delete(account.id);
    });
    this.flights.set(account.id, operation);
    return operation;
  }
}
