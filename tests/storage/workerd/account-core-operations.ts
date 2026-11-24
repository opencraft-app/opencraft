// The account module's storage operations as one call surface, for comparing
// the AccountCore Durable Object with the Node account assembly: the object's
// test subclass serves them under `/__test/account/op`, the Node side calls
// them on `assembleAccount(nodeAccountInputs(...))`. Runtime-neutral (bundled
// into the workerd test worker). Results are plain JSON; failures become
// `{ error }` with the lease error code or the repository's message.
import { CredentialLeaseError } from "@opencraft/account-pool-host/credential-leases";
import type { AccountAssembly } from "../../../apps/headless-server/src/assembly/account.mjs";

export type AccountOperation =
  | { op: "config.read" }
  | { op: "config.update"; revision: number; providers: unknown[] }
  | { op: "credentials.set"; ref: string; value: string }
  | { op: "credentials.configured"; ref: string }
  | { op: "credentials.remove"; ref: string }
  | { op: "leases.grant"; holder: { workspace: string; engine: string; incarnation: string }; ttlMs: number }
  | { op: "leases.renew"; id: string; ttlMs: number }
  | { op: "leases.redeem"; token: string; providerId: string }
  | { op: "leases.revoke"; id: string }
  | { op: "leases.revokeHolder"; match: { workspace: string; engine?: string; keepIncarnation?: string } };

export type AccountOperationResult = { ok: unknown } | { error: string };

export async function runAccountOperation(
  account: Pick<AccountAssembly, "modelConfiguration" | "modelCredentials" | "credentialLeases">,
  operation: AccountOperation,
): Promise<AccountOperationResult> {
  try {
    switch (operation.op) {
      case "config.read":
        return { ok: await account.modelConfiguration.read() };
      case "config.update":
        return {
          ok: await account.modelConfiguration.update(operation.revision, (draft) => {
            draft.providers = operation.providers as typeof draft.providers;
          }),
        };
      case "credentials.set":
        await account.modelCredentials.set(operation.ref, operation.value);
        return { ok: null };
      case "credentials.configured":
        return { ok: await account.modelCredentials.configured(operation.ref) };
      case "credentials.remove":
        await account.modelCredentials.remove(operation.ref);
        return { ok: null };
      case "leases.grant":
        return { ok: await account.credentialLeases.grant(operation.holder, operation.ttlMs) };
      case "leases.renew":
        return { ok: await account.credentialLeases.renew(operation.id, operation.ttlMs) };
      case "leases.redeem":
        return { ok: await account.credentialLeases.redeem(operation.token, operation.providerId) };
      case "leases.revoke":
        return { ok: await account.credentialLeases.revoke(operation.id) };
      case "leases.revokeHolder":
        return { ok: await account.credentialLeases.revokeHolder(operation.match) };
    }
  } catch (error) {
    if (error instanceof CredentialLeaseError) return { error: error.code };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
