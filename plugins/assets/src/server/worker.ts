import type { WorkspaceCatalog } from "@opencraft/appserver-protocol";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import type { WorkspaceBudgetPort } from "./workspace-budget.js";
import type {
  GitExecutionLocator,
  GitExecutionHandoff,
  GitExecutionReservation,
} from "@opencraft/execution-environment/git-execution";
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
  adoptWorkspaceInstallation(path: string): Promise<boolean>;
  workspaceCatalog(access: AssetAdmission): Promise<WorkspaceCatalog>;
  workspaceResolveEnvironment(
    access: AssetAdmission,
    target: unknown,
  ): Promise<ResolvedWorkspaceSelection["environment"]>;
  workspaceValidateEnvironment(
    access: AssetAdmission,
    environment: ResolvedWorkspaceSelection["environment"],
  ): Promise<boolean>;
  executionGitReservation(locator: GitExecutionLocator): Promise<GitExecutionReservation | null>;
  executionGitGrant(locator: GitExecutionLocator): Promise<GitExecutionHandoff | null>;
  gitSnapshot(access: AssetAdmission): Promise<GitConnectionsSnapshot>;
  gitUpdate(access: AssetAdmission, input: unknown): Promise<GitConnectionsSnapshot>;
}
interface Ready {
  outcome: DatabaseOutcome;
  gitHosts: readonly string[];
  gitAuthority: string | null;
  workspaceExecution: boolean;
  botExecution?: boolean;
}
/** All vault opens, migrations, reads and writes belong to this FIFO Worker.
 * There is no local fallback, runtime-secret RPC or automatic mutation retry. */
export async function openAssetConfigurations(
  directory: string,
  options: {
    entry?: URL;
    installationFile?: string;
    workspaceMachineId?: string;
    terminalOwner?: { directory: string; endpoint: string; tokenFile: string };
  } = {},
) {
  const { owner, ready } = await WorkerOwner.open<AssetStoragePort, Ready>(
    options.entry ?? ownerEntry(import.meta.url, "assets-configuration"),
    {
      name: "Asset configuration storage",
      workerData: {
        directory,
        ...(options.terminalOwner === undefined ? {} : { terminalOwner: options.terminalOwner }),
        ...(options.workspaceMachineId === undefined ? {} : { workspaceMachineId: options.workspaceMachineId }),
      },
      errors: [SandboxConfigurationError],
      maxPending: 128,
    },
  );
  if (
    options.installationFile !== undefined ||
    options.workspaceMachineId !== undefined ||
    options.terminalOwner !== undefined
  ) {
    try {
      if (
        (options.workspaceMachineId !== undefined || options.terminalOwner !== undefined) &&
        ready.workspaceExecution !== true
      )
        throw new SandboxConfigurationError("unavailable", 503);
      if (options.installationFile !== undefined) await owner.call.adoptWorkspaceInstallation(options.installationFile);
    } catch (cause) {
      try {
        await owner.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], "Assets bootstrap cleanup unconfirmed");
      }
      throw cause;
    }
  }
  return {
    store: owner.call,
    outcome: ready.outcome,
    gitHosts: ready.gitHosts,
    gitAuthority: ready.gitAuthority,
    workspaceExecution: ready.workspaceExecution === true,
    botExecution: ready.botExecution === true,
    close: () => owner.close(),
  };
}
