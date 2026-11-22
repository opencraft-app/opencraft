import { EmployeeGitVaultStore, GitVaultError } from "@opencraft/execution-environment/employee-git-vault-store";
import { PLATFORM_ASSET_SCOPE } from "../contract.js";
import { SandboxConfigurations, SandboxConfigurationError } from "./configurations.js";
import { GitConnections, type GitConnectionProvider } from "./git-connections.js";
import { githubConnectionProvider } from "./github-provider.js";
import type { AssetAdmission } from "./worker.js";

export function createAssetsStorage(
  directory: string,
  providers: readonly GitConnectionProvider[] = [githubConnectionProvider()],
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
      ready: { outcome: vault.outcome, gitHosts: providers.map((p) => p.host) },
      methods: {
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
      close: () => vault.close(),
    };
  } catch (error) {
    vault.close();
    throw error;
  }
}
