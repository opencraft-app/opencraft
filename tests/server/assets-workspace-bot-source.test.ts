import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import type { AssetWorkspaceOwnerContext } from "@opencraft/plugin-assets/server/workspace-owner";
import { createSandboxAssistantProvider } from "@opencraft/personal-assistant/sandbox";
import { WorkspaceBotOwner } from "../../apps/headless-server/src/workspaces/bot-owner.js";

const environment = { kind: "sandbox" as const, backendId: "compiled-cloud", templateId: "worker-template" };
const resources = { cpuMillis: 2000, memoryBytes: 2 * 1024 ** 3 };
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "bot-compiled-source-"));
  let context: AssetWorkspaceOwnerContext | undefined;
  const storage = await createAssetsStorage(directory, [], undefined, (owned) => {
    context = owned;
    return { methods: {}, async close() {} };
  });
  assert.ok(context);
  let revision = "version-1",
    allocated = 0,
    closed = 0;
  const owner = new WorkspaceBotOwner(context, {
    source: {
      catalog: () => ({ revision, templates: [{ id: environment.templateId, name: "Compiled" }] }),
      validate: (expected, input) => {
        if (expected !== revision || JSON.stringify(input) !== JSON.stringify(environment))
          throw Error("Invalid source");
      },
      createProvider: async (_expected, spawnLocal) =>
        createSandboxAssistantProvider({
          backendId: environment.backendId,
          templates: [{ id: environment.templateId, name: "Compiled", resources, workspaceRoot: "/workspace" }],
          capacity: resources,
          spawnLocal,
          createBackend: () => ({
            id: environment.backendId,
            initialize: async () => {},
            close: async () => {},
            create: async () => {
              allocated++;
              throw Error("No physical call in this test");
            },
          }),
        }).then((provider) => ({
          ...provider,
          close: async () => {
            closed++;
            await provider.close();
          },
        })),
    },
  });
  t.after(async () => {
    await owner.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const authorize = async () => {
    for (let i = 0; i < 100; i++) {
      const page = owner.callbackPage();
      if (page.length) return page[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Missing original assignment callback");
  };
  const reply = (token: string) =>
    owner.reply(token, {
      result: {
        binding: {
          serverId: "server:fixture",
          botId: "bot",
          assignmentId: "assignment",
          owner: { kind: "human", id: "human://fixture/user" },
        },
        epoch: "epoch-1",
        expiresAt: Date.now() + 60000,
      },
    });
  return {
    owner,
    authorize,
    reply,
    replace: () => {
      revision = "version-2";
    },
    stats: () => ({ allocated, closed }),
  };
}

test("compiled Bot source preserves its backend ID while the common mailbox retains assignment authorization and ownership", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.owner.validate("version-1", { ...environment, backendId: "uncompiled" }));
  const token = f.owner.open("version-1", environment);
  assert.equal(f.owner.status(token).state, "starting");
  const request = await f.authorize();
  f.reply(request.token);
  for (let i = 0; i < 100 && f.owner.status(token).state === "starting"; i++)
    await new Promise((r) => setTimeout(r, 5));
  const status = f.owner.status(token);
  assert.equal(status.state, "ready");
  if (status.state === "ready") assert.equal(status.descriptor.backendId, "compiled-cloud");
  assert.equal(f.stats().allocated, 0);
  await f.owner.close();
  assert.equal(f.stats().closed, 1);
});

test("a replaced compiled source refuses a late positive assignment reply without publishing a ready lease", async (t) => {
  const f = await fixture(t),
    token = f.owner.open("version-1", environment);
  const request = await f.authorize();
  f.replace();
  f.reply(request.token);
  for (let i = 0; i < 100 && f.owner.status(token).state === "starting"; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.owner.status(token).state, "failed");
  assert.equal(f.stats().allocated, 0);
});
