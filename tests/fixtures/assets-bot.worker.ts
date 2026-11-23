import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import { WorkspaceBotOwner } from "../../apps/headless-server/src/workspaces/bot-owner.js";
import { SandboxCreationFault } from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import { threadId } from "node:worker_threads";
const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
serveWorkerOwner<{ directory: string }>(async ({ directory }) => {
  let allocated = 0,
    deleted = 0,
    commands = 0,
    failCleanup = false,
    lost: () => void = () => {},
    unknownCreate = false;
  const storage = await createAssetsStorage(directory, [], undefined, (context) => {
    if (!context.configurations.hasInstallation())
      context.configurations.adoptInstallation(
        {
          backend: "e2b",
          apiUrl: "https://api.e2b.dev",
          sandboxUrl: "https://e2b.dev",
          capacity: resources,
          templates: [{ id: "synthetic", name: "Synthetic", resources, workspaceRoot: "/workspace" }],
          lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
          persistentWorkspaces: true,
        },
        "synthetic-bot-only-key",
      );
    // Synthetic provider registered under the installation's backend; no vendor SDK.
    const providers = createSandboxProviderRegistry<{ backend: "e2b"; apiUrl: string; sandboxUrl: string }>({
      e2b: {
        id: "e2b",
        createBackend: ({ lease }) => {
          const callbacks = lease!;
          return {
            id: "e2b",
            initialize: async () => {},
            close: async () => {},
            create: async (identity, resources, signal) => {
              signal.throwIfAborted();
              await callbacks.authorize(identity);
              if (unknownCreate) throw new SandboxCreationFault("unknown", identity);
              allocated++;
              lost = () => callbacks.onLost(identity);
              let closed = false;
              return {
                resources,
                capabilities: { terminal: false },
                spawn: async (command, onOutput) => {
                  commands++;
                  onOutput?.({ stream: "stdout", data: Buffer.from("synthetic-output") });
                  return {
                    id: "p-" + commands,
                    kind: "process",
                    writeStdin: async () => {},
                    closeStdin: async () => {},
                    terminate: async () => {},
                    exited: Promise.resolve({ code: 0 }),
                  };
                },
                close: async () => {
                  if (failCleanup) throw Error("Synthetic cleanup failure");
                  if (!closed) {
                    closed = true;
                    deleted++;
                  }
                },
              };
            },
          };
        },
        // The installation enables persistent workspaces; Bot paths never call these.
        persistentWorkspaces: {
          receipt: async () => {
            throw Error("Synthetic Bot provider has no workspace receipt");
          },
          inspect: async () => "unknown",
          verifyMounts: async () => {
            throw Error("Synthetic Bot provider has no mounts");
          },
        },
      },
    });
    const owner = new WorkspaceBotOwner(context, { providers });
    return { methods: owner.methods as never, close: () => owner.close() };
  });
  return {
    ...storage,
    methods: {
      ...storage.methods,
      fixtureStats: async () => ({ allocated, deleted, commands, threadId }),
      fixtureLose: async () => lost(),
      fixtureFailCleanup: async () => {
        failCleanup = true;
      },
      fixtureUnknownCreate: async () => {
        unknownCreate = true;
      },
    },
  };
});
