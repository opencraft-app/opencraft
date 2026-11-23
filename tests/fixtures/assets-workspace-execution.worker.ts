import { DurableHostProcessService } from "@opencraft/local-agent-host/durable-process-service";
import { EventEmitter } from "node:events";
import type { SandboxBrowserOwnerTransport } from "@opencraft/local-agent-host/sandbox-browser-owner";
import { SandboxProcessService } from "@opencraft/local-agent-host/sandbox-process-service";
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
import type { OrdinaryWorkspaceStore, WorkspaceLease } from "@opencraft/local-agent-host/ordinary-workspace-store";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SandboxCommand, SandboxOutput, SandboxProcess } from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { workspaceArtifactSender } from "../../apps/headless-server/src/workspaces/workspace-artifact-reader.js";
import { workspaceArtifactReceiver } from "../../apps/headless-server/src/workspaces/workspace-artifact-transfer.js";

const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
type FixtureData = { directory: string; sharedViews?: boolean; terminalOwner?: { directory: string; endpoint: string; tokenFile: string } };
serveWorkerOwner<FixtureData>(async ({ directory, terminalOwner, sharedViews }) => {
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
  const vault = await EmployeeGitVaultStore.open(directory);
  try {
    new SandboxConfigurations(vault).adoptInstallation(
      {
        backend: "e2b",
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
  const sandboxRoot = join(directory, "synthetic-workspace");
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(sandboxRoot, "output.bin"), Buffer.alloc(131089, 65), { mode: 0o600 });
  await writeFile(
    join(sandboxRoot, "json.py"),
    'raise RuntimeError("User workspace modules must not replace transfer helpers")\n',
    { mode: 0o600 },
  );
  const artifactProcesses = new Set<number>();
  const terminals = new Set<string>();
  const browserOwners = new Set<string>(),
    browserAttached = new Set<string>();
  let browserCommands = 0;
  const spawnArtifact = async (
    command: SandboxCommand,
    onOutput?: (output: SandboxOutput) => void,
  ): Promise<SandboxProcess> => {
    if (command.terminal) {
      const id = randomUUID();
      terminals.add(id);
      let finish!: (value: { code: number | null }) => void;
      const exited = new Promise<{ code: number | null }>((resolve) => {
        finish = resolve;
      });
      const end = () => {
        if (terminals.delete(id)) finish({ code: 0 });
      };
      onOutput?.({ stream: "stdout", data: Buffer.from("synthetic-ready\n") });
      return {
        kind: "terminal",
        id,
        exited,
        async resize() {},
        async writeStdin(data) {
          onOutput?.({ stream: "stdout", data: Buffer.from(data) });
        },
        async terminate() {
          end();
        },
      };
    }
    if (
      command.command[0] !== "/usr/bin/python3" ||
      command.command[1] !== "-I" ||
      command.command[2] !== "-c" ||
      ![workspaceArtifactSender, workspaceArtifactReceiver].includes(command.command[3] ?? "")
    )
      throw Error("Synthetic process command unavailable");
    const program = command.command[3]!.replace(
      'root=os.open("/workspace",',
      "root=os.open(" + JSON.stringify(sandboxRoot) + ",",
    );
    const child = spawn("/usr/bin/python3", ["-I", "-c", program, ...command.command.slice(4)], {
      cwd: sandboxRoot,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) artifactProcesses.add(child.pid);
    child.stdout.on("data", (data: Buffer) => onOutput?.({ stream: "stdout", data }));
    child.stderr.on("data", (data: Buffer) => onOutput?.({ stream: "stderr", data }));
    child.stdin.on("error", () => {});
    let ended = false;
    const exited = new Promise<{ code: number | null; signal?: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        ended = true;
        if (child.pid) artifactProcesses.delete(child.pid);
        resolve({ code, ...(signal ? { signal } : {}) });
      });
    });
    return {
      kind: "process",
      id: randomUUID(),
      exited,
      writeStdin: (data) =>
        new Promise<void>((resolve, reject) => child.stdin.write(data, (error) => (error ? reject(error) : resolve()))),
      closeStdin: () =>
        new Promise<void>((resolve, reject) => child.stdin.end((error?: Error) => (error ? reject(error) : resolve()))),
      async terminate() {
        if (ended) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };

  const hands = terminalOwner
    ? new DurableHostProcessService(terminalOwner.directory, undefined, {
        ...terminalOwner,
        prepare() {
          throw Error("Private quota only");
        },
      })
    : undefined;
  let fixtureStore: OrdinaryWorkspaceStore | undefined;
  let fixtureForkLease: WorkspaceLease | undefined;
  const storage = await createAssetsStorage(directory, [], undefined, (context) =>
    createWorkspaceExecutionOwner(context, {
      machineId: "synthetic-machine",
      // The synthetic runtime below supplies its own allocator.
      providers: createSandboxProviderRegistry({}),
      runtime: (store, owner) =>
        ((fixtureStore = store), new InstalledOrdinaryConversationRuntime(
          store,
          owner.catalog,
          new InstalledOrdinaryWorkspaceSources(owner.catalog, new PublishedOrdinaryGitSources(owner.vault)),
          {
            // This fixture exercises Worker bridges, not global Hands admission.
            // The real shared owner/protocol is covered by workspace-terminal-admission.
            terminalAdmission: hands ?? {
              probeTerminalAdmission: async () => {},
              reserveTerminal: async () => randomUUID(),
              releaseTerminal: async () => {},
              confirmTerminalResourceDestroyed: async () => {},
            },
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
                        spawn: spawnArtifact,
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
              async verifyMounts() {
                return { cwd: "/workspace" as const };
              },
              async close() {},
            },
            async bind(options) {
              let current = true;
              let processes: SandboxProcessService | undefined;
              let browserPeer: SandboxBrowserOwnerTransport | undefined;
              const browserOwner = randomUUID();
              const browser = {
                assertCurrent() {
                  if (!current) throw Error("Synthetic browser retired");
                },
                async connect(): Promise<SandboxBrowserOwnerTransport> {
                  await options.authorize();
                  if (browserPeer?.connected) throw Error("Synthetic owner already attached");
                  browserOwners.add(browserOwner);
                  browserAttached.add(browserOwner);
                  const peer = Object.assign(new EventEmitter(), {
                    connected: true,
                    inventory: [],
                    workerPid: 12345,
                    automationCancellation: 1,
                    automationNavigation: 1,
                    send(input: unknown, callback?: (error?: Error) => void) {
                      if (!peer.connected) {
                        callback?.(Error("Synthetic owner detached"));
                        return;
                      }
                      browserCommands++;
                      const message = input as { id: string; page: string; method: string };
                      callback?.();
                      if (message.method === "syntheticHold") return;
                      queueMicrotask(() => {
                        if (!peer.connected) return;
                        if (message.method === "syntheticFlood") {
                          for (let i = 0; i < 100; i++)
                            peer.emit("message", {
                              type: "frame",
                              page: message.page,
                              bucket: "synthetic",
                              bytes: "YQ==",
                            });
                          return;
                        }
                        if (message.method === "syntheticMedia")
                          peer.emit("message", {
                            type: "frame",
                            page: message.page,
                            bucket: "synthetic",
                            bytes: "YQ==",
                          });
                        peer.emit("message", {
                          type: "result",
                          id: message.id,
                          value: {
                            id: message.page,
                            document: "synthetic-browser-document",
                            width: 800,
                            height: 600,
                            deviceProfile: "desktop",
                            navigation: { url: "https://example.test/", isLoading: false },
                          },
                        });
                      });
                    },
                    kill() {
                      void peer.close();
                    },
                    async close() {
                      if (!peer.connected) return;
                      peer.connected = false;
                      browserAttached.delete(browserOwner);
                      peer.emit("exit");
                    },
                  });
                  browserPeer = peer;
                  return peer;
                },
              };
              const root = {
                browser,
                get processes() {
                  return processes;
                },
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
                async bindThread(threadId) {
                  await options.authorize();
                  processes ??= new SandboxProcessService({
                    sandbox: options.sandbox,
                    cwd: "/workspace",
                    context: { threadId, projectId: null, resourceOwnerId: options.processContext!.resourceOwnerId },
                    authorize: options.authorize,
                    probeTerminalAdmission: options.probeTerminalAdmission,
                    onCleanupUnconfirmed: options.onCleanupUnconfirmed,
                  });
                },
                async close() {
                  current = false;
                  await browserPeer?.close();
                  browserOwners.delete(browserOwner);
                  await processes?.close();
                },
                files: {
                  async request() {
                    await options.authorize();
                    return { entries: [] };
                  },
                },
              };
              if (!sharedViews) return root;
              const views = new Map<string, typeof root>();
              return Object.assign(root, {
                async forThread(threadId: string) {
                  const prior = views.get(threadId);
                  if (prior) return prior;
                  let live = true;
                  const view = { ...root, isCurrent: () => current && live, async close() { live = false; views.delete(threadId); } };
                  views.set(threadId, view);
                  return view;
                },
                async closeThread(threadId: string) { await views.get(threadId)?.close(); },
              });
            },
          },
        )),
    }),
  );
  return {
    ...storage,
    async close() {
      try {
        await storage.close();
      } finally {
        hands?.close();
      }
    },
    ready: { ...storage.ready, actorId: actor.id, generation: actor.generation },
    methods: {
      ...storage.methods,
      fixtureBeginFork: (threadId: string) => {
        if (!fixtureStore) throw Error("Fixture workspace unavailable");
        fixtureForkLease = fixtureStore.beginThreadFork({ principalId: actor.id, hostId: "local-codex" }, threadId, "fixture-fork").lease;
      },
      fixtureConfirmFork: (threadId: string) => {
        if (!fixtureStore || !fixtureForkLease) throw Error("Fixture fork unavailable");
        fixtureStore.confirmThreadForked({ principalId: actor.id, hostId: "local-codex" }, fixtureForkLease, "fixture-fork", threadId);
      },
      fixtureCounters: () => ({ allocated, deleted, retained: Object.keys(retained).length }),
      fixtureArtifactStats: () => ({ processes: artifactProcesses.size }),
      fixtureTerminalStats: () => ({ active: terminals.size }),
      fixtureBrowserStats: () => ({
        owners: browserOwners.size,
        attached: browserAttached.size,
        commands: browserCommands,
      }),
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
