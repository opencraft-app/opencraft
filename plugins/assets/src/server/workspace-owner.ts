import type { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import type { SandboxConfigurations } from "./configurations.js";
import type { InstalledWorkspaceCatalog } from "./workspace-catalog.js";
import type { WorkspaceBudgetStore } from "./workspace-budget.js";

/** Compiled Worker composition only. These objects never cross RPC or open a
 * second vault connection. The execution owner must close before this storage. */
export interface AssetWorkspaceOwnerContext {
  readonly directory: string;
  readonly vault: EmployeeGitVaultStore;
  readonly configurations: SandboxConfigurations;
  readonly catalog: InstalledWorkspaceCatalog;
  readonly budget: WorkspaceBudgetStore;
}
export interface AssetWorkspaceExecutionOwner {
  readonly methods: Record<string, (...args: never[]) => unknown>;
  close(): Promise<void>;
}
export type CreateAssetWorkspaceExecutionOwner = (
  context: AssetWorkspaceOwnerContext,
) => AssetWorkspaceExecutionOwner | Promise<AssetWorkspaceExecutionOwner>;
