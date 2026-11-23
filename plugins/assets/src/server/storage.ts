import type { CreateAssetWorkspaceExecutionOwner, AssetWorkspaceExecutionOwner } from "./workspace-owner.js";
import { InstalledWorkspaceCatalog } from "./workspace-catalog.js";
import { adoptInstalledWorkspaceConfiguration } from "./installed-delivery.js";
import type { ResolvedWorkspaceSelection } from "@opencraft/execution-environment/workspace-selection";
import { WorkspaceBudgetStore, type WorkspaceBudgetRole, type WorkspaceBudgetOutcome } from "./workspace-budget.js";
import type { SandboxIdentity, SandboxResources } from "@opencraft/sandbox";
import { parseGitExecutionLocator, type GitExecutionResolver } from "@opencraft/execution-environment/git-execution";
import { EmployeeGitVaultStore, GitVaultError } from "@opencraft/execution-environment/employee-git-vault-store";
import {
  EnvironmentLaunchOwner,
  environmentTerminalRecords,
} from "@opencraft/execution-environment/environment-launch-owner";
import {
  EnvironmentMetadata,
  type EnvironmentExecutionScope,
  type EnvironmentScopeRequest,
} from "@opencraft/execution-environment/environment-metadata";
import type {
  AnyEnvironmentLaunchContext,
  EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import { PLATFORM_ASSET_SCOPE } from "../contract.js";
import { SandboxConfigurations, SandboxConfigurationError } from "./configurations.js";
import { GitConnections, type GitConnectionProvider } from "./git-connections.js";
import { githubConnectionProvider } from "./github-provider.js";
import type { AssetAdmission } from "./worker.js";

export async function createAssetsStorage(
  directory: string,
  providers: readonly GitConnectionProvider[] = [githubConnectionProvider()],
  execution?: GitExecutionResolver,
  createWorkspaces?: CreateAssetWorkspaceExecutionOwner,
  /** Issue opaque execution ENV capsules from this sole vault owner, which
   * then also owns the non-secret ENV metadata (bindings, creators, catalog). */
  options: { environmentLaunch?: boolean } = {},
) {
  // ENV for a launch needs the durable admission this owner reads itself.
  if (options.environmentLaunch && !execution) throw new Error("Environment delivery requires execution admission");
  const vault = new EmployeeGitVaultStore(directory);
  let workspaces: AssetWorkspaceExecutionOwner | undefined;
  let environment: EnvironmentLaunchOwner | undefined;
  // Retire the issuer key before the admission reader and the vault close.
  const release = async () => {
    environment?.close();
    try {
      await workspaces?.close();
    } finally {
      try {
        execution?.close();
      } finally {
        vault.close();
      }
    }
  };
  try {
    environment =
      options.environmentLaunch && execution
        ? new EnvironmentLaunchOwner(
            vault,
            (input) => execution.resolve(input),
            // Terminal launches are admitted under the current Actor epoch.
            execution.actor
              ? { terminal: environmentTerminalRecords(vault, (account) => execution.actor!(account)) }
              : {},
          )
        : undefined;
    const metadata = environment ? new EnvironmentMetadata(vault) : undefined;
    // Metadata runs FIFO with every other vault write; nothing it returns is a value.
    const metadataCall = <T>(operation: (owner: EnvironmentMetadata) => T): T => {
      try {
        return operation(metadata!);
      } catch {
        throw new SandboxConfigurationError("environment_unavailable", 503);
      }
    };
    const configurations = new SandboxConfigurations(vault);
    const workspaceCatalog = new InstalledWorkspaceCatalog(configurations);
    const workspaceBudget = new WorkspaceBudgetStore(vault, () => {
      const runtime = configurations.installedRuntime();
      if (!runtime) throw new SandboxConfigurationError("unavailable", 503);
      return runtime.policy.capacity;
    });
    const budgetCall = <T>(operation: () => T): T => {
      try {
        return operation();
      } catch {
        throw new SandboxConfigurationError("unavailable", 503);
      }
    };
    const git = new GitConnections(vault, providers);
    function check(access: AssetAdmission) {
      if (
        !access ||
        typeof access.scope !== "string" ||
        !access.scope ||
        access.scope === PLATFORM_ASSET_SCOPE ||
        access.scope.length > 256 ||
        /[\x00-\x1f\x7f]/u.test(access.scope) ||
        typeof access.allowCustomEndpoints !== "boolean" ||
        typeof access.canManagePlatform !== "boolean" ||
        !Number.isSafeInteger(access.expiresAt) ||
        access.expiresAt <= Date.now() ||
        !(access.permit instanceof Int32Array) ||
        !(access.permit.buffer instanceof SharedArrayBuffer) ||
        access.permit.length !== 1 ||
        Atomics.load(access.permit, 0) !== 1
      )
        throw new SandboxConfigurationError("forbidden", 403);
    }
    async function run(access: AssetAdmission, action: (assertCurrent: () => void) => unknown) {
      check(access);
      try {
        return await action(() => check(access));
      } catch (error) {
        if (error instanceof SandboxConfigurationError) throw error;
        if (error instanceof GitVaultError && error.code === "conflict")
          throw new SandboxConfigurationError("conflict", 409);
        // SQLite paths, encrypted payloads and backend exceptions never cross RPC.
        throw new SandboxConfigurationError("unavailable", 503);
      }
    }
    workspaces = await createWorkspaces?.({
      directory,
      vault,
      configurations,
      catalog: workspaceCatalog,
      budget: workspaceBudget,
    });
    const workspaceMethods = workspaces?.methods ?? {};
    if (
      Object.keys(workspaceMethods).some(
        (name) =>
          !/^workspace(?:Begin|Status|NativeReceipt|Cancel|Forget|Selection|FileScope|FileRequest|PlacementPage|ArtifactDownload|ArtifactRead|ArtifactUpload|ArtifactWrite|ArtifactFinish|ArtifactClose|TerminalOpen|TerminalProbe|TerminalRequest|TerminalStatus|TerminalForget|TerminalSnapshot|TerminalUnwatch|BrowserOpen|BrowserStatus|BrowserRead|BrowserSend|BrowserSent|BrowserForget|BrowserClose|LifecycleBegin|LifecycleStatus|LifecycleForget|BotCatalog|BotValidate|BotOpen|BotStatus|BotExecute|BotOperation|BotForget|BotClose|BotCallbacks|BotReply)$/.test(
            name,
          ),
      )
    )
      throw new Error("Invalid compiled workspace owner");
    const catalogContext = (access: AssetAdmission) => ({
      scope: access.scope,
      current() {
        try {
          check(access);
          return true;
        } catch {
          return false;
        }
      },
    });
    return {
      concurrentReads: execution
        ? [
            "executionGitGrant",
            "executionGitReservation",
            // Metadata reads see committed bindings; a Gateway forwards a Thread
            // only after its binding committed, so later reads observe it.
            ...(environment
              ? [
                  "executionEnvironmentLaunch",
                  "environmentMetadataAdmit",
                  "environmentMetadataProject",
                  ...(execution.actor ? ["executionEnvironmentActor"] : []),
                ]
              : []),
          ]
        : [],
      ready: {
        outcome: vault.outcome,
        workspaceExecution: workspaces !== undefined && workspaces.workspaceExecution !== false,
        botExecution: workspaces?.botExecution === true,
        gitHosts: providers.map((p) => p.host),
        gitAuthority: execution ? vault.personalGitAuthority("actor") : null,
        environmentIssuer: environment?.issuer ?? null,
        environmentTerminal: !!environment && !!execution?.actor,
      },
      methods: {
        ...Object.fromEntries(
          Object.entries(workspaceMethods).map(([name, method]) => [
            name,
            async (...args: never[]) => {
              try {
                return await method(...args);
              } catch {
                throw new SandboxConfigurationError("unavailable", 503);
              }
            },
          ]),
        ),
        // Trusted installed-file delivery only; no configuration HTTP action.
        adoptWorkspaceInstallation: (path: string) =>
          budgetCall(async () => {
            try {
              return await adoptInstalledWorkspaceConfiguration(configurations, path);
            } catch {
              throw new SandboxConfigurationError("unavailable", 503);
            }
          }),
        workspaceCatalog: (access: AssetAdmission) =>
          run(access, () => {
            const value = workspaceCatalog.snapshot(catalogContext(access));
            return {
              version: 1 as const,
              environments: value.environments,
              libraries: value.libraries.map(({ id, name, status, environmentIds }) => ({
                id,
                name,
                status,
                environmentIds,
              })),
            };
          }),
        workspaceResolveEnvironment: (access: AssetAdmission, target: unknown) =>
          run(access, () => workspaceCatalog.resolveEnvironment(catalogContext(access), target)),
        workspaceValidateEnvironment: (
          access: AssetAdmission,
          environment: ResolvedWorkspaceSelection["environment"],
        ) =>
          run(access, async () => {
            await workspaceCatalog.runtime(catalogContext(access), environment).authorize();
            return true;
          }),
        // Compiled provider lifecycle only; never an HTTP configuration action.
        workspaceBudgetReserve: (role: WorkspaceBudgetRole, identity: SandboxIdentity, resources: SandboxResources) =>
          budgetCall(() => workspaceBudget.reserve(role, identity, resources)),
        workspaceBudgetSettle: (key: string, outcome: WorkspaceBudgetOutcome) =>
          budgetCall(() => workspaceBudget.settle(key, outcome)),
        executionGitReservation: (raw: unknown) => {
          try {
            if (!execution?.reserve) throw Error("unavailable");
            const input = parseGitExecutionLocator(raw);
            if (input.hostId !== "local-codex" || !input.inputId || input.turnId) throw Error("unavailable");
            const admission = execution.reserve(input),
              scope = admission?.scope;
            if (!scope) return null;
            if (
              !scope.account.startsWith("actor:human://") ||
              scope.hostId !== input.hostId ||
              scope.threadId !== input.threadId ||
              scope.inputId !== input.inputId ||
              JSON.stringify(execution.reserve(input)) !== JSON.stringify(admission)
            )
              throw Error("unavailable");
            return {
              scope,
              native: admission!.native,
              authority: vault.personalGitAuthority("actor"),
              capability: vault.sealPersonalGitGrant(scope),
            };
          } catch {
            throw new SandboxConfigurationError("execution_unavailable", 503);
          }
        },
        executionGitGrant: (raw: unknown) => {
          try {
            if (!execution) throw new SandboxConfigurationError("execution_unavailable", 503);
            const input = parseGitExecutionLocator(raw),
              admission = execution.resolve(input);
            const scope = admission?.scope;
            if (!scope) return null;
            // Freeze the exact original input, generation and canonical Human partition.
            if (
              !scope.account.startsWith("actor:human://") ||
              scope.hostId !== input.hostId ||
              scope.threadId !== input.threadId ||
              (input.inputId !== undefined && scope.inputId !== input.inputId) ||
              (input.turnId !== undefined && admission!.native.turnId !== input.turnId)
            )
              throw new SandboxConfigurationError("execution_unavailable", 503);
            const current = execution.resolve(input);
            if (JSON.stringify(current) !== JSON.stringify(admission))
              throw new SandboxConfigurationError("execution_unavailable", 503);
            return {
              scope,
              native: admission!.native,
              authority: vault.personalGitAuthority("actor"),
              capability: vault.sealPersonalGitGrant(scope),
            };
          } catch (error) {
            if (error instanceof SandboxConfigurationError) throw error;
            throw new SandboxConfigurationError("execution_unavailable", 503);
          }
        },
        // Returns only an opaque capsule for one execution process. There is no
        // method that returns decrypted ENV values to the caller of this Worker.
        ...(environment
          ? {
              executionEnvironmentLaunch: (target: EnvironmentLaunchTarget, context: AnyEnvironmentLaunchContext) => {
                try {
                  return environment!.seal(target, context);
                } catch {
                  throw new SandboxConfigurationError("execution_unavailable", 503);
                }
              },
              // The epoch a terminal reservation records; no value, no Project.
              ...(execution?.actor
                ? {
                    executionEnvironmentActor: (account: string) => {
                      try {
                        return execution!.actor!(account);
                      } catch {
                        throw new SandboxConfigurationError("execution_unavailable", 503);
                      }
                    },
                  }
                : {}),
              environmentMetadataAdmit: (request: EnvironmentScopeRequest) => metadataCall((m) => m.admit(request)),
              environmentMetadataProject: (hostId: string, threadId: string) =>
                metadataCall((m) => m.project(hostId, threadId)),
              environmentMetadataBind: (hostId: string, threadId: string, projectId: string | null) =>
                metadataCall((m) => m.bind(hostId, threadId, projectId)),
              environmentMetadataBindCreator: (scope: EnvironmentExecutionScope, threadId: string) =>
                metadataCall((m) => m.bindCreator(scope, threadId)),
              environmentMetadataRememberProjects: (hostId: string, projects: readonly { id: string; name: string }[]) =>
                metadataCall((m) => m.rememberProjects(hostId, projects)),
            }
          : {}),
        gitSnapshot: (access: AssetAdmission) => run(access, () => git.snapshot(access.scope)),
        gitUpdate: (access: AssetAdmission, input: unknown) =>
          run(access, (check) => git.update(access.scope, input, check)),
        snapshot: (access: AssetAdmission) =>
          run(access, () =>
            configurations.snapshot(access.scope, access.allowCustomEndpoints, access.canManagePlatform),
          ),
        update: (access: AssetAdmission, input: unknown) =>
          run(access, () =>
            configurations.update(access.scope, input, access.allowCustomEndpoints, access.canManagePlatform),
          ),
      },
      close: release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}
