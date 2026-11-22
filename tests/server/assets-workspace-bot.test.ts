import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerOwner } from "@opencraft/worker-owner";
import { SandboxConfigurationError } from "@opencraft/plugin-assets/server/configurations";
import type { AssetStoragePort } from "@opencraft/plugin-assets/server";
import type { WorkspaceBotPort } from "../../apps/headless-server/src/workspaces/bot-owner.js";
import { createWorkspaceBotProvider } from "../../apps/headless-server/src/workspaces/bot-client.js";
import type { spawnAssistant } from "@opencraft/personal-assistant/host";
type Port = WorkspaceBotPort &
  AssetStoragePort & {
    fixtureStats(): Promise<{ allocated: number; deleted: number; commands: number; threadId: number }>;
    fixtureLose(): Promise<void>;
    fixtureFailCleanup(): Promise<void>;
    fixtureUnknownCreate(): Promise<void>;
  };
const environment = { kind: "sandbox" as const, backendId: "e2b", templateId: "synthetic" };
const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const delay = () => new Promise((r) => setTimeout(r, 10));
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-bot-"));
  let owner: Awaited<ReturnType<typeof WorkerOwner.open<Port>>>["owner"];
  const open = async () => {
    ({ owner } = await WorkerOwner.open<Port>(new URL("../fixtures/assets-bot.worker.ts", import.meta.url), {
      name: "Synthetic Bot vault owner",
      workerData: { directory },
      errors: [SandboxConfigurationError],
    }));
  };
  await open();
  let closed = false;
  const clients: ReturnType<typeof createWorkspaceBotProvider>[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    if (!closed) await owner.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const brains: Parameters<typeof spawnAssistant>[0][] = [],
    brainClosed: { value: number } = { value: 0 };
  const client = () => {
    const value = createWorkspaceBotProvider({
      port: owner.call,
      onCleanupUnconfirmed() {},
      spawnLocal: (options) => {
        brains.push(options);
        return {
          ready: Promise.resolve(null),
          failed: () => false,
          close: async () => {
            brainClosed.value++;
          },
        };
      },
    });
    clients.push(value);
    return value;
  };
  const source = (botId = "bot-a") => ({
    directory: "/private/main/brain",
    profileOptions: { apiKey: "synthetic-brain-key" },
    request: async (method: string) => {
      assert.equal(method, "opencraft/personal-assistant/authorize");
      return {
        binding: {
          serverId: "server:synthetic",
          botId,
          assignmentId: "assignment-a",
          owner: { kind: "human", id: "human://local/test" },
        },
        epoch: "epoch-1",
        expiresAt: Date.now() + 60000,
      };
    },
  });
  return {
    get port() {
      return owner.call;
    },
    client,
    brains,
    brainClosed,
    source,
    async restart() {
      await owner.close().catch(() => {});
      closed = true;
      await open();
      closed = false;
    },
  };
}
const run = (brain: Parameters<typeof spawnAssistant>[0], id = "call-a") =>
  brain.request("environment/run", { argv: ["echo", "fixture"], workId: "work-a", callId: id, timeoutMs: 1000 });

test("Bot brain remains Main-owned while Worker canonical provider shares ordinary budget and does not provision on catalog/open", async (t) => {
  const f = await fixture(t),
    client = f.client();
  assert.deepEqual(await client.templates(), [{ id: "synthetic", name: "Synthetic" }]);
  const h = await client.spawn(environment, f.source());
  await h.ready;
  assert.equal((await f.port.fixtureStats()).allocated, 0);
  assert.equal(f.brains[0]!.profileOptions.apiKey, "synthetic-brain-key");
  assert.equal(f.brains[0]!.directory, "/private/main/brain");
  assert.equal((await run(f.brains[0]!)).state, "completed");
  const stats = await f.port.fixtureStats();
  assert.equal(stats.allocated, 1);
  assert.equal(stats.commands, 2);
  assert.ok(stats.threadId > 0);
  const identity = { id: "ordinary", owner: "ordinary-owner", backend: "e2b" };
  await assert.rejects(f.port.workspaceBudgetReserve("ordinary", identity, resources));
  await h.close();
  assert.equal(f.brainClosed.value, 1);
  assert.equal((await f.port.fixtureStats()).deleted, 1);
  const key = await f.port.workspaceBudgetReserve("ordinary", identity, resources);
  await f.port.workspaceBudgetSettle(key, "not-created");
  const serialized = JSON.stringify(await f.port.workspaceBotCatalog());
  for (const secret of ["synthetic-bot-only-key", "synthetic-brain-key", "https://api.e2b.dev", "/private/main"])
    assert.ok(!serialized.includes(secret));
});

test("Bot source assignment is reauthorized; swapped epochs and provider loss cannot publish another physical command", async (t) => {
  const f = await fixture(t),
    client = f.client(),
    original = f.source();
  let revoked = false;
  const h = await client.spawn(environment, {
    ...original,
    request: async (method, _params) => {
      const a = await original.request(method);
      return { ...a, epoch: revoked ? "epoch-2" : a.epoch };
    },
  });
  assert.equal((await run(f.brains[0]!)).state, "completed");
  const commands = (await f.port.fixtureStats()).commands;
  revoked = true;
  await assert.rejects(run(f.brains[0]!, "call-b"));
  assert.equal((await f.port.fixtureStats()).commands, commands);
  await h.close();
  const next = await client.spawn(environment, f.source("bot-b"));
  await run(f.brains[1]!);
  await f.port.fixtureLose();
  for (let i = 0; i < 100 && !next.failed(); i++) await delay();
  assert.equal(next.failed(), true);
  await assert.rejects(run(f.brains[1]!, "call-c"));
  await next.close();
});

test("uncertain Bot creation stays charged after replacing the sole Worker and denies ordinary allocation", async (t) => {
  const f = await fixture(t),
    client = f.client();
  const h = await client.spawn(environment, f.source());
  await f.port.fixtureUnknownCreate();
  assert.equal((await run(f.brains[0]!)).state, "rejected");
  await assert.rejects(h.close());
  await client.close().catch(() => {});
  await f.restart();
  await assert.rejects(
    f.port.workspaceBudgetReserve("ordinary", { id: "next", owner: "next-owner", backend: "e2b" }, resources),
  );
  assert.equal((await f.port.fixtureStats()).allocated, 0);
});

test("a hung original Bot authorization cannot block configuration FIFO or resource retirement", async (t) => {
  const f = await fixture(t),
    client = f.client();
  const spawning = client.spawn(environment, { ...f.source(), request: () => new Promise(() => {}) });
  await delay();
  await delay();
  assert.deepEqual(await client.templates(), [{ id: "synthetic", name: "Synthetic" }]);
  await client.close();
  await assert.rejects(spawning);
  assert.equal((await f.port.fixtureStats()).allocated, 0);
});

test("ordinary reservations block Bot provisioning, and unknown Bot deletion remains charged across replacement", async (t) => {
  const f = await fixture(t),
    client = f.client();
  const key = await f.port.workspaceBudgetReserve(
    "ordinary",
    { id: "ordinary-active", owner: "ordinary-owner", backend: "e2b" },
    resources,
  );
  const first = await client.spawn(environment, f.source());
  assert.equal((await run(f.brains[0]!)).state, "rejected");
  assert.equal((await f.port.fixtureStats()).allocated, 0);
  await first.close();
  await f.port.workspaceBudgetSettle(key, "not-created");
  const second = await client.spawn(environment, f.source("bot-b"));
  assert.equal((await run(f.brains[1]!)).state, "completed");
  await f.port.fixtureFailCleanup();
  await assert.rejects(second.close());
  await client.close().catch(() => {});
  await f.restart();
  await assert.rejects(
    f.port.workspaceBudgetReserve("ordinary", { id: "after-loss", owner: "ordinary-owner", backend: "e2b" }, resources),
  );
});
