import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityBindings, type CapabilityBindingWrite } from "@opencraft/session-capabilities/bindings";
import { CapabilityBindingProjection } from "@opencraft/session-capabilities/binding-projection";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";

const a = { serverId: "server-a", threadId: "thread-a" };
const b = { serverId: "server-a", threadId: "thread-b" };
const run = { ...b, execution: { executionId: "exec-1", inputId: "input-1" } };

async function storeIn(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "capability-projection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CapabilityBindings(join(directory, "bindings.sqlite"));
  t.after(() => store.close());
  return store;
}

test("the projection reads what the store holds and commits writes the store accepts, in order", async (t) => {
  const store = await storeIn(t);
  store.bind("binding-a", a);
  const writes: CapabilityBindingWrite[] = [];
  const projection = new CapabilityBindingProjection(store.snapshot(), async (write) => {
    writes.push(write);
    store.apply(write);
  });
  assert.deepEqual(projection.get("binding-a"), a);
  assert.equal(projection.id(a), "binding-a");

  projection.prepareExecution("exec-binding", b);
  projection.bindExecution("exec-binding", run);
  projection.bind("binding-b", b);
  assert.deepEqual(projection.execution("exec-binding"), { scope: b, session: run }, "visible before the commit");
  await projection.flush();
  assert.deepEqual(
    writes.map((write) => write[0]),
    ["prepareExecution", "bindExecution", "bind"],
  );
  for (const reader of [store, projection]) {
    assert.deepEqual(reader.execution("exec-binding"), { scope: b, session: run });
    assert.equal(reader.executionId(b), "exec-binding");
    assert.equal(reader.id(b), "binding-b");
  }

  projection.removeExecution("exec-binding");
  await projection.flush();
  assert.equal(projection.execution("exec-binding"), null);
  assert.equal(store.execution("exec-binding"), null);
  assert.equal(store.executionId(b), null);
});

test("the projection refuses the writes the table would refuse, before anything is committed", async (t) => {
  const store = await storeIn(t);
  const writes: CapabilityBindingWrite[] = [];
  const projection = new CapabilityBindingProjection(store.snapshot(), async (write) => {
    writes.push(write);
    store.apply(write);
  });
  projection.bind("binding-a", a);
  assert.throws(() => projection.bind("binding-a", b), /already exists/);
  assert.throws(() => projection.bind("other", a), /already exists/);
  projection.prepareExecution("exec-binding", b);
  assert.throws(() => projection.prepareExecution("other", b), /already exists/);
  assert.throws(() => projection.bindExecution("exec-binding", { ...a, execution: run.execution }), /changed/);
  assert.throws(() => projection.bindExecution("missing", run), /changed/);
  projection.bindExecution("exec-binding", run);
  assert.throws(
    () => projection.bindExecution("exec-binding", { ...run, execution: { ...run.execution, inputId: "input-2" } }),
    /changed/,
  );
  await projection.flush();
  assert.equal(writes.length, 3, "refused writes never reached the owner");
});

test("a failed commit fails every credential closed instead of serving a projection storage lacks", async () => {
  const failures: Error[] = [];
  let reject = false;
  const projection = new CapabilityBindingProjection(
    { bindings: [["binding-a", a.serverId, a.threadId]], executions: [] },
    async () => {
      if (reject) throw new Error("disk full");
    },
    (error) => failures.push(error),
  );
  projection.prepareExecution("exec-binding", b);
  await projection.flush();
  reject = true;
  projection.bindExecution("exec-binding", run);
  await assert.rejects(projection.flush(), /disk full/);
  assert.equal(projection.get("binding-a"), null);
  assert.equal(projection.id(a), null);
  assert.equal(projection.execution("exec-binding"), null);
  assert.equal(projection.executionId(b), null);
  assert.throws(() => projection.bind("binding-b", b), /unavailable/);
  assert.equal(failures.length, 1);
});

test("bindings written through the Headless owner Worker survive a restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capability-projection-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = new URL("../../apps/headless-server/src/server-core-worker.mjs", import.meta.url);
  type Owner = {
    capabilityBindings(): ReturnType<CapabilityBindings["snapshot"]>;
    applyCapabilityBinding(write: CapabilityBindingWrite): void;
  };
  const open = async () => {
    const storage = await openServerCoreOwner<Owner>(directory, { entry });
    const projection = new CapabilityBindingProjection(await storage.call.capabilityBindings(), (write) =>
      storage.call.applyCapabilityBinding(write),
    );
    return { storage, projection };
  };
  let { storage, projection } = await open();
  projection.bind("binding-a", a);
  projection.prepareExecution("exec-binding", b);
  projection.bindExecution("exec-binding", run);
  await projection.close();
  await storage.close();

  ({ storage, projection } = await open());
  try {
    assert.deepEqual(projection.get("binding-a"), a);
    assert.deepEqual(projection.execution("exec-binding"), { scope: b, session: run });
  } finally {
    await projection.close();
    await storage.close();
  }
});
