import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxCreationFault, type SandboxBackend } from "@opencraft/sandbox";
import { openAssetConfigurations } from "@opencraft/plugin-assets/server";
import { WorkspaceBudgetStore, withWorkspaceBudget } from "@opencraft/plugin-assets/server/workspace-budget";
const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
  signal = new AbortController().signal;
const identity = (id: string) => ({ id, owner: "synthetic-owner", backend: "e2b" });
const backend = (create: SandboxBackend["create"]): SandboxBackend => ({
  id: "e2b",
  async initialize() {},
  async close() {},
  create,
});
const environment = () => ({
  resources,
  capabilities: { terminal: true },
  async spawn(): Promise<never> {
    throw Error("unused");
  },
  async close() {},
});
const deferred = () => Promise.withResolvers<void>();
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "assets-budget-"));
  const open = () =>
    openAssetConfigurations(directory, {
      entry: new URL("../fixtures/assets-workspace-budget.worker.ts", import.meta.url),
    });
  let owner = await open();
  t.after(async () => {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get port() {
      return owner.store;
    },
    async reopen() {
      await owner.close();
      owner = await open();
    },
  };
}

test("the sole Assets Worker reserves shared Bot/conversation capacity before provider creation", async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    gate = deferred();
  let creates = 0;
  const provider = backend(async () => {
    creates++;
    entered.resolve();
    await gate.promise;
    return environment();
  });
  const creating = withWorkspaceBudget(f.port, "bot", provider).create(identity("first"), resources, signal);
  await entered.promise;
  await assert.rejects(
    withWorkspaceBudget(f.port, "ordinary", provider).create(identity("other"), resources, signal),
    (e) => e instanceof SandboxCreationFault && e.outcome === "not-created",
  );
  assert.equal(creates, 1);
  gate.resolve();
  const first = await creating;
  await first.close();
  const next = await withWorkspaceBudget(f.port, "ordinary", provider).create(identity("other"), resources, signal);
  assert.equal(creates, 2);
  await next.close();
});

test("unknown provider creation survives Worker restart without replay or capacity release", async (t) => {
  const f = await fixture(t),
    wrapped = withWorkspaceBudget(
      f.port,
      "bot",
      backend(async () => {
        throw Error("synthetic lost create response");
      }),
    );
  await assert.rejects(wrapped.create(identity("unknown"), resources, signal));
  await wrapped.close();
  await f.reopen();
  let called = false;
  await assert.rejects(
    withWorkspaceBudget(
      f.port,
      "ordinary",
      backend(async () => {
        called = true;
        return environment();
      }),
    ).create(identity("next"), resources, signal),
  );
  assert.equal(called, false);
});

test("confirmed non-creation frees the reservation but a failed deletion stays charged after restart", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    withWorkspaceBudget(
      f.port,
      "ordinary",
      backend(async () => {
        throw new SandboxCreationFault("not-created");
      }),
    ).create(identity("rejected"), resources, signal),
  );
  const first = await withWorkspaceBudget(
    f.port,
    "bot",
    backend(async () => ({
      ...environment(),
      async close() {
        throw Error("synthetic delete unknown");
      },
    })),
  ).create(identity("retained"), resources, signal);
  await assert.rejects(first.close());
  await assert.rejects(first.close());
  await f.reopen();
  await assert.rejects(f.port.workspaceBudgetReserve("ordinary", identity("next"), resources));
});

test("capacity returns only after confirmed close; repeated close settles once", async (t) => {
  const f = await fixture(t),
    gate = deferred();
  let closes = 0;
  const first = await withWorkspaceBudget(
    f.port,
    "ordinary",
    backend(async () => ({
      ...environment(),
      async close() {
        closes++;
        await gate.promise;
      },
    })),
  ).create(identity("first"), resources, signal);
  const closing = first.close();
  assert.equal(first.close(), closing);
  await assert.rejects(f.port.workspaceBudgetReserve("bot", identity("second"), resources));
  gate.resolve();
  await closing;
  assert.equal(closes, 1);
  const receipt = await f.port.workspaceBudgetReserve("bot", identity("second"), resources);
  await f.port.workspaceBudgetSettle(receipt, "not-created");
});

test("late settlement cannot release a reused logical sandbox identity", async (t) => {
  const f = await fixture(t),
    first = await f.port.workspaceBudgetReserve("ordinary", identity("reused"), resources);
  await f.port.workspaceBudgetSettle(first, "destroyed");
  const second = await f.port.workspaceBudgetReserve("ordinary", identity("reused"), resources);
  assert.notEqual(second, first);
  await assert.rejects(f.port.workspaceBudgetSettle(first, "destroyed"));
  await assert.rejects(f.port.workspaceBudgetReserve("bot", identity("other"), resources));
  await f.port.workspaceBudgetSettle(second, "destroyed");
});

test("pre-aborted creation does not reserve; cancellation after reservation never calls a provider", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = backend(async () => {
    calls++;
    return environment();
  });
  await assert.rejects(
    withWorkspaceBudget(f.port, "bot", provider).create(identity("pre-aborted"), resources, controller.signal),
  );
  const abort = new AbortController();
  const port = {
    ...f.port,
    async workspaceBudgetReserve(...args: Parameters<typeof f.port.workspaceBudgetReserve>) {
      const receipt = await f.port.workspaceBudgetReserve(...args);
      abort.abort();
      return receipt;
    },
    workspaceBudgetSettle: f.port.workspaceBudgetSettle,
  };
  await assert.rejects(
    withWorkspaceBudget(port, "ordinary", provider).create(identity("cancelled"), resources, abort.signal),
  );
  assert.equal(calls, 0);
  const receipt = await f.port.workspaceBudgetReserve("bot", identity("available"), resources);
  await f.port.workspaceBudgetSettle(receipt, "not-created");
});

test("invalid budgets and unconfigured installations cannot allocate or guess a reservation receipt", async (t) => {
  const f = await fixture(t);
  for (const budget of [
    { cpuMillis: 0, memoryBytes: 1 },
    { cpuMillis: 1, memoryBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...resources, extra: 1 },
  ])
    await assert.rejects(f.port.workspaceBudgetReserve("ordinary", identity("invalid"), budget));
  await assert.rejects(f.port.workspaceBudgetSettle("0".repeat(64), "destroyed"));
  const directory = await mkdtemp(join(tmpdir(), "assets-budget-unconfigured-")),
    unconfigured = await openAssetConfigurations(directory);
  try {
    await assert.rejects(unconfigured.store.workspaceBudgetReserve("ordinary", identity("unconfigured"), resources));
  } finally {
    await unconfigured.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost committed reservation acknowledgement never invokes or replays the provider", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const port = {
    workspaceBudgetSettle: f.port.workspaceBudgetSettle,
    async workspaceBudgetReserve(...args: Parameters<typeof f.port.workspaceBudgetReserve>): Promise<string> {
      await f.port.workspaceBudgetReserve(...args);
      throw Error("synthetic lost reservation acknowledgement");
    },
  };
  const wrapped = withWorkspaceBudget(
    port,
    "ordinary",
    backend(async () => {
      calls++;
      return environment();
    }),
  );
  await assert.rejects(wrapped.create(identity("uncertain-admission"), resources, signal));
  assert.equal(calls, 0);
  await f.reopen();
  await assert.rejects(f.port.workspaceBudgetReserve("bot", identity("other"), resources));
});

test("legacy reservations remain charged and cannot be released using only a reusable identity hash", async () => {
  const { createHash } = await import("node:crypto");
  const original = identity("legacy"),
    key = createHash("sha256")
      .update(JSON.stringify(["ordinary", original.backend, original.owner, original.id]))
      .digest("hex");
  const document = {
    version: 1,
    reservations: [{ key, role: "ordinary", identity: original, resources, state: "uncertain" }],
  };
  let writes = 0;
  const store = new WorkspaceBudgetStore(
    {
      readDocument() {
        return { revision: 1, document };
      },
      writeDocument() {
        writes++;
        return 2;
      },
    },
    () => resources,
  );
  assert.throws(() => store.reserve("bot", identity("new"), resources));
  assert.throws(() => store.settle(key, "destroyed"));
  assert.throws(() => store.settle(key + "." + "0".repeat(32), "destroyed"));
  assert.equal(writes, 0);
});
