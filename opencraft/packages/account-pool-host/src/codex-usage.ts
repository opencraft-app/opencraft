import type { CodexCredentialRefreshReason } from "./oauth-refresh.js";
import type {
  AccountPoolAccount,
  AccountPoolLimitWindow,
  AccountPoolSecret,
  AccountPoolStore,
} from "./store.js";

export const DEFAULT_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const USAGE_TIMEOUT_MS = 15_000;

interface ParsedCodexUsage {
  readonly subscriptionType: string | null;
  readonly limitWindows: readonly AccountPoolLimitWindow[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function epochMilliseconds(value: number): number {
  return Math.round(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function usageWindow(
  slot: "primary" | "secondary",
  raw: unknown,
  now: number,
): AccountPoolLimitWindow | null {
  const value = object(raw);
  if (value === null) return null;
  const usedPercent = finite(value.used_percent);
  if (usedPercent === null) return null;
  const utilization = Math.max(0, Math.min(1, usedPercent / 100));
  const resetAt = finite(value.reset_at);
  const resetAfter = finite(value.reset_after_seconds);
  const windowSeconds = finite(value.limit_window_seconds);
  return {
    slot,
    windowMinutes: windowSeconds !== null && windowSeconds > 0 ? Math.max(1, Math.round(windowSeconds / 60)) : null,
    utilization,
    resetAt: resetAt !== null
      ? epochMilliseconds(resetAt)
      : resetAfter !== null && resetAfter > 0
        ? now + Math.round(resetAfter * 1_000)
        : null,
    status: utilization >= 1 ? "rejected" : "allowed",
    observedAt: now,
    source: "usage",
  };
}

export function parseCodexUsage(value: unknown, now = Date.now()): ParsedCodexUsage {
  const payload = object(value);
  if (payload === null) throw new Error("Codex usage response is invalid");
  const plan = typeof payload.plan_type === "string" && payload.plan_type.trim()
    ? payload.plan_type.trim()
    : null;
  const rateLimit = object(payload.rate_limit);
  const windows = rateLimit === null ? [] : [
    usageWindow("primary", rateLimit.primary_window, now),
    usageWindow("secondary", rateLimit.secondary_window, now),
  ].filter((window): window is AccountPoolLimitWindow => window !== null);
  return { subscriptionType: plan, limitWindows: windows };
}

export class CodexSubscriptionService {
  private readonly flights = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    readonly store: AccountPoolStore;
    readonly resolveCredential: (
      account: AccountPoolAccount,
      secret: AccountPoolSecret,
      reason: CodexCredentialRefreshReason,
    ) => Promise<AccountPoolSecret>;
    readonly fetch?: typeof fetch;
    readonly usageUrl?: string;
    readonly now?: () => number;
    readonly refreshIntervalMs?: number;
  }) {}

  start(): void {
    if (this.timer !== null) return;
    void this.refreshAll().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.refreshAll().catch(() => undefined);
    }, this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.flights.values());
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      this.options.store.listAccounts()
        .filter(account => account.enabled)
        .map(account => this.refreshAccount(account.id)),
    );
  }

  refreshAccount(accountId: string): Promise<void> {
    const existing = this.flights.get(accountId);
    if (existing !== undefined) return existing;
    let operation!: Promise<void>;
    operation = this.performRefresh(accountId).finally(() => {
      if (this.flights.get(accountId) === operation) this.flights.delete(accountId);
    });
    this.flights.set(accountId, operation);
    return operation;
  }

  private async performRefresh(accountId: string): Promise<void> {
    const account = this.options.store.getAccount(accountId);
    const stored = this.options.store.readCredential(account.id);
    let secret = await this.options.resolveCredential(account, stored, "expired");
    let response = await this.fetchUsage(account, secret);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      secret = await this.options.resolveCredential(account, secret, "unauthorized");
      response = await this.fetchUsage(account, secret);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Codex usage refresh failed (HTTP ${response.status})`);
    }
    const now = (this.options.now ?? Date.now)();
    const usage = parseCodexUsage(await response.json(), now);
    this.options.store.updateSubscriptionMetadata(account.id, {
      subscriptionType: usage.subscriptionType,
    });
    if (usage.limitWindows.length === 0) return;
    const utilization = usage.limitWindows.reduce<number | null>(
      (maximum, window) => window.utilization === null ? maximum : Math.max(maximum ?? 0, window.utilization),
      null,
    );
    const resetAt = usage.limitWindows.reduce<number | null>(
      (latest, window) => window.resetAt === null ? latest : Math.max(latest ?? 0, window.resetAt),
      null,
    );
    this.options.store.observeQuota(account.id, {
      utilization,
      resetAt,
      limitWindows: usage.limitWindows,
    });
  }

  private fetchUsage(account: AccountPoolAccount, secret: AccountPoolSecret): Promise<Response> {
    return (this.options.fetch ?? fetch)(this.options.usageUrl ?? DEFAULT_CODEX_USAGE_URL, {
      headers: {
        authorization: `Bearer ${secret.accessToken}`,
        "chatgpt-account-id": account.upstreamAccountId,
        originator: "opencraft",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
  }
}
