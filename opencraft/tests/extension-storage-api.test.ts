import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSupervisor, MemoryExtensionPersistence, type TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import type { ExtensionDocumentOptions } from "@opencraft/extension-contract";

async function activate(supervisor: ExtensionSupervisor, id = "test.storage") {
  let api!: TrustedExtensionApiV1;
  await supervisor.activate({ manifest: { manifestVersion: 1, id, name: id, version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate(value) { api = value; } });
  return api;
}

test("plugin storage scopes identity, persists CAS and revokes old activation handles", async () => {
  const backend = new MemoryExtensionPersistence(), supervisor = new ExtensionSupervisor({ platform: "web", persistence: backend });
  try {
    const a = await activate(supervisor), b = await activate(supervisor, "test.other");
    const document = await a.storage!.open("state");
    const initial = await document.read();
    assert.deepEqual(initial.value, {});
    let changes = 0; document.subscribe(() => changes++);
    assert.equal((await document.compareAndSet(initial.revision, { saved: true })).updated, true);
    assert.equal((await document.compareAndSet(initial.revision, { stale: true })).updated, false);
    assert.deepEqual((await (await b.storage!.open("state")).read()).value, {});
    await assert.rejects(a.storage!.open("../other"), /namespace/);
    await supervisor.deactivate("test.storage");
    await assert.rejects(document.read(), /stale/);
    await assert.rejects(document.compareAndSet(2, {}), /stale/);
    const replacement = await activate(supervisor);
    const reopened = await replacement.storage!.open("state");
    assert.deepEqual((await reopened.read()).value, { saved: true });
    await reopened.compareAndSet((await reopened.read()).revision, {});
    assert.equal(changes, 1, "old listeners cannot receive the new activation's changes");
  } finally { await supervisor.dispose(); backend.close(); }
});

test("plugin migrations commit once; changed checksum, failed transform and downgrade preserve data", async () => {
  const backend = new MemoryExtensionPersistence(), supervisor = new ExtensionSupervisor({ platform: "web", persistence: backend });
  try {
    const api = await activate(supervisor);
    const old = await api.storage!.open("migrations", { version: 1, initialValue: { count: 3 } });
    let runs = 0;
    const options: ExtensionDocumentOptions = { version: 2, initialValue: { amount: 0 }, migrations: [{ version: 2, checksum: "a".repeat(64), migrate(value) { runs++; return { amount: (value as { count: number }).count }; } }] };
    const upgraded = await api.storage!.open("migrations", options);
    assert.deepEqual((await upgraded.read()).value, { amount: 3 });
    await api.storage!.open("migrations", options); assert.equal(runs, 1);
    await assert.rejects(old.read(), /newer plugin/);
    await assert.rejects(api.storage!.open("migrations"), /newer plugin/);
    await assert.rejects(api.storage!.open("migrations", { ...options, migrations: [{ ...options.migrations![0]!, checksum: "b".repeat(64) }] }), /checksum/);
    await assert.rejects(api.storage!.open("migrations", { version: 3, initialValue: {}, migrations: [...options.migrations!, { version: 3, checksum: "c".repeat(64), migrate() { throw new Error("synthetic transform failure"); } }] }), /synthetic/);
    assert.deepEqual((await upgraded.read()).value, { amount: 3 });
  } finally { await supervisor.dispose(); backend.close(); }
});

test("plugin-managed Worker cleanup remains a normal subscription; unavailable storage is explicit", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let terminated = false;
  await supervisor.activate({ manifest: { manifestVersion: 1, id: "test.worker", name: "worker", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["onStartupFinished"] }, activate(api) {
    assert.equal(api.storage, null);
    // Same contract as api.subscriptions.add(() => worker.terminate()).
    api.subscriptions.add(() => { terminated = true; });
  } });
  await supervisor.deactivate("test.worker"); assert.equal(terminated, true); await supervisor.dispose();
});

test("Cordis retirement drains an accepted commit without publishing into a retired activation", async () => {
  const memory = new MemoryExtensionPersistence();
  let hold = false, release!: () => void, started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = {
    read: (scope: string) => memory.read(scope),
    subscribe: (listener: (scope: string) => void) => memory.subscribe(listener),
    close: () => memory.close(),
    async compareAndSet(...args: Parameters<typeof memory.compareAndSet>) {
      if (hold) { started(); await gate; }
      return memory.compareAndSet(...args);
    },
  };
  const supervisor = new ExtensionSupervisor({ platform: "web", persistence: backend });
  try {
    const api = await activate(supervisor), document = await api.storage!.open("inflight");
    const revision = (await document.read()).revision;
    let calls = 0; document.subscribe(() => calls++);
    hold = true;
    const saving = assert.rejects(document.compareAndSet(revision, { accepted: true }), /stale/);
    await begun;
    let retired = false;
    const retiring = supervisor.deactivate("test.storage").then(() => { retired = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(retired, false);
    hold = false; release(); await saving; await retiring;
    assert.equal(calls, 0);
    const next = await activate(supervisor);
    assert.deepEqual((await (await next.storage!.open("inflight")).read()).value, { accepted: true });
  } finally { release?.(); await supervisor.dispose(); memory.close(); }
});
