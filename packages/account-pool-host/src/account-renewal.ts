// The account renewal exchange (storage-ports §7.3, decided 2026-11-22): the
// account owner stays the only writer of credentials and decides when an
// account is renewed, but the provider's OAuth renewal itself runs in a
// maintenance executor (the native `codex` in an on-demand maintenance
// container), never reimplemented in the owner. The owner sends the account's
// current secret over one authenticated `fetch` and commits what comes back.
//
// Runtime-neutral: Fetch semantics only. Node keeps its in-process executor
// (`createManagedCodexRefresh`, a native codex child process); an owner
// without processes (the AccountCore Durable Object) reaches the executor
// through a fetch binding. Both are the `refresh` callback of the same
// AccountCredentialRefreshManager.
import type { CodexAccountFailureCode } from "@opencraft/appserver-protocol";
import { accountFailure } from "./account-diagnostics.js";
import type { AccountPoolAccount, AccountPoolSecret } from "./account-pool.js";
import type { AccountCredentialRefreshReason } from "./oauth-refresh.js";

export const ACCOUNT_RENEWAL_PATH = "/__opencraft_maintenance/account-renewal";

/** What the owner sends: one account's identity and current managed secret. */
export interface AccountRenewalRequest {
  readonly provider: "codex";
  readonly upstreamAccountId: string;
  readonly reason: AccountCredentialRefreshReason;
  readonly secret: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly idToken: string | null;
    readonly expiresAt: number | null;
  };
}

/** What the executor answers. A failure names only an allowlisted code, never a provider body. */
export type AccountRenewalResponse =
  | {
      readonly status: "renewed";
      readonly upstreamAccountId: string;
      readonly secret: {
        readonly accessToken: string;
        readonly refreshToken: string | null;
        readonly idToken: string | null;
        readonly expiresAt: number | null;
      };
    }
  | { readonly status: "failed"; readonly code: CodexAccountFailureCode };

/** The executor as the owner reaches it: a fetch binding (Workers) or any Fetch-shaped client. */
export interface AccountRenewalExecutor {
  fetch(request: Request): Promise<Response>;
}

const FAILURE_CODES: readonly CodexAccountFailureCode[] = [
  "authorization-rejected",
  "credential-unavailable",
  "credential-expired",
  "renewal-incomplete",
  "renewal-failed",
  "upstream-unavailable",
  "request-timeout",
  "service-unavailable",
];

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 65536;
const expiry = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate the maintenance executor's input before creating a native profile. */
export function parseAccountRenewalRequest(value: unknown): AccountRenewalRequest {
  if (
    !exactRecord(value, ["provider", "upstreamAccountId", "reason", "secret"]) ||
    value.provider !== "codex" ||
    !text(value.upstreamAccountId) ||
    (value.reason !== "expired" && value.reason !== "unauthorized") ||
    !exactRecord(value.secret, ["accessToken", "refreshToken", "idToken", "expiresAt"]) ||
    !text(value.secret.accessToken) ||
    !text(value.secret.refreshToken) ||
    !(value.secret.idToken === null || text(value.secret.idToken)) ||
    !expiry(value.secret.expiresAt)
  )
    throw new TypeError("Invalid account renewal request");
  return {
    provider: value.provider,
    upstreamAccountId: value.upstreamAccountId,
    reason: value.reason,
    secret: {
      accessToken: value.secret.accessToken,
      refreshToken: value.secret.refreshToken,
      idToken: value.secret.idToken,
      expiresAt: value.secret.expiresAt,
    },
  };
}

export function isAccountRenewalFailure(code: unknown): code is CodexAccountFailureCode {
  return FAILURE_CODES.includes(code as CodexAccountFailureCode);
}

/** Validates an executor answer at the owner's side; throws on anything else. */
export function parseAccountRenewalResponse(value: unknown): AccountRenewalResponse {
  const answer = value as Record<string, unknown> | null;
  if (answer?.status === "failed" && isAccountRenewalFailure(answer.code))
    return { status: "failed", code: answer.code };
  const secret = answer?.secret as Record<string, unknown> | undefined;
  if (
    answer?.status !== "renewed" ||
    !text(answer.upstreamAccountId) ||
    !secret ||
    !text(secret.accessToken) ||
    !(secret.refreshToken === null || text(secret.refreshToken)) ||
    !(secret.idToken === null || text(secret.idToken)) ||
    !expiry(secret.expiresAt)
  )
    throw accountFailure("renewal-incomplete", "renewal", true);
  return {
    status: "renewed",
    upstreamAccountId: answer.upstreamAccountId,
    secret: {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken as string | null,
      idToken: secret.idToken as string | null,
      expiresAt: secret.expiresAt as number | null,
    },
  };
}

/**
 * The refresh callback for AccountCredentialRefreshManager over a renewal
 * executor. The secret travels only in this request's body; the answer is
 * validated, its account identity must be unchanged, and the manager commits it.
 */
export function fetchAccountRenewal(
  executor: AccountRenewalExecutor,
  options: { readonly timeoutMs?: number } = {},
): (
  account: AccountPoolAccount,
  secret: AccountPoolSecret,
  reason: AccountCredentialRefreshReason,
) => Promise<AccountPoolSecret> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (account, secret, reason) => {
    if (!secret.refreshToken) throw new Error("Codex account cannot refresh without a refresh token");
    const body: AccountRenewalRequest = {
      provider: "codex",
      upstreamAccountId: account.upstreamAccountId,
      reason,
      secret: {
        accessToken: secret.accessToken,
        refreshToken: secret.refreshToken,
        idToken: secret.idToken ?? null,
        expiresAt: secret.expiresAt,
      },
    };
    let response: Response;
    try {
      response = await executor.fetch(
        new Request(`https://account-maintenance.internal${ACCOUNT_RENEWAL_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      throw (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError"
        ? accountFailure("request-timeout", "renewal", true)
        : accountFailure("service-unavailable", "renewal", true);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw accountFailure("service-unavailable", "renewal", true, response.status);
    }
    let answer: AccountRenewalResponse;
    try {
      answer = parseAccountRenewalResponse(await response.json());
    } catch (error) {
      throw (error as Error)?.name === "CodexAccountOperationError"
        ? error
        : accountFailure("renewal-incomplete", "renewal", true);
    }
    if (answer.status === "failed")
      throw accountFailure(answer.code, "renewal", answer.code !== "authorization-rejected");
    if (answer.upstreamAccountId !== account.upstreamAccountId)
      throw new Error("Codex refresh changed account identity");
    return answer.secret;
  };
}
