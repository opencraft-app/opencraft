import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { AccountHandoffStore } from "../../apps/codex-core/src/account-handoff-store.js";
import { AccountCoreOwner } from "../../apps/codex-core/src/account-owner.js";
import { operatorLeaseClaim } from "../../scripts/full-upgrade/operator-lease.mjs";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "oc-handoff-facts-"));
  const pool = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") }); pool.close();
  const options = { dataDirectory, executable: process.execPath, nativeCodexHomeDirectory: join(dataDirectory, "native"),
    runtimeDirectory: dataDirectory, endpoint: join(dataDirectory, "control.sock"), appServerEndpoint: join(dataDirectory, "runtime.sock"),
    authToken: "fixture-auth-".repeat(4), proxyPort: 32145, accountHandoffStorage: "sqlite" as const };
  const owners: AccountCoreOwner[] = [];
  return { dataDirectory, options, owner() { const owner = new AccountCoreOwner(options); owners.push(owner); return owner; },
    async close() { for (const owner of owners) { owner.dispose(); owner.closeStorage(); } await rm(dataDirectory, { recursive: true, force: true }); } };
}

test("25,000 legacy unknowns import once, preserve exact order/hash, and read through byte-bounded pages", async () => {
  const f = await fixture();
  try {
    const unknown = Array.from({ length: 25_000 }, (_, n) => ({ id: `legacy-${n}`, route: "/v1/responses" }));
    await writeFile(join(f.dataDirectory, "account-handoff.json"), JSON.stringify({ schemaVersion: 1, phase: "open", epoch: 2, uncertain: unknown, carriedUnknown: unknown.slice(0, 20_000) }), { mode: 0o600 });
    const first = f.owner(); await first.load();
    const summary = first.snapshot(true);
    assert.equal("uncertain" in summary, false); assert.equal("carriedUnknown" in summary, false);
    assert.deepEqual(summary.historicalUnknownSummary, { count: unknown.length, sha256: digest(unknown) });
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 4096);
    const records = []; let after = 0;
    do { const page = first.historyPage(summary.historicalUnknownSummary, after);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768); records.push(...page.records); after = page.next ?? 0;
    } while (after);
    assert.deepEqual(records, unknown);
    assert.equal(JSON.parse(await readFile(join(f.dataDirectory, "account-handoff.json"), "utf8")).schemaVersion, 2);
    first.closeStorage();
    const next = f.owner(); await next.load();
    assert.deepEqual(next.snapshot().uncertain, unknown);
    assert.deepEqual(next.snapshot().carriedUnknown, unknown.slice(0, 20_000));
    await next.uncertain("/api/codex/ps/mcp");
    assert.throws(() => next.historyPage(summary.historicalUnknownSummary), /snapshot changed/);
  } finally { await f.close(); }
});

test("failed transactional import can retry without partial facts or checkpoint", async () => {
  const f = await fixture(); const store = new AccountHandoffStore(f.dataDirectory);
  try {
    assert.throws(() => store.import({ schemaVersion: 2 }, [{ id: "a", route: "other" }, { id: "a", route: "other" }]));
    assert.equal(store.checkpoint(), undefined); assert.deepEqual(store.records(), []);
    store.import({ schemaVersion: 2 }, [{ id: "a", route: "other" }]);
    assert.deepEqual(store.summary(), { count: 1, sha256: digest([{ id: "a", route: "other" }]) });
  } finally { store.close(); await f.close(); }
});

for (const result of ["completed", "failed", "unknown"] as const) {
 test(`crash recovery preserves ${result} independently of transport`, async () => {
  const f = await fixture();
  try {
    let store = new AccountHandoffStore(f.dataDirectory);
    store.import({ schemaVersion: 2 }, []); store.dispatch("attempt", "source", "/v1/responses");
    if (result !== "unknown") store.terminal("attempt", "source", result);
    store.close(); store = new AccountHandoffStore(f.dataDirectory); store.recover();
    assert.equal(store.summary().count, result === "unknown" ? 1 : 0);
    if (result !== "unknown") assert.throws(() => store.appendUnknown({ id: "attempt", route: "/v1/responses" }), /terminal/);
    store.recover(); assert.equal(store.summary().count, result === "unknown" ? 1 : 0);
    store.close();
  } finally { await f.close(); }
 });
}

test("requests accepted before fencing can settle without using a stale control revision", async () => {
  const f = await fixture();
  try {
    const owner = f.owner(); await owner.load(); owner.dispatchAttempt("live", "/v1/responses");
    const before = owner.snapshot(true), launch = await owner.launchReference();
    await owner.fence({ expectedOwner: before.owner, expectedEpoch: before.epoch, expectedRevision: before.revision,
      operationId: "handoff", fence: "fence", operatorLease: await operatorLeaseClaim(), targetLaunch: launch, preflightLaunch: launch,
      historicalUnknownSummary: before.historicalUnknownSummary });
    owner.terminalAttempt("live", "completed"); owner.settleAttempt("live");
    assert.equal(owner.snapshot(true).historicalUnknownSummary.count, 0);
    await assert.rejects(owner.abortFence({ expectedOwner: before.owner, expectedEpoch: before.epoch + 1, expectedRevision: before.revision,
      operationId: "handoff", fence: "fence" }), /conflict/);
    assert.equal(owner.snapshot(true).phase, "fenced");
  } finally { await f.close(); }
});

test("a read cannot revoke an issued drain permit; current target launch survives a committed restart", async () => {
  const f = await fixture();
  try {
    const source = f.owner(); await source.load();
    const first = source.snapshot(true), launch = await source.launchReference();
    const input = { expectedOwner: first.owner, expectedEpoch: first.epoch, operationId: "handoff", fence: "fence",
      operatorLease: await operatorLeaseClaim(), targetLaunch: launch, preflightLaunch: launch, historicalUnknownSummary: first.historicalUnknownSummary };
    await source.fence(input); input.expectedEpoch++;
    const observation = { activeCount: 0, historicalCount: 0, counts: {} };
    const proof = source.issueDrainPermit(observation);
    for (let i = 0; i < 20; i++) { source.snapshot(true); source.inspect(observation); }
    await source.release({ ...input, proof: proof.identity }, observation, () => ({ imageAffinities: [], resetReceipts: [], loginReceipts: [] }), async () => {});
    source.closeStorage();
    const target = f.owner(); await target.load();
    const current = { ...input, expectedOwner: target.owner };
    await assert.rejects(target.resume(current), /readiness/);
    const ready = await target.coldReady(current); await target.resume({ ...current, identity: ready.identity }); target.closeStorage();
    const restarted = f.owner(); await restarted.load(); assert.equal(restarted.snapshot(true).phase, "open");
  } finally { await f.close(); }
});

test("committed target environment remains authoritative: old source cannot become ordinary crash recovery", async () => {
  const f = await fixture(), key = "OC_HANDOFF_MODEL_LAUNCH_TEST", previous = process.env[key];
  try {
    process.env[key] = "source"; const source = f.owner(); await source.load();
    const state = source.snapshot(true), sourceLaunch = await source.launchReference();
    process.env[key] = "target"; const targetLaunch = await source.launchReference();
    assert.notDeepEqual(sourceLaunch, targetLaunch); process.env[key] = "source";
    const input = { expectedOwner: source.owner, expectedEpoch: state.epoch, operationId: "env-handoff", fence: "env-fence",
      operatorLease: await operatorLeaseClaim(), targetLaunch, preflightLaunch: targetLaunch, historicalUnknownSummary: state.historicalUnknownSummary };
    await assert.rejects(source.fence({ ...input, preflightLaunch: sourceLaunch }), /preflight mismatch/);
    assert.equal(source.snapshot(true).phase, "open");
    await source.fence(input); input.expectedEpoch++;
    const observation = { activeCount: 0, historicalCount: 0, counts: {} }, proof = source.issueDrainPermit(observation);
    await source.release({ ...input, proof: proof.identity }, observation, () => ({ imageAffinities: [], resetReceipts: [], loginReceipts: [] }), async () => {});
    source.closeStorage(); process.env[key] = "target";
    const target = f.owner(); await target.load(); const next = { ...input, expectedOwner: target.owner };
    const ready = await target.coldReady(next); await target.resume({ ...next, identity: ready.identity }); target.closeStorage();
    process.env[key] = "source"; const stale = f.owner(); await assert.rejects(stale.load(), /installed checkpoint/); stale.closeStorage();
    process.env[key] = "target"; const current = f.owner(); await current.load(); assert.equal(current.snapshot(true).phase, "open");
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; await f.close(); }
});

test("initial SQLite migration rejects a changed sealed environment before retiring legacy recovery", async () => {
  const f = await fixture(), key = "OC_HANDOFF_FIRST_MIGRATION_TEST", previous = process.env[key];
  const source = new AccountCoreOwner({ ...f.options, accountHandoffStorage: undefined });
  try {
    process.env[key] = "source"; await source.load();
    const state = source.snapshot(), input = { expectedOwner: source.owner, expectedEpoch: state.epoch,
      operationId: "first-migration", fence: "migration-fence", operatorLease: await operatorLeaseClaim() };
    await source.fence(input); input.expectedEpoch++;
    const observation = { activeCount: 0, historicalCount: 0, counts: {} }, proof = source.issueDrainPermit(observation);
    await source.release({ ...input, proof: proof.identity }, observation,
      () => ({ imageAffinities: [], resetReceipts: [], loginReceipts: [] }), async () => {});
    const path = join(f.dataDirectory, "account-handoff.json"), before = await readFile(path, "utf8");
    process.env[key] = "changed-target";
    const candidate = f.owner(); await assert.rejects(candidate.load(), /configuration|launch/i); candidate.closeStorage();
    assert.equal(await readFile(path, "utf8"), before, "failed target must preserve the legacy release authority");
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(join(f.dataDirectory, "account-handoff.sqlite")), { code: "ENOENT" });
    process.env[key] = "source";
    const recovery = new AccountCoreOwner({ ...f.options, accountHandoffStorage: undefined });
    try {
      await recovery.load(); const current = { ...input, expectedOwner: recovery.owner };
      const ready = await recovery.coldReady(current); await recovery.resume({ ...current, identity: ready.identity });
      assert.equal(recovery.snapshot().phase, "open");
    } finally { recovery.dispose(); recovery.closeStorage(); }
  } finally { source.dispose(); source.closeStorage(); if (previous === undefined) delete process.env[key]; else process.env[key] = previous; await f.close(); }
});
