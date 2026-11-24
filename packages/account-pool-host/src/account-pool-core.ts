// The account pool as one owner holds it: selection and affinity (AccountPool),
// renewal of managed credentials (AccountCredentialRefreshManager, the only
// place a renewed credential is committed) and the proactive renewal schedule
// on the owner wake-up port. Runtime-neutral: the pool (over whichever storage
// its owner opened), the renewal executor and the wake-up arrive as ports. The
// AccountCore Durable Object composes it over its shared SQL database, the
// maintenance executor's fetch binding and its alarm; on Node the same domain
// classes run over the file owner (AccountPoolStore) and, in the Codex Core,
// the native maintenance process (codex-account-service.ts).
import type { OwnerWake } from "@opencraft/owner-wake";
import type { AccountPool, AccountPoolAccount, AccountPoolSecret } from "./account-pool.js";
import { AccountCredentialRefreshManager, type AccountCredentialRefreshReason } from "./oauth-refresh.js";
import {
  ACCOUNT_REFRESH_LEAD_MS,
  scheduleAccountRefresh,
  type AccountRefreshSchedule,
} from "./account-refresh-schedule.js";

export interface AccountPoolCore {
  readonly pool: AccountPool;
  readonly refresh: AccountCredentialRefreshManager;
  readonly schedule: AccountRefreshSchedule;
  /** A usable credential for `account` (renewing it when expired or rejected), then re-derives the schedule. */
  resolve(
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ): Promise<AccountPoolSecret>;
  /** Stops the schedule, waits for renewals in flight, then closes the pool and its storage. */
  close(): Promise<void>;
}

export function assembleAccountPoolCore(options: {
  /** The pool, constructed with `now` reading the same clock as `wake`. */
  readonly pool: AccountPool;
  /** Renews one managed credential (an executor; see account-renewal.ts). */
  readonly renew: (
    account: AccountPoolAccount,
    secret: AccountPoolSecret,
    reason: AccountCredentialRefreshReason,
  ) => Promise<AccountPoolSecret>;
  readonly wake: OwnerWake;
}): AccountPoolCore {
  const { pool, wake } = options;
  const refresh = new AccountCredentialRefreshManager({
    store: pool,
    now: () => wake.now(),
    // The schedule renews at the lead; the manager must agree that the credential is then due.
    refreshSkewMs: ACCOUNT_REFRESH_LEAD_MS,
    refresh: options.renew,
  });
  const schedule = scheduleAccountRefresh({ pool, refresh, wake, leadMs: ACCOUNT_REFRESH_LEAD_MS });
  let closing: Promise<void> | undefined;
  return {
    pool,
    refresh,
    schedule,
    resolve: (account, secret, reason) => refresh.resolve(account, secret, reason).finally(() => schedule.reschedule()),
    close: () =>
      (closing ??= (async () => {
        try {
          await schedule.close();
        } finally {
          pool.close();
        }
      })()),
  };
}
