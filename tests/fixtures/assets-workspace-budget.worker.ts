import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurations } from "@opencraft/plugin-assets/server/configurations";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";

serveWorkerOwner<{ directory: string }>(async ({ directory }) => {
  // Synthetic installation fixture, serial bootstrap before the runtime owner
  // opens the vault. Never two simultaneous writable connections.
  const bootstrap = await EmployeeGitVaultStore.open(directory);
  try {
    new SandboxConfigurations(bootstrap).adoptInstallation(
      {
        apiUrl: "https://api.e2b.dev",
        sandboxUrl: "https://e2b.dev",
        capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
        lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
        templates: [],
      },
      "synthetic-budget-key",
    );
  } finally {
    bootstrap.close();
  }
  return createAssetsStorage(directory, []);
});
