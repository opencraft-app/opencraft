import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexGenerationRegistry } from "../../apps/codex-core/src/generation-registry.js";
import { CodexRouterOwner } from "../../apps/codex-core/src/router-owner.js";
import { routerDigest } from "../../apps/codex-core/src/router-maintenance.js";
import { GenerationRegistryWorker } from "../../apps/codex-core/src/generation-registry-worker.js";

test("Worker committed history revisions invalidate the owner cache without unrelated lease writes doing so", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-worker-history-"));
  const registry = await GenerationRegistryWorker.open(root);
  let owner: CodexRouterOwner | undefined;
  try {
    const archive = { version: 1, receipt: { source: { owner: "prior" }, sourceHandoff: { pending: [], uncertain: false }, padding: "x".repeat(1024 * 1024) } };
    const id = routerDigest(archive), key = `router-history:${id}`;
    await registry.setMetadata(key, archive);
    await registry.setMetadata("router-handoff", { version: 1, epoch: 1, phase: "released", operationId: "test", fence: "test", sourceOwner: "prior",
      uncertain: false, history: [id], configuration: "test", sealed: routerDigest(await registry.coldSnapshot()) });
    owner = new CodexRouterOwner(registry); await owner.ready;
    const revision = registry.routerHistoryRevision();
    const digest = owner.snapshot().historicalUnknownSha256;
    await registry.setMetadata("router-lease:fixture", { phase: "accepted" });
    assert.equal(registry.routerHistoryRevision(), revision);
    assert.equal(owner.snapshot().historicalUnknownSha256, digest);
    await registry.setMetadata(key, { ...archive, version: 2 });
    assert.notEqual(registry.routerHistoryRevision(), revision);
    assert.throws(() => owner!.snapshot(), /responsibility changed/);
    await registry.setMetadata(key, archive);
    assert.equal(owner.snapshot().historicalUnknownSha256, digest);
    await registry.updateMetadata({}, [key]);
    assert.throws(() => owner!.snapshot(), /responsibility changed/);
  } finally { await owner?.dispose(); await registry.close(); rmSync(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oc-history-projection-"));
  const registry = new CodexGenerationRegistry(root);
  const archive = { version: 1, receipt: { source: { owner: "prior" }, sourceHandoff: { pending: [], uncertain: false }, padding: "x".repeat(1024 * 1024) } };
  const id = routerDigest(archive), key = `router-history:${id}`;
  registry.setMetadata(key, archive);
  registry.setMetadata("router-handoff", { version: 1, epoch: 1, phase: "released", operationId: "test", fence: "test", sourceOwner: "prior",
    uncertain: false, history: [id], configuration: "test", sealed: routerDigest(registry.coldSnapshot()) });
  const owner = new CodexRouterOwner(registry); await owner.ready;
  return { registry, owner, root, archive, id, key, async close() { await owner.dispose(); registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("history reads reuse verified archives across lease writes and isolate snapshot consumers", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const read = f.registry.metadata.bind(f.registry);
    f.registry.metadata = key => { if (key.startsWith("router-history:")) reads++; return read(key); };
    const expected = routerDigest([{ id: f.id, value: f.archive }]);
    for (let i = 0; i < 20; i++) {
      f.registry.setMetadata("router-lease:fixture", { i });
      const snapshot = f.owner.snapshot();
      assert.equal(snapshot.historicalUnknownSha256, expected);
      snapshot.historicalUnknownSnapshots[0]!.source.owner = "caller mutation";
      assert.equal(f.owner.snapshot().historicalUnknownSnapshots[0]!.source.owner, "prior");
    }
    assert.equal(reads, 0, "status polling must not parse the archived payload again");
  } finally { await f.close(); }
});

test("archive mutation and deletion invalidate projections and fail closed", async () => {
  const f = await fixture();
  try {
    f.registry.setMetadata(f.key, { ...f.archive, version: 2 });
    assert.throws(() => f.owner.snapshot(), /responsibility changed/);
    f.registry.setMetadata(f.key, f.archive);
    assert.equal(f.owner.snapshot().historicalUnknownSnapshots.length, 1);
    f.registry.updateMetadata({}, [f.key]);
    assert.throws(() => f.owner.snapshot(), /responsibility changed/);
  } finally { await f.close(); }
});

test("rollback invalidates a projection populated inside the transaction", async () => {
  const f = await fixture();
  try {
    f.registry.setMetadata(f.key, { version: 2 });
    assert.throws(() => f.registry.metadataTransaction(() => {
      f.registry.setMetadata(f.key, f.archive);
      f.owner.snapshot();
      throw Error("rollback fixture");
    }), /rollback fixture/);
    assert.throws(() => f.owner.snapshot(), /responsibility changed/);
  } finally { await f.close(); }
});

test("identical metadata does not grow WAL while changed metadata remains durable", async () => {
  const f = await fixture();
  try {
    f.registry.setMetadata("fixture", { value: 1 });
    const before = statSync(join(f.root, "codex-generations.sqlite-wal")).size;
    for (let i = 0; i < 50; i++) f.registry.updateMetadata({ fixture: { value: 1 } });
    assert.equal(statSync(join(f.root, "codex-generations.sqlite-wal")).size, before);
    f.registry.updateMetadata({ fixture: { value: 2 } });
    assert.deepEqual(f.registry.metadata("fixture"), { value: 2 });
    assert.ok(statSync(join(f.root, "codex-generations.sqlite-wal")).size > before);
  } finally { await f.close(); }
});

test("out-of-owner SQLite changes cannot bypass historical verification", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture();
  const external = new DatabaseSync(join(f.root, "codex-generations.sqlite"));
  try {
    f.owner.snapshot();
    external.prepare("UPDATE routing_metadata SET value=? WHERE key=?").run(JSON.stringify({ version: 2 }), f.key);
    assert.throws(() => f.owner.snapshot(), /responsibility changed/);
  } finally { external.close(); await f.close(); }
});

test("duplicate lease context avoids transactions but new attribution is durable before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-lease-projection-"));
  const registry = new CodexGenerationRegistry(root), owner = new CodexRouterOwner(registry); await owner.ready;
  try {
    const lease = await owner.enter(false, { method: "thread/read" });
    let writes = 0;
    const update = registry.updateMetadata.bind(registry);
    registry.updateMetadata = (...args) => { writes++; update(...args); };
    await lease.update({ method: "thread/read" });
    await lease.update({});
    assert.equal(writes, 0);
    await lease.update({ nativeRequestId: "request-1" });
    assert.equal(writes, 1);
    assert.equal((registry.metadata(`router-lease:${lease.id}`) as { nativeRequestId: string }).nativeRequestId, "request-1");
    await lease.sent(); await lease();
    assert.equal(writes, 3);
    assert.equal(owner.snapshot().activeCalls, 0);
  } finally { await owner.dispose(); registry.close(); rmSync(root, { recursive: true, force: true }); }
});
