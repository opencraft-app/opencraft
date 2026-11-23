import { serveWorkerOwner } from "@opencraft/worker-owner/serve";
import { SandboxCreationFault } from "@opencraft/sandbox";
import { threadId } from "node:worker_threads";
import { createHeadlessAssetsStorage } from "../../apps/headless-server/src/assets-runtime-storage.js";

/** Core's own vault Worker composition with a synthetic E2B backend. The
 * optional legacy partition stands in for a composition-compiled hook. */
serveWorkerOwner<{ directory: string; legacyPartition?: Record<string, string> }>(
  async ({ directory, legacyPartition }) => {
    let allocated = 0,
      deleted = 0,
      commands = 0,
      unknown = false;
    const keys: string[] = [];
    const storage = await createHeadlessAssetsStorage(directory, [], undefined, {
      ...(legacyPartition
        ? {
            botBackendIdentity: (_record, actor) => {
              const partition = legacyPartition[actor.actorId];
              if (!partition) throw Error("No legacy partition");
              return partition;
            },
          }
        : {}),
      botBackend: (input) => ({
        id: "e2b",
        initialize: async () => {},
        close: async () => {},
        create: async (identity, resources, signal) => {
          signal.throwIfAborted();
          await input.lease!.authorize(identity);
          keys.push(await input.readApiKey());
          if (unknown) throw new SandboxCreationFault("unknown", identity);
          allocated++;
          let closed = false;
          return {
            resources,
            capabilities: { terminal: false },
            spawn: async (_command, onOutput) => {
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
              if (!closed) {
                closed = true;
                deleted++;
              }
            },
          };
        },
      }),
    });
    return {
      ...storage,
      methods: {
        ...storage.methods,
        fixtureStats: async () => ({ allocated, deleted, commands, keys: [...keys], threadId }),
        fixtureUnknownCreate: async () => {
          unknown = true;
        },
      },
    };
  },
);
