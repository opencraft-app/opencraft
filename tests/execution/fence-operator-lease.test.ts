import { DatabaseSync } from "node:sqlite";
import { chmod } from "node:fs/promises";
import { startControlServer, readControlJson } from "../../apps/codex-core/src/control-server.js";
import { accountCoreOwner } from "../../scripts/full-upgrade/account-core-owner.mjs";
import { codexRouterOwner } from "../../scripts/full-upgrade/codex-router-owner.mjs";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AccountCoreOwner } from "../../apps/codex-core/src/account-owner.js";
import { CodexRouterOwner } from "../../apps/codex-core/src/router-owner.js";
import { CodexGenerationRegistry } from "../../apps/codex-core/src/generation-registry.js";

async function claim(pid: number, ttlMs = 1000) {
  const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ").at(-1)!.split(" ");
  return { version: 1 as const, id: randomUUID(), controller: { pid, startTime: fields[19]!, bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() }, ttlMs };
}
async function fixture(kind: "core" | "router", seed = true) {
  const directory = await mkdtemp(join(tmpdir(), "oc-fence-lease-"));
  let registry: CodexGenerationRegistry | undefined;
  const owner = kind === "core" ? new AccountCoreOwner({ executable: process.execPath, dataDirectory: directory,
    runtimeDirectory: directory, nativeCodexHomeDirectory: join(directory, "native"), endpoint: join(directory, "core.sock"),
    appServerEndpoint: join(directory, "app.sock"), authToken: "synthetic-operator-lease-token", proxyPort: 12345 })
    : new CodexRouterOwner(registry = new CodexGenerationRegistry(directory));
  if (owner instanceof AccountCoreOwner) { await owner.load(); if (seed) await owner.uncertain("/v1/responses"); }
  else if (seed) { const pending = owner.enter(); pending.unknown("consumer-disconnected"); }
  const snapshot = (): any => structuredClone(owner.snapshot());
  const responsibility = () => {
    const s = snapshot(); return { uncertain: s.uncertain, pending: s.pending, currentUncertain: s.currentUncertain,
      history: s.history, retained: s.retained };
  };
  const input = (operatorLease?: Awaited<ReturnType<typeof claim>>) => ({ expectedOwner: owner.owner, expectedEpoch: snapshot().epoch,
    operationId: "lease-test", fence: "lease-test-fence", historicalUnknown: snapshot().uncertain,
    historicalUnknownSha256: snapshot().historicalUnknownSha256, operatorLease });
  const fence = async (lease?: Awaited<ReturnType<typeof claim>>) => owner.fence(input(lease));
  return { owner, directory, snapshot, responsibility, input, fence,
    async close() { (owner as any).dispose?.(); registry?.close(); await rm(directory, { recursive: true, force: true }); },
    async durable() { return kind === "core" ? JSON.parse(await readFile(join(directory, "account-handoff.json"), "utf8")) : registry!.metadata("router-handoff"); } };
}
async function waitOpen(snapshot: () => any) {
  const end = Date.now() + 2200;
  while (snapshot().phase !== "open" && Date.now() < end) await delay(25);
  assert.equal(snapshot().phase, "open");
}
for (const kind of ["core", "router"] as const) {
  test(`${kind}: killed real operator aborts source fence and durably preserves unknown`, async () => {
    const f = await fixture(kind), child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      await once(child, "spawn"); const before = f.responsibility(); await f.fence(await claim(child.pid!));
      assert.equal(f.snapshot().phase, "fenced"); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      await waitOpen(f.snapshot); assert.deepEqual(f.responsibility(), before);
      const durable: any = await f.durable(); assert.equal(durable.phase, "open");
      assert.equal(durable.operatorLeaseAborts.at(-1).reason, "operator-exited");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await f.close(); }
  });
  test(`${kind}: an alive operator without renewal expires without changing responsibility`, async () => {
    const f = await fixture(kind);
    try { const before = f.responsibility(); await f.fence(await claim(process.pid)); await waitOpen(f.snapshot);
      assert.deepEqual(f.responsibility(), before); assert.equal((await f.durable() as any).operatorLeaseAborts.at(-1).reason, "lease-expired");
    } finally { await f.close(); }
  });
  test(`${kind}: normal renewal preserves legal maintenance beyond its initial TTL`, async () => {
    const f = await fixture(kind);
    try { const lease = await claim(process.pid); await f.fence(lease);
      const end = Date.now() + 1700;
      while (Date.now() < end) { await delay(200); await (f.owner as any).renewOperatorLease(f.input(lease)); assert.equal(f.snapshot().phase, "fenced"); }
      if (f.owner instanceof AccountCoreOwner) await f.owner.abortFence(f.input(lease)); else f.owner.abort(f.input(lease));
      assert.equal(f.snapshot().phase, "open"); assert.equal((await f.durable() as any).operatorLeaseAborts?.length ?? 0, 0);
    } finally { await f.close(); }
  });
  test(`${kind}: missing lease is rejected before admission closes`, async () => {
    const f = await fixture(kind);
    try { await assert.rejects(f.fence(), /operator|lease/i); assert.equal(f.snapshot().phase, "open"); }
    finally { await f.close(); }
  });
}

for (const kind of ["core", "router"] as const) {
  test(`${kind}: wrong process identity and a stale renewal cannot close or resurrect admission`, async () => {
    const f = await fixture(kind);
    try {
      const good = await claim(process.pid);
      await assert.rejects(f.fence({ ...good, controller: { ...good.controller, startTime: "0" } }), /operator lease/i);
      await assert.rejects(f.fence({ ...good, controller: { ...good.controller, bootId: "wrong-boot" } }), /operator lease/i);
      assert.equal(f.snapshot().phase, "open");
      await f.fence(good); const stale = f.input(good);
      await waitOpen(f.snapshot);
      await assert.rejects(f.fence(good), /terminated/);
      assert.equal(f.snapshot().phase, "open", "expired claim cannot fence again at the latest epoch");
      await assert.rejects(async () => f.owner.renewOperatorLease(stale));
      const next = await claim(process.pid); await f.fence(next);
      await assert.rejects(async () => f.owner.renewOperatorLease(stale));
      assert.equal(f.snapshot().phase, "fenced"); assert.equal(f.snapshot().operatorLease.id, next.id);
    } finally { await f.close(); }
  });

  test(`${kind}: lease renewal preserves the exact drain proof and released owner never auto-opens`, async () => {
    const f = await fixture(kind, false);
    try {
      if (kind === "core") {
        const path = join(f.directory, "account-pool.sqlite"), db = new DatabaseSync(path);
        db.exec("CREATE TABLE pool_affinity(id TEXT)"); db.close(); await chmod(path, 0o600);
      }
      const lease = await claim(process.pid); await f.fence(lease);
      const observation = { coverage: "complete" as const, activeCount: 0, historicalCount: 0, counts: {} };
      const proof = f.owner instanceof AccountCoreOwner ? f.owner.inspect(observation) : f.owner.inspect(f.input(), observation);
      const durable = await f.durable();
      f.owner.renewOperatorLease(f.input(lease));
      assert.deepEqual(await f.durable(), durable, "renewal does not change cold data or the persisted fence");
      const input = { ...f.input(), proof: proof.identity };
      if (f.owner instanceof AccountCoreOwner) await f.owner.release(input, observation, () => ({ imageAffinities: [], resetReceipts: [], loginReceipts: [] }), async () => { await delay(1200); });
      else f.owner.release(input, observation, "configuration");
      await delay(1100);
      assert.equal(f.snapshot().phase, "released");
      assert.equal(f.snapshot().operatorLeaseAborts?.length ?? 0, 0);
    } finally { await f.close(); }
  });

  test(`${kind}: public controller adapter renews the real owner and abort restores the same unknown responsibility`, async () => {
    const f = await fixture(kind), token = "synthetic-lease-wire-control-token", endpoint = join(f.directory, "wire.sock");
    const tokenFile = join(f.directory, "token"), descriptor = join(f.directory, "descriptor.json");
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(descriptor, JSON.stringify({ schemaVersion: 1, endpoint, pid: process.pid, token }), { mode: 0o600 });
    const actions: string[] = [];
    const control = await startControlServer(endpoint, token, async request => {
      const perform = async () => {
        if (request.method === "POST") {
          const input: any = await readControlJson(request); actions.push(input.action);
          if (input.action === "fence") await f.owner.fence(input);
          else if (input.action === "renew-operator-lease") f.owner.renewOperatorLease(input);
          else if (input.action === "abort") { if (f.owner instanceof AccountCoreOwner) await f.owner.abortFence(input); else f.owner.abort(input); }
          else throw Error("Unexpected fixture action");
        }
        return { status: 200, value: { pid: process.pid, handoff: f.snapshot() } };
      };
      return perform();
    });
    const adapter = kind === "core" ? accountCoreOwner(descriptor, { ttlMs: 1000, renewMs: 150 }) : codexRouterOwner(endpoint, tokenFile, { ttlMs: 1000, renewMs: 150 });
    try {
      const before = f.responsibility(); await adapter.acquireFence(f.input()); await delay(1500);
      assert.equal(f.snapshot().phase, "fenced"); assert.ok(actions.filter(a => a === "renew-operator-lease").length >= 3);
      await adapter.abortFence(f.input()); assert.equal(f.snapshot().phase, "open");
      assert.deepEqual(f.responsibility(), before);
    } finally { adapter.dispose(); await control.close(); await f.close(); }
  });
}

for (const kind of ["core", "router"] as const) test(`${kind}: mutable snapshot copies cannot alter live bindings or their terminal receipt`, async () => {
  const f = await fixture(kind);
  try {
    const lease = await claim(process.pid); await f.fence(lease);
    const copy: any = f.owner.snapshot(); copy.operatorLease.controller.pid = 0;
    f.owner.renewOperatorLease(f.input(lease));
    await waitOpen(f.snapshot);
    const archived: any = f.owner.snapshot(); archived.operatorLeaseAborts.pop();
    assert.equal(f.snapshot().operatorLeaseAborts.length, 1);
    await assert.rejects(f.fence(lease), /terminated/);
  } finally { await f.close(); }
});
