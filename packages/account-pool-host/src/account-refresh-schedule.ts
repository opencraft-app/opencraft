// Proactive renewal of the account pool's managed credentials on the owner
// wake-up port (@opencraft/owner-wake; gateway-split §4.2). The owner holds one
// wake-up armed for the earliest due renewal; when it fires, the schedule
// re-reads the pool (never trusting the wake-up itself) and renews every
// account that is due through the pool's AccountCredentialRefreshManager, the
// single place a credential is renewed and committed.
//
// Runtime-neutral: an owner that loses its memory between wake-ups (a Durable
// Object evicted between alarms) re-derives the same schedule from its stored
// credentials when it is opened again. Failure back-off lives in memory only:
// after a restart a failed account is attempted once more at once.
import type { OwnerWake } from "@opencraft/owner-wake";
import type { AccountPool, AccountPoolSecret } from "./account-pool.js";
import type { AccountCredentialRefreshManager } from "./oauth-refresh.js";

/** Renew this long before expiry; the refresh manager must be built with the same skew. */
export const ACCOUNT_REFRESH_LEAD_MS = 5 * 60_000;
/** After a failed renewal, wait this long before the next attempt for that account. */
export const ACCOUNT_REFRESH_RETRY_MS = 60_000;

export interface AccountRefreshSchedule {
  /** Re-derives the next due renewal from the pool; call after any credential change. */
  reschedule(): void;
  /** When the earliest renewal is due (owner clock), or null when nothing is. */
  nextDueAt(): number | null;
  /** Cancels the wake-up and waits for renewals already running. */
  close(): Promise<void>;
}

export function scheduleAccountRefresh(options: {
  readonly pool: AccountPool;
  readonly refresh: AccountCredentialRefreshManager;
  readonly wake: OwnerWake;
  readonly leadMs?: number;
  readonly retryMs?: number;
}): AccountRefreshSchedule {
  const { pool, refresh, wake } = options;
  const leadMs = options.leadMs ?? ACCOUNT_REFRESH_LEAD_MS;
  const retryMs = options.retryMs ?? ACCOUNT_REFRESH_RETRY_MS;
  const retryAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  let closed = false;

  /** Managed, enabled accounts with a refresh token and a known expiry, with their due times. */
  const dueTimes = () => {
    const due: { id: string; at: number; secret: AccountPoolSecret }[] = [];
    for (const account of pool.listAccounts()) {
      if (!account.enabled || account.credentialSource !== "managed" || running.has(account.id)) continue;
      let secret: AccountPoolSecret;
      try {
        secret = pool.readCredential(account.id);
      } catch {
        continue;
      }
      if (secret.expiresAt === null || !secret.refreshToken) continue;
      due.push({ id: account.id, at: Math.max(secret.expiresAt - leadMs, retryAt.get(account.id) ?? 0), secret });
    }
    return due;
  };

  const timer = wake.timer(() => {
    if (closed) return;
    const now = wake.now();
    for (const entry of dueTimes()) {
      if (entry.at > now) continue;
      const account = pool.getAccount(entry.id);
      const flight = refresh
        .resolve(account, entry.secret, "expired")
        .then(
          (renewed) => {
            // A secret the manager kept (another flight renewed it, or it is not due by the manager's skew)
            // must not re-arm for the same instant.
            if (renewed.accessToken === entry.secret.accessToken) retryAt.set(entry.id, wake.now() + retryMs);
            else retryAt.delete(entry.id);
          },
          () => void retryAt.set(entry.id, wake.now() + retryMs),
        )
        .finally(() => {
          running.delete(entry.id);
          if (!closed) reschedule();
        });
      running.set(entry.id, flight);
    }
    reschedule();
  });

  function nextDueAt(): number | null {
    let next: number | null = null;
    for (const entry of dueTimes()) if (next === null || entry.at < next) next = entry.at;
    return next;
  }

  function reschedule(): void {
    if (closed) return;
    const next = nextDueAt();
    if (next === null) timer.cancel();
    else timer.arm(next);
  }

  reschedule();
  return {
    reschedule,
    nextDueAt,
    async close() {
      closed = true;
      timer.cancel();
      await Promise.allSettled([...running.values()]);
    },
  };
}
