import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { MembershipStore } from "@opencraft/access-control";
import { EmployeeGitVaultStore } from "@opencraft/execution-environment/employee-git-vault-store";
import { SandboxConfigurations } from "@opencraft/plugin-assets/server/configurations";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import { withWorkspaceBudget } from "@opencraft/plugin-assets/server/workspace-budget";
import { createWorkspaceExecutionOwner } from "../../apps/headless-server/src/workspaces/execution-owner.js";
import { InstalledOrdinaryConversationRuntime } from "../../apps/headless-server/src/workspaces/ordinary-conversation-runtime.js";
import {
  InstalledOrdinaryWorkspaceSources,
  PublishedOrdinaryGitSources,
} from "../../apps/headless-server/src/workspaces/ordinary-git-sources.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
serveWorkerOwner<{ directory: string }>(async ({ directory }) => {
  // Bootstrap the synthetic Actor and installation serially, then close both
  // writers before the sole runtime vault owner/read-only Actor reader opens.
  const server = await openServerDatabase(directory),
    actors = new ActorStore(server),
    members = new MembershipStore(server);
  let actor;
  try {
    const login = actors.resolveHuman({
      provider: "local",
      subject: "workspace-owner",
      displayName: "Fixture",
      expiresAt: Date.now() + 60000,
    });
    if (!login) throw Error("Synthetic Actor unavailable");
    actor = actors.get(login.actorId)!;
    if (!members.actorMembership(actor.id)) members.setActor(actor.id, "member", true, "fixture");
  } finally {
    members.close();
    actors.close();
    await server.close();
  }
  const vault = new EmployeeGitVaultStore(directory);
  try {
    new SandboxConfigurations(vault).adoptInstallation(
      {
        apiUrl: "https://api.e2b.dev",
        sandboxUrl: "https://e2b.dev",
        capacity: resources,
        persistentWorkspaces: true,
        lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
        templates: [{ id: "synthetic-template", name: "Synthetic", workspaceRoot: "/workspace", resources }],
      },
      "synthetic-worker-execution-key",
    );
  } finally {
    vault.close();
  }
  let allocated = 0,
    deleted = 0,
    failCleanup = false;
  const providerPath = join(directory, "synthetic-provider.json");
  let retained: Record<string, boolean>;
  try {
    retained = JSON.parse(await readFile(providerPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    retained = {};
  }
  const save = () => writeFile(providerPath, JSON.stringify(retained), { mode: 0o600 });
  const storage = await createAssetsStorage(directory, [], undefined, (context) =>
    createWorkspaceExecutionOwner(context, {
      machineId: "synthetic-machine",
      runtime: (store, owner) =>
        new InstalledOrdinaryConversationRuntime(
          store,
          owner.catalog,
          new InstalledOrdinaryWorkspaceSources(owner.catalog, new PublishedOrdinaryGitSources(owner.vault)),
          {
            // Synthetic provider/binding only: no real E2B or exec-server claim.
            allocator: {
              async allocate(input) {
                await input.authorize();
                const backend = withWorkspaceBudget(
                  {
                    workspaceBudgetReserve: async (...args) => owner.budget.reserve(...args),
                    workspaceBudgetSettle: async (...args) => owner.budget.settle(...args),
                  },
                  "ordinary",
                  {
                    id: "e2b",
                    async initialize() {},
                    async close() {},
                    async create() {
                      allocated++;
                      retained[input.lease.workspaceId] = true;
                      await save();
                      return {
                        resources,
                        capabilities: { terminal: true },
                        async spawn(): Promise<never> {
                          throw Error("unused");
                        },
                        async close() {
                          if (failCleanup) throw Error("synthetic unknown deletion");
                          delete retained[input.lease.workspaceId];
                          await save();
                          deleted++;
                        },
                      };
                    },
                  },
                );
                const environment = await backend.create(
                  {
                    id: input.lease.workspaceId + ":" + input.lease.generation,
                    owner: input.lease.owner,
                    backend: "e2b",
                  },
                  resources,
                  new AbortController().signal,
                );
                return {
                  instanceId: "synthetic-" + input.lease.generation,
                  privateVolumeId: "11111111-1111-1111-1111-111111111111",
                  environment,
                  close: () => environment.close(),
                };
              },
              async inspect(_context, _environment, binding, authorize) {
                await authorize();
                return retained[binding.workspaceId] ? "present" : "absent";
              },
              async close() {},
            },
            async verifyMounts() {
              return { cwd: "/workspace" };
            },
            async bind(options) {
              let current = true;
              return {
                isCurrent: () => current,
                async executionFields() {
                  await options.authorize();
                  return {
                    cwd: "/workspace",
                    runtimeWorkspaceRoots: ["/workspace"],
                    environments: [{ environmentId: options.environmentId!, cwd: "/workspace" }],
                  };
                },
                async executionSelection() {
                  await options.authorize();
                  return {
                    kind: "bound" as const,
                    workspaceId: options.workspaceLease!.workspaceId,
                    generation: options.workspaceLease!.generation,
                    environmentId: options.environmentId!,
                    cwd: "/workspace",
                    execServerUrl: "ws://127.0.0.1:9/" + "a".repeat(64),
                  };
                },
                async bindThread() {
                  await options.authorize();
                },
                async close() {
                  current = false;
                },
                files: {
                  async request() {
                    await options.authorize();
                    return { entries: [] };
                  },
                },
              };
            },
          },
        ),
    }),
  );
  return {
    ...storage,
    ready: { ...storage.ready, actorId: actor.id, generation: actor.generation },
    methods: {
      ...storage.methods,
      fixtureCounters: () => ({ allocated, deleted, retained: Object.keys(retained).length }),
      fixtureFailCleanup: () => {
        failCleanup = true;
      },
      fixtureDisableActor: () => {
        const db = new DatabaseSync(join(directory, "opencraft-server.sqlite"));
        try {
          db.prepare("UPDATE actors SET enabled=0,generation=generation+1 WHERE id=?").run(actor.id);
        } finally {
          db.close();
        }
      },
    },
  };
});
