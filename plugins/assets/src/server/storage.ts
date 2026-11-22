import { parseGitExecutionLocator, type GitExecutionResolver } from "@opencraft/execution-environment/git-execution";
import { EmployeeGitVaultStore, GitVaultError } from "@opencraft/execution-environment/employee-git-vault-store";
import { PLATFORM_ASSET_SCOPE } from "../contract.js";
import { SandboxConfigurations, SandboxConfigurationError } from "./configurations.js";
import { GitConnections, type GitConnectionProvider } from "./git-connections.js";
import { githubConnectionProvider } from "./github-provider.js";
import type { AssetAdmission } from "./worker.js";

export function createAssetsStorage(
  directory: string,
  providers: readonly GitConnectionProvider[] = [githubConnectionProvider()],
  execution?: GitExecutionResolver,
) {
  const vault = new EmployeeGitVaultStore(directory);
  try {
    const configurations = new SandboxConfigurations(vault);
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
    return {
      concurrentReads:execution?['executionGitGrant']:[],
      ready: {
        outcome: vault.outcome,
        gitHosts: providers.map((p) => p.host),
        gitAuthority: execution ? vault.personalGitAuthority("actor") : null,
      },
      methods: {
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
              scope.inputId !== input.inputId
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
      close: () => {
        try {
          execution?.close();
        } finally {
          vault.close();
        }
      },
    };
  } catch (error) {
    try {
      execution?.close();
    } finally {
      vault.close();
    }
    throw error;
  }
}
