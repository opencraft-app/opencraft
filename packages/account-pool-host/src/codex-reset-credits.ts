import type { CodexResetCreditOutcome, CodexResetCreditsView, CodexResetCreditView } from "@opencraft/appserver-protocol";
import type { AccountCredentialRefreshReason } from "./oauth-refresh.js";
import type { AccountPoolAccount, AccountPoolSecret, AccountPoolStore } from "./store.js";

const endpoint = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, maximum = 512): string | null => typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value : null;
function timestamp(value: unknown): number | null {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/u.test(value)) {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value < 1e12 ? value * 1000 : value) : null;
}

export function parseCodexResetCredits(value: unknown, now = Date.now()): CodexResetCreditsView {
  const root = record(value);
  if (!root || !Array.isArray(root.credits)) throw new Error("Invalid Codex reset credit details");
  const credits: CodexResetCreditView[] = [];
  const ids = new Set<string>();
  for (const raw of root.credits) {
    const row = record(raw);
    const id = text(row?.id);
    if (!row || id === null || ids.has(id)) throw new Error("Invalid Codex reset credit identity");
    ids.add(id);
    const expiresAt = timestamp(row.expires_at);
    credits.push({ id, title: text(row.title), resetType: text(row.reset_type) ?? "unknown",
      status: row.status === "available" || row.status === "redeeming" || row.status === "redeemed" ? row.status : "unknown",
      supportedByPlan: row.is_supported_by_plan === true, grantedAt: timestamp(row.granted_at), expiresAt,
      expiryKnown: row.expires_at === null || expiresAt !== null });
  }
  const count = root.available_count;
  return { availableCount: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null,
    observedAt: now, credits };
}

interface ConsumeResult {
  readonly outcome: CodexResetCreditOutcome;
  readonly credits: CodexResetCreditsView | null;
  readonly usageRefreshed: boolean;
}

/** Shared by the independent Core and embedded Host. No background redemption. */
export class CodexResetCreditService {
  private readonly attempts = new Map<string, { accountId: string; creditId: string; result: Promise<ConsumeResult>; outcome?: CodexResetCreditOutcome }>();
  private readonly active = new Map<string, Promise<ConsumeResult>>();
  private readonly reads = new Set<Promise<CodexResetCreditsView>>();
  private closing = false;
  constructor(private readonly options: {
    readonly store: AccountPoolStore;
    readonly resolveCredential: (account: AccountPoolAccount, secret: AccountPoolSecret, reason: AccountCredentialRefreshReason) => Promise<AccountPoolSecret>;
    readonly refreshUsage: (accountId: string) => Promise<void>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {}

  list(accountId: string): Promise<CodexResetCreditsView> {
    if (this.closing) return Promise.reject(new Error("Reset credits are closing"));
    const operation = this.performList(accountId);
    this.reads.add(operation);
    void operation.finally(() => this.reads.delete(operation)).catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.values(), ...this.reads]);
  }

  private async performList(accountId: string): Promise<CodexResetCreditsView> {
    const account = this.options.store.getAccount(accountId);
    let secret = await this.options.resolveCredential(account, this.options.store.readCredential(accountId), "expired");
    let response = await this.request(account, secret, false);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      secret = await this.options.resolveCredential(account, secret, "unauthorized");
      response = await this.request(account, secret, false);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`Codex reset credit details failed (HTTP ${response.status})`); }
    const result = parseCodexResetCredits(await response.json(), this.now());
    if (result.availableCount !== null) this.options.store.updateSubscriptionMetadata(accountId, {
      resetCredits: { availableCount: result.availableCount, observedAt: result.observedAt },
    });
    return result;
  }

  consume(params: { accountId: string; creditId: string; idempotencyKey: string; confirmed: unknown }): Promise<ConsumeResult> {
    if (this.closing) return Promise.reject(new Error("Reset credits are closing"));
    if (params.confirmed !== true || text(params.creditId) === null || !/^[a-zA-Z0-9_-]{8,128}$/u.test(params.idempotencyKey)) {
      return Promise.reject(new Error("Invalid confirmed reset credit request"));
    }
    const existing = this.attempts.get(params.idempotencyKey);
    if (existing) {
      if (existing.accountId !== params.accountId || existing.creditId !== params.creditId) return Promise.reject(new Error("Reset attempt identity does not match"));
      // Only a fresh explicit RPC can retry an unknown result, with the same key.
      if (existing.outcome !== "unknown") return existing.result;
    }
    if (this.active.has(params.accountId)) return Promise.reject(new Error("A reset request is already in progress"));
    // Do not evict uncertain attempts: a retry must retain its original key.
    if (!existing && this.attempts.size >= 1024) return Promise.reject(new Error("Reset attempt limit reached; refresh account details"));
    const operation = this.performConsume(params).finally(() => this.active.delete(params.accountId));
    this.active.set(params.accountId, operation);
    const attempt = { ...params, result: operation, outcome: undefined as CodexResetCreditOutcome | undefined };
    this.attempts.set(params.idempotencyKey, attempt);
    void operation.then(result => { attempt.outcome = result.outcome; }, () => undefined);
    // Definitive preflight failures happened before POST and may be tried again.
    void operation.catch(() => this.attempts.delete(params.idempotencyKey));
    return operation;
  }

  private async performConsume(params: { accountId: string; creditId: string; idempotencyKey: string }): Promise<ConsumeResult> {
    const details = await this.list(params.accountId);
    const credit = details.credits.find(row => row.id === params.creditId);
    const account = this.options.store.getAccount(params.accountId);
    if (this.closing || !account.enabled || !credit || credit.status !== "available" || !credit.supportedByPlan
      || credit.resetType !== "codex_rate_limits" || !credit.expiryKnown
      || (credit.expiresAt !== null && credit.expiresAt <= this.now())) throw new Error("Selected reset credit is not available");
    const secret = await this.options.resolveCredential(account, this.options.store.readCredential(account.id), "expired");
    let outcome: CodexResetCreditOutcome = "unknown";
    try {
      // Exactly one POST, no transport/auth/5xx retry or fallback to another credit.
      const response = await this.request(account, secret, true, { credit_id: params.creditId, redeem_request_id: params.idempotencyKey });
      if (response.ok) {
        const body = record(await response.json());
        const raw = body?.outcome;
        const outcomes: Record<string, CodexResetCreditOutcome> = { reset: "reset", nothing_to_reset: "nothingToReset", nothingToReset: "nothingToReset",
          no_credit: "noCredit", noCredit: "noCredit", already_redeemed: "alreadyRedeemed", alreadyRedeemed: "alreadyRedeemed" };
        outcome = typeof raw === "string" ? outcomes[raw] ?? "unknown" : "unknown";
      } else await response.body?.cancel().catch(() => undefined);
    } catch { /* Outcome may already be committed. Never turn this into an automatic retry. */ }
    const [detailsResult, usageResult] = await Promise.allSettled([this.list(params.accountId), this.options.refreshUsage(params.accountId)]);
    return { outcome, credits: detailsResult.status === "fulfilled" ? detailsResult.value : null, usageRefreshed: usageResult.status === "fulfilled" };
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private request(account: AccountPoolAccount, secret: AccountPoolSecret, consume: boolean, body?: object): Promise<Response> {
    return (this.options.fetch ?? fetch)(endpoint + (consume ? "/consume" : ""), {
      method: consume ? "POST" : "GET", redirect: "error",
      headers: { authorization: `Bearer ${secret.accessToken}`, "chatgpt-account-id": account.upstreamAccountId, originator: "codex_cli_rs",
        accept: "application/json", ...(consume ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
  }
}
