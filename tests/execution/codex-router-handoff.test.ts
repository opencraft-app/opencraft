import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexGenerationRegistry } from "../../apps/codex-core/src/generation-registry.js";
import { CodexRouterOwner, type RouterObservation } from "../../apps/codex-core/src/router-owner.js";
const empty: RouterObservation = { coverage: "complete", activeCount: 0, historicalCount: 3, counts: {} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-router-owner-"));
  let registry = new CodexGenerationRegistry(root), owner = new CodexRouterOwner(registry);
  const input = () => ({ expectedOwner: owner.owner, expectedEpoch: owner.snapshot().epoch, operationId: "operation", fence: "fence" });
  return { root, get registry() { return registry; }, get owner() { return owner; }, input,
    reopen() { registry.close(); registry = new CodexGenerationRegistry(root); owner = new CodexRouterOwner(registry); },
    async close() { registry.close(); await rm(root, { recursive: true, force: true }); } };
}
test("router fence counts accepted admission, rejects new calls, and releases only exact zero proof", async () => {
  const f = await fixture();
  try {
    const done = f.owner.enter(); f.owner.fence(f.input());
    assert.throws(() => f.owner.enter(), /fenced/);
    assert.equal(f.owner.inspect(f.input(), empty).activeCount, 1);
    assert.throws(() => f.owner.release(f.input(), empty, "config"), /drained/);
    done();
    assert.equal(f.owner.inspect(f.input(), { ...empty, counts: { subscriptions: 1 }, activeCount: 1 }).activeCount, 1);
    const proof = f.owner.inspect(f.input(), empty);
    assert.throws(() => f.owner.release({ ...f.input(), proof: "wrong" }, empty, "config"), /proof/);
    f.owner.release({ ...f.input(), proof: proof.identity }, empty, "config");
    assert.throws(() => f.owner.abort(f.input()), /after release/);
    assert.throws(() => new CodexGenerationRegistry(f.root), /locked/);
    f.reopen();
    assert.equal(f.owner.isOpen(), false);
    let reads = 0; const native = async () => { reads++; return ["original-native"]; };
    await assert.rejects(f.owner.coldReady(f.input(), "changed", native), /configuration/);
    const ready = await f.owner.coldReady(f.input(), "config", native);
    const stale = f.input(); f.reopen();
    await assert.rejects(f.owner.resume({ ...stale, identity: ready.identity }, "config", native), /conflict/);
    await assert.rejects(f.owner.resume({ ...f.input(), identity: ready.identity }, "config", native), /incarnation/);
    const recovered = await f.owner.coldReady(f.input(), "config", native);
    await f.owner.resume({ ...f.input(), identity: recovered.identity }, "config", native);
    assert.ok(f.owner.isOpen()); assert.equal(reads, 3);
  } finally { await f.close(); }
});
test("unconfirmed source release, accepted work crash, and connection tool loss fail closed", async () => {
  for (const kind of ["fence", "admission", "tool"] as const) {
    const f = await fixture();
    try {
      if (kind === "fence") f.owner.fence(f.input());
      if (kind === "admission") f.owner.enter();
      if (kind === "tool") f.owner.uncertain();
      assert.throws(() => f.reopen(), /unconfirmed/);
    } finally { await f.close(); }
  }
});
test("registry changes invalidate release and cold readiness; unknown coverage cannot mint idle", async () => {
  const f = await fixture();
  try {
    f.owner.fence(f.input());
    assert.equal(f.owner.inspect(f.input(), { ...empty, coverage: "unknown" }).activeCount, null);
    assert.throws(() => f.owner.release(f.input(), empty, "config"), /drained/);
    const proof = f.owner.inspect(f.input(), empty); f.registry.setMetadata("changed", 1);
    assert.throws(() => f.owner.release({ ...f.input(), proof: proof.identity }, empty, "config"), /changed/);
    const next = f.owner.inspect(f.input(), empty); f.owner.release({ ...f.input(), proof: next.identity }, empty, "config");
    f.reopen(); f.registry.setMetadata("changed", 2);
    await assert.rejects(f.owner.coldReady(f.input(), "config", async () => []), /registry/);
  } finally { await f.close(); }
});

test("completed spawn admission retains a durable tool lease across source crash", async () => {
  const f = await fixture();
  try {
    const call = f.owner.enter(), tool = f.owner.retainConnectionTool(); call();
    f.owner.fence(f.input()); assert.equal(f.owner.inspect(f.input(), empty).activeCount, 1);
    tool(); const proof = f.owner.inspect(f.input(), empty); assert.equal(proof.activeCount, 0);
    f.owner.abort(f.input());
    const again = f.owner.enter(); f.owner.retainConnectionTool(); again();
    assert.throws(() => f.reopen(), /unconfirmed/);
  } finally { await f.close(); }
});
