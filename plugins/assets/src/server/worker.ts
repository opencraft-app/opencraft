import type { WorkspaceBudgetPort } from "./workspace-budget.js";
import type { GitExecutionLocator, GitExecutionHandoff, GitExecutionReservation } from "@opencraft/execution-environment/git-execution";
import type { GitConnectionsSnapshot } from "../git/contract.js";
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
export interface AssetStoragePort extends AssetConfigurationPort, WorkspaceBudgetPort {
  executionGitReservation(locator: GitExecutionLocator): Promise<GitExecutionReservation | null>;
  executionGitGrant(locator: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  gitSnapshot(access: AssetAdmission): Promise<GitConnectionsSnapshot>;
  gitUpdate(access: AssetAdmission, input: unknown): Promise<GitConnectionsSnapshot>;
}
interface Ready {
  outcome: DatabaseOutcome;
  gitHosts: readonly string[];
  gitAuthority: string | null;
}
/** All vault opens, migrations, reads and writes belong to this FIFO Worker.
 * There is no local fallback, runtime-secret RPC or automatic mutation retry. */
export async function openAssetConfigurations(directory: string, options: { entry?: URL } = {}) {
  const { owner, ready } = await WorkerOwner.open<AssetStoragePort, Ready>(
    options.entry ?? ownerEntry(import.meta.url, "assets-configuration"),
    {
      name: "Asset configuration storage",
      workerData: { directory },
      errors: [SandboxConfigurationError],
      maxPending: 128,
    },
  );
  return {
    store: owner.call,
    outcome: ready.outcome,
    gitHosts: ready.gitHosts,
    gitAuthority: ready.gitAuthority,
    close: () => owner.close(),
  };
}
