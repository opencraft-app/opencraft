// The account pool's operations as one call surface, for comparing the
// AccountCore Durable Object's pool (shared SQL, sealed credential records,
// renewals on the object's alarm) with the Node composition of the same
// domain classes (the AccountPoolStore file owner, runtime timeouts): the
// object's test subclass serves them under `/__test/account/pool`, the Node
// side calls them on its own AccountPoolCore. Runtime-neutral (bundled into
// the workerd test worker). Results are plain JSON; failures become
// `{ error }` with the domain's message or the account failure code.
//
// `fixtureRenewalExecutor` stands in for the maintenance executor (the
// maintenance container that runs a provider's OAuth renewal, which does not
// exist yet): it answers the renewal exchange deterministically and records
// which accounts it was asked to renew.
import type { AccountPoolCore } from "@opencraft/account-pool-host/pool-core";
import type { AccountPoolSecret } from "@opencraft/account-pool-host/account-pool";
import {
  ACCOUNT_RENEWAL_PATH,
  type AccountRenewalExecutor,
  type AccountRenewalRequest,
} from "@opencraft/account-pool-host/renewal";

export interface FixtureRenewalExecutor extends AccountRenewalExecutor {
  /** Upstream account ids, in the order the executor was asked to renew them. */
  readonly calls: string[];
}

/** Renews `<token>` to `<token>+r` for an hour; a refresh token starting with `revoked` is rejected. */
export function fixtureRenewalExecutor(): FixtureRenewalExecutor {
  const calls: string[] = [];
  return {
    calls,
    async fetch(request) {
      if (new URL(request.url).pathname !== ACCOUNT_RENEWAL_PATH || request.method !== "POST")
        return Response.json({ error: "missing" }, { status: 404 });
      const body = (await request.json()) as AccountRenewalRequest;
      calls.push(body.upstreamAccountId);
      if (body.secret.refreshToken.startsWith("revoked"))
        return Response.json({ status: "failed", code: "authorization-rejected" });
      return Response.json({
        status: "renewed",
        upstreamAccountId: body.upstreamAccountId,
        secret: {
          accessToken: `${body.secret.accessToken}+r`,
          refreshToken: `${body.secret.refreshToken}+r`,
          idToken: null,
          expiresAt: Date.now() + 60 * 60_000,
        },
      });
    },
  };
}

export type AccountPoolOperation =
  | { op: "pool.add"; id: string; priority: number; secret: AccountPoolSecret }
  | { op: "pool.list" }
  | { op: "pool.states" }
  | {
      op: "pool.select";
      hostId: string;
      affinityId: string;
      parentAffinityId?: string;
      exclude?: string[];
      purpose?: "conversation" | "metadata";
      accept?: boolean;
    }
  | {
      op: "pool.observeQuota";
      id: string;
      utilization: number | null;
      resetAt: number | null;
      heldUntil?: number | null;
    }
  | { op: "pool.markRejected"; id: string }
  | { op: "pool.setEnabled"; id: string; enabled: boolean }
  | { op: "pool.reorder"; ids: string[] }
  | { op: "pool.remove"; id: string }
  | { op: "pool.replaceCredential"; id: string; secret: AccountPoolSecret }
  | { op: "pool.credential"; id: string }
  | { op: "pool.hostToken"; hostId: string }
  | { op: "pool.authenticate"; token: string }
  | { op: "pool.resolve"; id: string; reason: "expired" | "unauthorized" }
  | { op: "pool.maintenance"; id: string }
  | { op: "pool.renewalDue" }
  | { op: "pool.affinityCount" };

export type AccountPoolOperationResult = { ok: unknown } | { error: string };

const failure = (error: unknown) => {
  const diagnostic = (error as { diagnostic?: { code?: string } } | null)?.diagnostic;
  if (diagnostic?.code) return { error: diagnostic.code };
  return { error: error instanceof Error ? error.message : String(error) };
};

export async function runAccountPoolOperation(
  core: AccountPoolCore,
  operation: AccountPoolOperation,
): Promise<AccountPoolOperationResult> {
  const { pool } = core;
  try {
    switch (operation.op) {
      case "pool.add": {
        const added = pool.addAccount(
          {
            id: operation.id,
            provider: "codex",
            label: operation.id.toUpperCase(),
            upstreamAccountId: `upstream-${operation.id}`,
            priority: operation.priority,
            enabled: true,
          },
          operation.secret,
        );
        core.schedule.reschedule();
        return { ok: added };
      }
      case "pool.list":
        return { ok: pool.listAccounts() };
      case "pool.states":
        return { ok: pool.listAccountStates() };
      case "pool.select": {
        const selection = pool.select({
          provider: "codex",
          hostId: operation.hostId,
          affinityId: operation.affinityId,
          parentAffinityId: operation.parentAffinityId ?? null,
          ...(operation.exclude ? { excludeAccountIds: new Set(operation.exclude) } : {}),
          ...(operation.purpose ? { purpose: operation.purpose } : {}),
        });
        if (operation.accept) selection.accept();
        return {
          ok: {
            account: selection.account.id,
            accessToken: selection.secret.accessToken,
            keepsAffinity: selection.keepsAffinity,
            held: selection.heldUntil !== null,
          },
        };
      }
      case "pool.observeQuota":
        pool.observeQuota(operation.id, {
          utilization: operation.utilization,
          resetAt: operation.resetAt,
          ...(operation.heldUntil === undefined ? {} : { heldUntil: operation.heldUntil }),
        });
        return { ok: null };
      case "pool.markRejected":
        pool.markAccountError(operation.id, "authorization-rejected");
        return { ok: null };
      case "pool.setEnabled":
        pool.setEnabled(operation.id, operation.enabled);
        core.schedule.reschedule();
        return { ok: null };
      case "pool.reorder":
        pool.reorder("codex", operation.ids);
        return { ok: null };
      case "pool.remove":
        pool.removeAccount(operation.id);
        core.schedule.reschedule();
        return { ok: null };
      case "pool.replaceCredential":
        pool.replaceCredential(operation.id, operation.secret);
        core.schedule.reschedule();
        return { ok: null };
      case "pool.credential":
        return { ok: pool.readCredential(operation.id) };
      case "pool.hostToken": {
        const token = pool.issueHostToken(operation.hostId);
        return { ok: { token, stable: pool.issueHostToken(operation.hostId) === token } };
      }
      case "pool.authenticate":
        return { ok: pool.authenticateHostToken(operation.token) };
      case "pool.resolve": {
        const account = pool.getAccount(operation.id);
        const secret = pool.readCredential(operation.id);
        return { ok: await core.resolve(account, secret, operation.reason) };
      }
      case "pool.maintenance": {
        const view = pool.accountMaintenance(operation.id);
        return { ok: view ? { state: view.state, failure: view.failure?.code ?? null } : null };
      }
      case "pool.renewalDue":
        return { ok: core.schedule.nextDueAt() };
      case "pool.affinityCount":
        return { ok: pool.affinityCount() };
    }
  } catch (error) {
    return failure(error);
  }
}
