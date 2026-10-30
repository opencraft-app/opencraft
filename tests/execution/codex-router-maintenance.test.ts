import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { CodexGenerationRegistry, inspectGenerationRegistry } from "../../apps/codex-core/src/generation-registry.js";
import { CodexRouterOwner } from "../../apps/codex-core/src/router-owner.js";
import { routerDigest, processStamp, readRouterMaintenance, verifyRouterConsumers, type RouterMaintenanceReceipt } from "../../apps/codex-core/src/router-maintenance.js";

const empty = { coverage: "complete" as const, activeCount: 0, historicalCount: 0, counts: {} };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(mode: "fenced-source" | "crashed-source" | "interrupted-source" = "fenced-source") {
  const root = await mkdtemp(join(tmpdir(), "router-maintenance-")), lock = join(root, "deploy.lock");
  const controller = spawn("python3", ["-u", "-c", "import fcntl,sys,os; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print(os.getpid(),flush=True); sys.stdin.read()", lock], { stdio: ["pipe", "pipe", "inherit"] });
  await once(controller.stdout, "data");
  const source = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"]); await once(source, "spawn");
  const sourcePid = source.pid!, startTime = processStamp(sourcePid)!; source.kill(); await once(source, "exit");
  let registry = new CodexGenerationRegistry(root);
  const state = { version: 1, phase: mode !== "crashed-source" ? "fenced" : "open", epoch: 9, uncertain: true,
    operationId: "operation", fence: "fence", sourceOwner: "old-source", pending: Array.from({ length: 20 }, (_, n) => `pending-${n}`) };
  registry.setMetadata("router-handoff", state);
  const bundle = join(root, "old-router.cjs"); await writeFile(bundle, "synthetic old router artifact\n");
  const native = { proof: "Native execution is quiet; delivery remains unknown" }, bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const receipt: RouterMaintenanceReceipt = { version: 1, kind: "router-maintenance", mode, operationId: "operation", fence: "fence",
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    controller: { pid: controller.pid!, startTime: processStamp(controller.pid!)!, bootId, lock },
    source: { pid: sourcePid, startTime, bootId, owner: "old-source", bundle, bundleSha256: hash(await readFile(bundle)) },
    sourceHandoff: state, registrySha256: routerDigest(registry.coldSnapshot()), configurationSha256: "f".repeat(64), native,
    consumers: ["synthetic-consumer.service"], systemdScope: "system", payloadSha256: [hash(await readFile(process.argv[1]!))],
    ...(mode === "fenced-source" ? { sourceSnapshot: { pid: sourcePid, handoff: { ...state, pid: sourcePid, owner: "old-source", bootId, incarnation: "source-incarnation", activeCalls: 20, persistence: "ready" },
      proof: { coverage: "unknown", activeCount: null, counts: { connectionTools: 0, lifecycle: 0, monitor: 0, nativeAdmission: 0, rpc: 0, starting: 0, subscriptions: 0, unresolvedCreations: 0 } } } } : {}) };
  if (receipt.sourceSnapshot) {
    const proof = receipt.sourceSnapshot.proof;
    Object.assign(proof, { ownerId: "old-source", operationId: "operation", fence: "fence", epoch: 9, bootId, incarnation: "source-incarnation", expiresAt: new Date(Date.now() + 15000).toISOString() });
    proof.identity = routerDigest(proof);
  }
  const file = join(root, "receipt.json");
  let consumerBusy = false;
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = ((command: string) => { assert.equal(command, "systemctl"); return consumerBusy ? "LoadState=loaded\nMainPID=5\nActiveState=active\nSubState=running\n" : "LoadState=loaded\nMainPID=0\nActiveState=inactive\nSubState=dead\n"; }) as typeof exec;
  syncBuiltinESMExports();
  const save = () => writeFile(file, JSON.stringify(receipt), { mode: 0o600 }); await save();
  return { root, state, file, receipt, native, save, busyConsumer() { consumerBusy = true; }, async endController() { controller.stdin.end(); await once(controller, "exit"); }, get registry() { return registry; },
    open() { return new CodexRouterOwner(registry, file); },
    reopen() { registry.close(); registry = new CodexGenerationRegistry(root); return new CodexRouterOwner(registry); },
    async close() { childProcess.execFileSync = exec; syncBuiltinESMExports(); registry.close(); if (controller.exitCode === null) { controller.stdin.end(); await once(controller, "exit"); } await rm(root, { force: true, recursive: true }); } };
}
for (const mode of ["fenced-source", "crashed-source"] as const) test(`${mode} carries all 20 unknown IDs unchanged and survives candidate and controller loss`, async () => {
  const f = await fixture(mode);
  try {
    assert.throws(() => new CodexRouterOwner(f.registry), /unconfirmed/);
    const owner = f.open(); assert.equal(owner.isOpen(), false);
    await owner.importMaintenance(f.receipt.configurationSha256, async () => f.native);
    assert.deepEqual(owner.snapshot().pending, f.state.pending); assert.equal(owner.snapshot().uncertain, true);
    assert.equal(owner.snapshot().historicalPendingCount, 20); assert.equal(owner.snapshot().activeCalls, 0);
    const original = owner.snapshot().historicalUnknownSnapshots[0]!.sourceHandoff;
    assert.deepEqual(original, f.state);
    await f.endController();
    let successor = f.reopen();
    const input = () => ({ expectedOwner: successor.owner, expectedEpoch: successor.snapshot().epoch, operationId: "operation", fence: "fence", historicalUnknownSha256: successor.snapshot().historicalUnknownSha256 });
    const oldReady = await successor.coldReady(input(), f.receipt.configurationSha256, async () => f.native);
    successor = f.reopen(); await assert.rejects(successor.resume({ ...input(), identity: oldReady.identity }, f.receipt.configurationSha256, async () => f.native), /incarnation/);
    const ready = await successor.coldReady(input(), f.receipt.configurationSha256, async () => f.native);
    await successor.resume({ ...input(), identity: ready.identity }, f.receipt.configurationSha256, async () => f.native);
    assert.equal(successor.isOpen(), true); assert.deepEqual(successor.snapshot().pending, f.state.pending); assert.equal(successor.snapshot().uncertain, true);
    // A different incarnation cannot adopt an open historical owner without a
    // maintenance receipt and fresh cold readiness, even when current work is zero.
    assert.throws(() => new CodexRouterOwner(f.registry), /explicit cold recovery/);
    assert.throws(() => successor.fence({ ...input(), historicalUnknownSha256: undefined }), /conflict/);
    successor.fence(input()); const proof = successor.inspect(input(), empty); assert.equal(proof.activeCount, 0);
    successor.release({ ...input(), proof: proof.identity }, empty, f.receipt.configurationSha256);
    assert.deepEqual(inspectGenerationRegistry(f.root).metadata["router-handoff"], f.registry.metadata("router-handoff"));
    assert.deepEqual(original, f.state);
  } finally { await f.close(); }
});
test("new unknown is not covered by the old history and still blocks restart and release", async () => {
  const f = await fixture();
  try {
    let owner = f.open(); await owner.importMaintenance(f.receipt.configurationSha256, async () => f.native); owner = f.reopen();
    const input = () => ({ expectedOwner: owner.owner, expectedEpoch: owner.snapshot().epoch, operationId: "operation", fence: "fence", historicalUnknownSha256: owner.snapshot().historicalUnknownSha256 });
    const ready = await owner.coldReady(input(), f.receipt.configurationSha256, async () => f.native); await owner.resume({ ...input(), identity: ready.identity }, f.receipt.configurationSha256, async () => f.native);
    const lease = owner.enter(false, { method: "turn/start", threadId: "new-thread" }); lease.unknown("native-result-unknown"); lease();
    owner.fence(input()); assert.equal(owner.inspect(input(), empty).coverage, "unknown"); assert.throws(() => owner.release({ ...input(), proof: "fake" }, empty, f.receipt.configurationSha256), /drained/);
    assert.throws(() => f.reopen(), /unconfirmed/); assert.deepEqual((f.registry.metadata("router-handoff") as any).pending, f.state.pending);
  } finally { await f.close(); }
});
test("changed receipt, source still alive, missing deployment lock and busy consumers are rejected", async () => {
  for (const change of ["state", "expired", "alive", "lock", "counts", "payload", "consumer"] as const) {
    const f = await fixture();
    try {
      if (change === "state") f.receipt.sourceHandoff = { ...f.state, pending: [] };
      if (change === "expired") f.receipt.expiresAt = new Date(0).toISOString();
      if (change === "alive") { f.receipt.source.pid = process.pid; f.receipt.source.startTime = processStamp(process.pid)!; }
      if (change === "lock") f.receipt.controller.pid = process.pid;
      if (change === "counts") f.receipt.sourceSnapshot!.proof.counts.nativeAdmission = 1;
      if (change === "consumer") f.busyConsumer();
      if (change === "payload") f.receipt.payloadSha256 = ["0".repeat(64)];
      await f.save(); assert.throws(() => f.open()); assert.deepEqual(f.registry.metadata("router-handoff"), f.state);
    } finally { await f.close(); }
  }
});
test("failed Native validation or atomic seal leaves the original unknown exactly intact", async () => {
  for (const fail of ["native", "transaction"] as const) {
    const f = await fixture();
    try {
      const owner = f.open(), write = f.registry.setMetadata.bind(f.registry);
      if (fail === "transaction") f.registry.setMetadata = (key, value) => { if (key === "router-handoff") throw Error("fixture transaction interruption"); write(key, value); };
      await assert.rejects(owner.importMaintenance(f.receipt.configurationSha256, async () => fail === "native" ? {} : f.native));
      assert.deepEqual(f.registry.metadata("router-handoff"), f.state);
      const snapshot = f.registry.coldSnapshot() as any; assert.equal(snapshot.tables.find((t: any) => t.name === "routing_metadata").rows.filter((r: any) => r.key.startsWith("router-history:")).length, 0);
      assert.equal(owner.isOpen(), false);
    } finally { await f.close(); }
  }
});

test("read-only collection rejects changed migration history before stopping a writer", async () => {
 const f=await fixture();try {
  (f.registry as any).database.prepare("UPDATE schema_migrations SET checksum='wrong' WHERE version=1").run();
  assert.throws(()=>inspectGenerationRegistry(f.root),/history/);
  assert.deepEqual(f.registry.metadata("router-handoff"),f.state);
 } finally {await f.close();}
});

test('explicit interrupted import retains unconfirmed active requests while original owners progress',async()=>{const f=await fixture('interrupted-source');try{const native={version:1,policy:'continuing-v1',core:{owner:'original-core',epoch:1,pid:2,historicalUnknown:['keep-core-unknown']},generations:[{generationId:'old',incarnation:1,identity:{ownerPid:3,nativePid:4},observations:{pendingCallbacks:1}}]};f.receipt.native=native;f.state.uncertain=false;f.registry.setMetadata('router-handoff',f.state);f.receipt.registrySha256=routerDigest(f.registry.coldSnapshot());await f.save();const owner=f.open();assert.equal(owner.continuingNative(),true);await owner.importMaintenance(f.receipt.configurationSha256,async()=>({...native,core:{...native.core,historicalUnknown:['keep-core-unknown','new-observation']}}));assert.deepEqual(owner.snapshot().pending,f.state.pending);assert.equal(owner.snapshot().uncertain,true);assert.equal(owner.snapshot().historicalUnknownSnapshots[0]!.sourceHandoff.uncertain,false);const input=()=>({expectedOwner:owner.owner,expectedEpoch:owner.snapshot().epoch,operationId:'operation',fence:'fence',historicalUnknownSha256:owner.snapshot().historicalUnknownSha256});await assert.rejects(owner.coldReady(input(),f.receipt.configurationSha256,async()=>({...native,core:{...native.core,pid:99}})),/owner changed/);let progress=0;const advancing=async()=>({...native,generations:[{...native.generations[0]!,observations:{pendingCallbacks:++progress}}]});const ready=await owner.coldReady(input(),f.receipt.configurationSha256,advancing);await owner.resume({...input(),identity:ready.identity},f.receipt.configurationSha256,advancing);assert(owner.isOpen());assert.deepEqual(owner.snapshot().pending,f.state.pending);owner.fence(input());assert.equal(owner.continuingNative(),false,'ordinary fence removes the migration policy');}finally{await f.close();}});
test('provisional observations never authorize writer admission',async()=>{const f=await fixture('interrupted-source');try{(f.receipt as any).provisional=true;await f.save();assert.throws(()=>f.open(),/receipt rejected/);}finally{await f.close();}});
