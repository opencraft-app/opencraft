import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { SandboxConfigurationsSnapshot } from "../contract.js";
import { SandboxConfigurationError } from "./errors.js";

/** A request-local revocable admission, not an identity supplied by HTTP input.
 * The authenticated owner invalidates permit[0] on account/role/session changes.
 * The Worker checks both permit and expiry immediately before domain IO. */
export interface AssetAdmission {
  readonly scope: string;
  readonly allowCustomEndpoints: boolean;
  readonly canManagePlatform: boolean;
  readonly expiresAt: number;
  readonly permit: Int32Array<SharedArrayBuffer>;
}
export interface AssetConfigurationPort {
  snapshot(access: AssetAdmission): Promise<SandboxConfigurationsSnapshot>;
  update(access: AssetAdmission, input: unknown): Promise<SandboxConfigurationsSnapshot>;
}
/** All vault opens, migrations, reads and writes belong to this FIFO Worker.
 * There is no local fallback, runtime-secret RPC or automatic mutation retry. */
export async function openAssetConfigurations(directory: string) {
  const { owner, ready } = await WorkerOwner.open<AssetConfigurationPort, DatabaseOutcome>(
    ownerEntry(import.meta.url, "assets-configuration"),
    {
      name: "Asset configuration storage",
      workerData: { directory },
      errors: [SandboxConfigurationError],
      maxPending: 128,
    },
  );
  return { store: owner.call, outcome: ready, close: () => owner.close() };
}
