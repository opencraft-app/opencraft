import { operatorLeaseClaim } from "../../scripts/full-upgrade/operator-lease.mjs";
const operatorLease = await operatorLeaseClaim(30000);
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
  await owner.ready;
  const input = () => ({ operatorLease, expectedOwner: owner.owner, expectedEpoch: owner.snapshot().epoch, operationId: "operation", fence: "fence" });
  return { root, get registry() { return registry; }, get owner() { return owner; }, input,
    async reopen() { await owner.dispose(); await owner.drain().catch(() => {}); registry.close(); registry = new CodexGenerationRegistry(root); owner = new CodexRouterOwner(registry); await owner.ready; },
    async close() { await owner.dispose(); await owner.drain().catch(() => {}); registry.close(); await rm(root, { recursive: true, force: true }); } };
}
test("router fence counts accepted admission, rejects new calls, and releases only exact zero proof", async () => {
  const f = await fixture();
  try {
    const done = await f.owner.enter(); await f.owner.fence(f.input());
    await assert.rejects(async () => await f.owner.enter(), /fenced/);
    assert.equal((await f.owner.inspect(f.input(), empty)).activeCount, 1);
    await assert.rejects(async () => await f.owner.release(f.input(), empty, "config"), /drained/);
    await done();
    assert.equal((await f.owner.inspect(f.input(), { ...empty, counts: { subscriptions: 1 }, activeCount: 1 })).activeCount, 1);
    const proof = await f.owner.inspect(f.input(), empty);
    await assert.rejects(async () => await f.owner.release({ ...f.input(), proof: "wrong" }, empty, "config"), /proof/);
    await f.owner.release({ ...f.input(), proof: proof.identity }, empty, "config");
    await assert.rejects(async () => await f.owner.abort(f.input()), /after release/);
    assert.throws(() => new CodexGenerationRegistry(f.root), /locked/);
    await f.reopen();
    assert.equal(f.owner.isOpen(), false);
    let reads = 0; const native = async () => { reads++; return ["original-native"]; };
    await assert.rejects(f.owner.coldReady(f.input(), "changed", native), /configuration/);
    const ready = await f.owner.coldReady(f.input(), "config", native);
    const stale = f.input(); await f.reopen();
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
      if (kind === "fence") await f.owner.fence(f.input());
      if (kind === "admission") await f.owner.enter();
      if (kind === "tool") await f.owner.uncertain();
      await assert.rejects(async () => await f.reopen(), /unconfirmed/);
    } finally { await f.close(); }
  }
});
test("registry changes invalidate release and cold readiness; unknown coverage cannot mint idle", async () => {
  const f = await fixture();
  try {
    await f.owner.fence(f.input());
    assert.equal((await f.owner.inspect(f.input(), { ...empty, coverage: "unknown" })).activeCount, null);
    await assert.rejects(async () => await f.owner.release(f.input(), empty, "config"), /drained/);
    const proof = await f.owner.inspect(f.input(), empty); f.registry.setMetadata("changed", 1);
    await assert.rejects(async () => await f.owner.release({ ...f.input(), proof: proof.identity }, empty, "config"), /changed/);
    const next = await f.owner.inspect(f.input(), empty); await f.owner.release({ ...f.input(), proof: next.identity }, empty, "config");
    await f.reopen(); f.registry.setMetadata("changed", 2);
    await assert.rejects(f.owner.coldReady(f.input(), "config", async () => []), /registry/);
  } finally { await f.close(); }
});

test("completed spawn admission retains a durable tool lease across source crash", async () => {
  const f = await fixture();
  try {
    const call = await f.owner.enter(), tool = await f.owner.retainConnectionTool(); await call();
    await f.owner.fence(f.input()); assert.equal((await f.owner.inspect(f.input(), empty)).activeCount, 1);
    await tool(); const proof = await f.owner.inspect(f.input(), empty); assert.equal(proof.activeCount, 0);
    await f.owner.abort(f.input());
    const again = await f.owner.enter(); await f.owner.retainConnectionTool(); await again();
    await assert.rejects(async () => await f.reopen(), /unconfirmed/);
  } finally { await f.close(); }
});

function leaseRows(registry: CodexGenerationRegistry): any[] {
  const snapshot = registry.coldSnapshot() as { tables: { name: string; rows: { key: string; value: string }[] }[] };
  return snapshot.tables.find(t => t.name === "routing_metadata")!.rows
    .filter(row => row.key.startsWith("router-lease:")).map(row => JSON.parse(row.value));
}
test("lease attribution and unknown reasons persist without request payloads, including after release and cold reopen", async () => {
  const f = await fixture();
  try {
    const scope = { method: "turn/start", connectionId: "connection", rpcId: "9", generationId: "old", incarnation: 2,
      ownerEpoch: f.registry.ownerEpoch, admissionEpoch: 1, threadId: "old-thread", turnId: "turn", callId: "call",
      params: { input: "PRIVATE_INPUT", env: { KEY: "PRIVATE_VALUE" } }, message: "PRIVATE_ERROR" };
    const lease = await f.owner.enter(false, scope);
    assert.ok(f.registry.metadata(`router-lease:${lease.id}`), "attribution is durable before native dispatch");
    assert.ok(f.owner.snapshot().pending?.includes(lease.id));
    await lease.sent(); await lease.unknown("native-result-unknown"); await lease(); await lease();
    const record = f.registry.metadata(`router-lease:${lease.id}`) as any;
    assert.equal(record.method, "turn/start"); assert.equal(record.threadId, "old-thread"); assert.equal(record.turnId, "turn");
    assert.equal(record.generationId, "old"); assert.equal(record.incarnation, 2); assert.equal(record.connectionId, "connection");
    assert.ok(record.acceptedAt && record.sentAt && record.releasedAt && record.uncertainty["native-result-unknown"].firstAt);
    assert.equal(record.routerOwner, f.owner.owner); assert.equal(record.pid, process.pid);
    assert.equal(record.phase, "released", "released records only the counter, not a successful operation");
    assert.ok(f.owner.snapshot().uncertain); assert.equal(f.owner.snapshot().pending?.length, 0);
    assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|params|input|env|message/u);
    await assert.rejects(async () => await f.reopen(), /unconfirmed/);
    assert.deepEqual(f.registry.metadata(`router-lease:${lease.id}`), record);
  } finally { await f.close(); }
});
test("known releases are bounded while unknown evidence and duplicate or late uncertainty survive", async () => {
  const f = await fixture();
  try {
    const late = await f.owner.enter(false, { method: "process/spawn", processHandle: "terminal" }); await late();
    await late.unknown("consumer-disconnected"); await late.unknown("consumer-disconnected"); await late();
    for (let i = 0; i < 40; i++) await (await f.owner.enter(false, { method: "thread/read", rpcId: String(i) }))();
    const records = leaseRows(f.registry);
    assert.equal(records.filter(row => !row.uncertainty).length, 32);
    const unknown = records.find(row => row.id === late.id)!;
    assert.equal(unknown.uncertainty["consumer-disconnected"].count, 2);
    assert.equal(unknown.processHandle, "terminal"); assert.equal(f.owner.snapshot().activeCalls, 0);
    assert.ok(f.owner.snapshot().uncertain); await f.owner.fence(f.input());
    assert.equal((await f.owner.inspect(f.input(), empty)).coverage, "unknown");
    await assert.rejects(async () => await f.owner.release(f.input(), empty, "config"), /drained/);
  } finally { await f.close(); }
});
test("lease/state write failure rolls back atomically and prevents native work", async () => {
  const f = await fixture();
  try {
    const set = f.registry.setMetadata.bind(f.registry); let nativeRan = false;
    f.registry.setMetadata = (key, value) => { if (key.startsWith("router-lease:")) throw Error("fixture write failure"); set(key, value); };
    await assert.rejects(async () => { await f.owner.enter(false, { method: "turn/start" }); nativeRan = true; }, /write failure/);
    assert.equal(nativeRan, false); assert.equal(f.owner.isOpen(), false);
    assert.equal(f.registry.metadata("router-handoff"), null); assert.deepEqual(leaseRows(f.registry), []);
  } finally { await f.close(); }
});
test("old anonymous unknown is rejected unchanged rather than assigned invented attribution", async () => {
  const f = await fixture();
  try {
    const old = { version: 1, epoch: 0, phase: "open", uncertain: true, pending: ["legacy-anonymous"] };
    f.registry.setMetadata("router-handoff", old);
    await assert.rejects(async () => await f.reopen(), /unconfirmed/);
    assert.deepEqual(f.registry.metadata("router-handoff"), old); assert.deepEqual(leaseRows(f.registry), []);
  } finally { await f.close(); }
});

test("transient uncertainty write failure cannot be erased by a later successful release", async () => {
  for (const standalone of [false, true]) {
    const f = await fixture();
    try {
      const lease = await f.owner.enter(false, { method: "turn/start", generationId: "old", threadId: "thread" }); await lease.sent();
      const write = f.registry.updateMetadata.bind(f.registry); let failed = false;
      f.registry.updateMetadata = (values, remove) => {
        if (!failed && (values["router-handoff"] as any).uncertain) { failed = true; throw Error("fixture transient unknown write"); }
        write(values, remove);
      };
      await assert.rejects(async () => standalone ? await f.owner.uncertain("consumer-disconnected", { method: "thread/started" }) : await lease.unknown("native-result-unknown"), /transient unknown write/);
      assert.ok((f.registry.metadata("router-handoff") as any).pending.includes(lease.id));
      await lease();
      assert.equal(f.owner.isOpen(), false);
      assert.equal((f.registry.metadata("router-handoff") as any).uncertain, true);
      assert.deepEqual((f.registry.metadata("router-handoff") as any).pending, []);
      if (!standalone) assert.ok((f.registry.metadata(`router-lease:${lease.id}`) as any).uncertainty["native-result-unknown"]);
      await assert.rejects(async () => await f.reopen(), /unconfirmed/);
    } finally { await f.close(); }
  }
});
