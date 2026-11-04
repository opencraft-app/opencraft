/** A provider adapter supplies structured facts, never a match on error prose. */
export type ProviderFailure = { kind: "overloaded" | "unavailable" | "rate-limit" | "permanent"; retryAt?: number };
export type ProviderRetryDecision = { kind: "retry"; retryAt: number } | { kind: "decline"; reason: "permanent" | "exhausted" | "reset-unknown" | "wait-too-long" };
export const PROVIDER_RETRY_LIMIT = 4;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

export function providerRetryDecision(failure: ProviderFailure, retries: number, now: number, random = Math.random()): ProviderRetryDecision {
  if (failure.kind === "permanent") return { kind: "decline", reason: "permanent" };
  if (retries >= PROVIDER_RETRY_LIMIT) return { kind: "decline", reason: "exhausted" };
  const jitter = Math.min(1, Math.max(0, random));
  if (failure.kind === "rate-limit") {
    if (!Number.isSafeInteger(failure.retryAt) || failure.retryAt! < now) return { kind: "decline", reason: "reset-unknown" };
    if (failure.retryAt! - now > MAX_WAIT_MS) return { kind: "decline", reason: "wait-too-long" };
    return { kind: "retry", retryAt: failure.retryAt! + 15_000 + Math.floor(jitter * 30_000) };
  }
  const base = failure.kind === "overloaded" ? 5_000 : 60_000;
  const delay = Math.min(120_000, base * 2 ** retries);
  return { kind: "retry", retryAt: now + delay + Math.floor(jitter * delay) };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
/** Unknown variants and client/authorization/policy failures fail closed. */
export function codexProviderFailure(error: unknown): ProviderFailure {
  const info = object(error).codexErrorInfo;
  if (info === "serverOverloaded") return { kind: "overloaded" };
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return { kind: "rate-limit" };
  if (info === "internalServerError") return { kind: "unavailable" };
  for (const variant of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
    const detail = object(object(info)[variant]);
    if (!Object.hasOwn(object(info), variant)) continue;
    const status = detail.httpStatusCode;
    if (status === 429) return { kind: "rate-limit" };
    if ([500, 502, 503, 504].includes(status as number)) return { kind: "unavailable" };
    if (status === null && variant !== "responseTooManyFailedAttempts") return { kind: "unavailable" };
    return { kind: "permanent" };
  }
  return { kind: "permanent" };
}

/** Read-only routing facts from the account owner, without credentials or account IDs. */
export function pooledRetryAt(accounts: unknown, now: number): number | undefined {
  if (!Array.isArray(accounts)) return undefined;
  const resets: number[] = [];
  for (const value of accounts) {
    const account = object(value);
    if (account.enabled !== true || account.credentialConfigured !== true) continue;
    if (account.status === "ready") return now;
    if (account.status === "held" && Number.isSafeInteger(account.heldUntil) && (account.heldUntil as number) > now) {
      resets.push(account.heldUntil as number); continue;
    }
    if (account.status !== "exhausted" || !Array.isArray(account.limitWindows) || !account.limitWindows.length) continue;
    const times = account.limitWindows.map(value => object(value).resetAt);
    if (times.every(time => Number.isSafeInteger(time) && (time as number) >= 0)) resets.push(Math.max(now, ...times as number[]));
  }
  return resets.length ? Math.min(...resets) : undefined;
}
