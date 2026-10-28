import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { accountCoreOwner } from "../../scripts/full-upgrade/account-core-owner.mjs";

const token = "synthetic-private-account-owner-token";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oc-acct-")), children: ChildProcess[] = [];
  const data = join(root, "data"); await mkdir(data, { mode: 0o700 });
  const store = new AccountPoolStore({ databasePath: join(data, "account-pool.sqlite"), secretsDirectory: join(data, "secrets") });
  store.addAccount({ id: "a", provider: "codex", label: "synthetic", upstreamAccountId: "a", priority: 0, enabled: true },
    { accessToken: "synthetic-access", refreshToken: null, expiresAt: null });
  const hostToken = store.issueHostToken("local-codex"); store.close();
  let consumeCalls = 0;
  const upstream = createServer((req, res) => {
    if (req.url === "/usage") { res.end('{"plan_type":"pro"}'); return; }
    if (req.url === "/images/generations") { res.end('{"ok":true}'); return; }
    if (req.url === "/reset-credits") { res.end(JSON.stringify({ available_count: 1, credits: [
      { id: "credit-a", status: "available", is_supported_by_plan: true, reset_type: "codex_rate_limits", expires_at: null },
    ] })); return; }
    if (req.url === "/reset-credits/consume") { consumeCalls++; res.destroy(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: first\n\n'); setTimeout(() => res.end('data: last\n\n'), 250);
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const socket = join(root, "account.sock"), runtime = join(root, "app.sock");
  const options = { endpoint: socket, appServerEndpoint: runtime, authToken: token, dataDirectory: data,
    syntheticMaintenance: true,
    runtimeDirectory: root, nativeCodexHomeDirectory: join(root, "unused"), executable: process.execPath,
    upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, proxyPort: 0 };
  const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, "127.0.0.1", r));
  options.proxyPort = (reserve.address() as any).port; await new Promise<void>(r => reserve.close(() => r()));
  const config = join(root, "core.json"); await writeFile(config, JSON.stringify(options), { mode: 0o600 });
  async function start(extraEnvironment: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/split-codex-owner.ts", "core", config], {
      cwd: resolve(import.meta.dirname, "../.."), env: { PATH: process.env.PATH, HOME: root, ...extraEnvironment }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let errors = ""; child.stderr!.on("data", b => { errors += b; });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", b => { if (String(b).includes("ready\n")) resolve(); });
      child.once("exit", () => reject(new Error(errors))); child.once("error", reject);
    });
    const descriptor = join(root, `descriptor-${child.pid}.json`);
    await writeFile(descriptor, JSON.stringify({ schemaVersion: 1, pid: child.pid, endpoint: socket, token }), { mode: 0o600 });
    return { child, adapter: accountCoreOwner(descriptor), logs: () => errors };
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(r => { child.once("exit", () => r()); child.kill("SIGTERM"); });
  }
  const model = (path = "/v1/responses", metadata = true) => fetch(`http://127.0.0.1:${options.proxyPort}${path}`, {
    method: "POST", headers: { "x-opencraft-account-pool-token": hostToken, "content-type": "application/json",
      ...(metadata ? { "thread-id": "thread-a", "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-a", turn_id: "turn-a" }) }
        : { "x-codex-image-turn-id": "turn-a" }) }, body: "{}" });
  const accountRpc = (method: string, params = {}) => new Promise<{status: number; value: any}>((resolve, reject) => {
    const r = request({ socketPath: socket, path: "/accounts", method: "POST", headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks: Buffer[] = []; res.on("data", b => chunks.push(b)); res.on("end", () => resolve({ status: res.statusCode!, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); r.on("error", reject); r.end(JSON.stringify({ method: `opencraft/codex/accounts/${method}`, params }));
  });
  const account = async () => (await accountRpc("list")).status;
  const input = (s: any) => ({ expectedOwner: s.handoff.owner, expectedEpoch: s.handoff.epoch, operationId: "handoff-test", fence: "fence-test" });
  return { root, data, start, stop, model, account, accountRpc, consumeCalls: () => consumeCalls, input, async close() { for (const child of children) await stop(child); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); await rm(root, { recursive: true, force: true }); } };
}

test("split account handoff drains full streams, freezes account RPC, preserves image affinity and repeats across owners", async () => {
  const f = await fixture();
  try {
    let current = await f.start();
    const response = await f.model();
    const initial = await current.adapter.snapshot();
    const fenced = await current.adapter.acquireFence(f.input(initial));
    assert.ok(fenced.proof.activeCount > 0);
    await current.adapter.abortFence(f.input(fenced));
    assert.equal(await f.account(), 200);
    await current.adapter.acquireFence(f.input(await current.adapter.snapshot()));
    await assert.rejects(current.adapter.releaseWriter({ ...f.input(await current.adapter.snapshot()), proof: fenced.proof.identity }));
    assert.equal((await f.model()).status, 503); assert.equal(await f.account(), 503);
    assert.match(await response.text(), /last/); await delay(20);
    for (let n = 0; n < 3; n++) {
      const inspected = await current.adapter.inspectDrain(f.input(await current.adapter.snapshot()));
      assert.equal(inspected.proof.activeCount, 0); assert.equal(inspected.proof.coverage, "complete");
      await current.adapter.releaseWriter({ ...f.input(inspected), proof: inspected.proof.identity });
      await assert.rejects(f.start(), /already owned or cannot be locked/);
      await f.stop(current.child); current = await f.start();
      const cold = await current.adapter.coldReady(f.input(await current.adapter.snapshot()));
      assert.equal(cold.ready.storageOutcome, "ready");
      await current.adapter.releaseFence(f.input(cold), cold);
      assert.equal(await f.account(), 200);
      await f.stop(current.child); current = await f.start();
      assert.equal((await f.model("/v1/images/generations", false)).status, 200);
      if (n < 2) await current.adapter.acquireFence(f.input(await current.adapter.snapshot()));
    }
  } finally { await f.close(); }
});

test("a failed candidate restores the compatible old owner using current data and rejects previous incarnation readiness", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); await delay(50);
    const fence = await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({ ...f.input(fence), proof: fence.proof.identity }); await f.stop(first.child);
    const candidate = await f.start(), cold = await candidate.adapter.coldReady(f.input(await candidate.adapter.snapshot()));
    const before = await readFile(join(f.data, "account-pool.sqlite")); await f.stop(candidate.child);
    const start = Date.now(), restored = await f.start(), state = await restored.adapter.snapshot();
    await assert.rejects(restored.adapter.releaseFence(f.input(state), cold));
    const fresh = await restored.adapter.coldReady(f.input(state)); await restored.adapter.releaseFence(f.input(fresh), fresh);
    assert.equal(await f.account(), 200); assert.deepEqual(await readFile(join(f.data, "account-pool.sqlite")), before);
    assert.ok(Date.now() - start < 15000);
  } finally { await f.close(); }
});

test("unconfirmed release and unsafe credential permissions block a successor without clearing the fence", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); await first.adapter.acquireFence(f.input(await first.adapter.snapshot())); await f.stop(first.child);
    await assert.rejects(f.start(), /release is unconfirmed/);
    assert.equal(JSON.parse(await readFile(join(f.data, "account-handoff.json"), "utf8")).phase, "fenced");
  } finally { await f.close(); }
  const g = await fixture();
  try {
    const first = await g.start(); await delay(50);
    const fence = await first.adapter.acquireFence(g.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({ ...g.input(fence), proof: fence.proof.identity }); await g.stop(first.child);
    await chmod(join(g.data, "secrets/account-a.json"), 0o644); await assert.rejects(g.start(), /Private account owner file required/);
    await chmod(join(g.data, "secrets/account-a.json"), 0o600);
    const recovered = await g.start(), cold = await recovered.adapter.coldReady(g.input(await recovered.adapter.snapshot()));
    await recovered.adapter.releaseFence(g.input(cold), cold); assert.equal(await g.account(), 200);
  } finally { await g.close(); }
});


test("a completed unknown reset-credit result carries its exact key across process handoff without replay", async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const result = await f.accountRpc("resetCredits/consume", { accountId: "a", creditId: "credit-a", idempotencyKey: "unknown-attempt-a", confirmed: true });
    assert.equal(result.value.outcome, "unknown"); assert.equal(f.consumeCalls(), 1);
    const fence = await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    assert.equal(fence.proof.activeCount, 0);
    const released = await first.adapter.releaseWriter({ ...f.input(fence), proof: fence.proof.identity });
    const receipts = released.handoff.retained.resetReceipts;
    assert.deepEqual(receipts, [{ accountId: "a", creditId: "credit-a", idempotencyKey: "unknown-attempt-a", outcome: "unknown" }]);
    await f.stop(first.child); const next = await f.start(), cold = await next.adapter.coldReady(f.input(await next.adapter.snapshot()));
    assert.deepEqual(cold.handoff.retained.resetReceipts, receipts);
    await next.adapter.releaseFence(f.input(cold), cold); assert.equal(f.consumeCalls(), 1);
    await f.stop(next.child); const openRestart = await f.start();
    assert.deepEqual((await openRestart.adapter.snapshot()).handoff.retained.resetReceipts, receipts);
    const fenced = await openRestart.adapter.acquireFence(f.input(await openRestart.adapter.snapshot()));
    const again = await openRestart.adapter.releaseWriter({ ...f.input(fenced), proof: fenced.proof.identity });
    assert.deepEqual(again.handoff.retained.resetReceipts, receipts);
  } finally { await f.close(); }
});

test("pending OAuth blocks release; its normal cancellation remains available behind the source fence", async () => {
  const f = await fixture();
  try {
    const first = await f.start(), login = await f.accountRpc("deviceLogin/start");
    assert.equal(login.status, 200);
    const fenced = await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    assert.ok(fenced.proof.counts.oauth > 0);
    await assert.rejects(first.adapter.releaseWriter({ ...f.input(fenced), proof: fenced.proof.identity }));
    assert.equal((await f.accountRpc("deviceLogin/start")).status, 503);
    assert.equal((await f.accountRpc("deviceLogin/poll", { sessionId: login.value.sessionId })).value.status, "pending");
    assert.equal((await f.accountRpc("deviceLogin/cancel", { sessionId: login.value.sessionId })).value.cancelled, true);
    const idle = await first.adapter.inspectDrain(f.input(fenced));
    assert.equal(idle.proof.activeCount, 0);
    await first.adapter.releaseWriter({ ...f.input(idle), proof: idle.proof.identity });
    await f.stop(first.child); const next = await f.start(), cold = await next.adapter.coldReady(f.input(await next.adapter.snapshot()));
    await next.adapter.releaseFence(f.input(cold), cold);
    assert.equal((await f.accountRpc("deviceLogin/poll", { sessionId: login.value.sessionId })).value.message, "Login cancelled.");
  } finally { await f.close(); }
});

test("a lost proxy delivery receipt remains unknown after disconnect and process replacement", async () => {
  const f = await fixture();
  try {
    const first = await f.start(), response = await f.model(); await response.body!.cancel();
    let state;
    for (let n = 0; n < 100; n++) { state = await first.adapter.snapshot(); if (state.proof.coverage === "unknown" && state.proof.counts.proxy === 0) break; await delay(10); }
    assert.equal(state.proof.coverage, "unknown"); assert.equal(state.proof.activeCount, null);
    const fenced = await first.adapter.acquireFence(f.input(state));
    await assert.rejects(first.adapter.releaseWriter({ ...f.input(fenced), proof: fenced.proof.identity }));
    await first.adapter.abortFence(f.input(fenced));
    await f.stop(first.child); const next = await f.start(), restored = await next.adapter.snapshot();
    assert.deepEqual(restored.handoff.uncertain, state.handoff.uncertain);
    assert.equal(restored.proof.coverage, "unknown"); assert.equal((await f.model()).status, 200);
  } finally { await f.close(); }
});


test("malformed unauthenticated proxy requests do not create upstream uncertainty or fence valid traffic", async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const options = JSON.parse(await readFile(join(f.root, "core.json"), "utf8"));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: options.proxyPort, method: "POST", path: "/v1/responses", headers: { host: "[" } }, res => {res.resume();res.on("end", () => resolve(res.statusCode!));});
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 502);
    const state = await first.adapter.snapshot();
    assert.equal(state.proof.coverage, "complete"); assert.deepEqual(state.handoff.uncertain, []);
    assert.equal((await f.model()).status, 200);
  } finally { await f.close(); }
});

test("a frozen successor preserves all sealed maintenance files until the durable resume decision", async () => {
  const f = await fixture();
  try {
    const first = await f.start(); await delay(50);
    for (const directory of ["login", "refresh"]) {
      await mkdir(join(f.data, directory, "leftover"), { recursive: true, mode: 0o700 });
      await writeFile(join(f.data, directory, "leftover/receipt.txt"), "synthetic retained maintenance state", { mode: 0o600 });
    }
    const fence = await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({ ...f.input(fence), proof: fence.proof.identity }); await f.stop(first.child);
    const next = await f.start();
    for (const directory of ["login", "refresh"]) assert.equal(await readFile(join(f.data, directory, "leftover/receipt.txt"), "utf8"), "synthetic retained maintenance state");
    const cold = await next.adapter.coldReady(f.input(await next.adapter.snapshot()));
    for (const directory of ["login", "refresh"]) assert.equal(await readFile(join(f.data, directory, "leftover/receipt.txt"), "utf8"), "synthetic retained maintenance state");
    await next.adapter.releaseFence(f.input(cold), cold);
    assert.equal(await f.account(), 200);
  } finally { await f.close(); }
});

test("an exact retained list larger than four MiB survives release, cold read and open restart without truncation", async () => {
  const f = await fixture();
  try {
    const imageAffinities = Array.from({length: 8192}, (_, i) => [`local-codex\0turn-${i}`, {affinityId:'a'.repeat(512),expiresAt:Date.now()+86400000}]);
    await writeFile(join(f.data, 'account-handoff.json'), JSON.stringify({schemaVersion:1,epoch:0,phase:'open',uncertain:[],retained:{imageAffinities,resetReceipts:[],loginReceipts:[]}}), {mode:0o600});
    assert.ok((await readFile(join(f.data, 'account-handoff.json'))).length > 4*1024*1024);
    const first = await f.start(); await delay(50);
    const fence = await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    const released = await first.adapter.releaseWriter({...f.input(fence),proof:fence.proof.identity});
    assert.equal(released.handoff.retained.imageAffinities.length, 8192);
    await f.stop(first.child); const next = await f.start(), cold = await next.adapter.coldReady(f.input(await next.adapter.snapshot()));
    assert.equal(cold.handoff.retained.imageAffinities.length,8192);
    await next.adapter.releaseFence(f.input(cold),cold); await f.stop(next.child);
    const restarted = await f.start(); assert.equal((await restarted.adapter.snapshot()).handoff.retained.imageAffinities.length,8192);
  } finally {await f.close();}
});


test("fixed CLI configuration cannot switch paths through an identical launcher", async () => {
  const f=await fixture();
  try {
    const first=await f.start(); await delay(50);
    const fence=await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({...f.input(fence),proof:fence.proof.identity}); await f.stop(first.child);
    const path=join(f.root,'core.json'),original=JSON.parse(await readFile(path,'utf8'));
    const alias=join(f.root,'same-launcher'); await symlink(original.executable,alias);
    await writeFile(path,JSON.stringify({...original,executable:alias}),{mode:0o600});
    const candidate=await f.start();
    await assert.rejects(candidate.adapter.coldReady(f.input(await candidate.adapter.snapshot())));
    await f.stop(candidate.child); await writeFile(path,JSON.stringify(original),{mode:0o600});
    const restored=await f.start(),cold=await restored.adapter.coldReady(f.input(await restored.adapter.snapshot()));
    await restored.adapter.releaseFence(f.input(cold),cold); assert.equal(await f.account(),200);
  } finally {await f.close();}
});

test("malformed private credentials fail startup and cold recovery without logging their contents", async () => {
  const f=await fixture(),secretPath=join(f.data,'secrets/account-a.json');
  const original=await readFile(secretPath),canary='PRIVATE_CREDENTIAL_CANARY_42';
  const rejected=async()=>{let error:Error|undefined;try{await f.start();}catch(e){error=e as Error;}assert.ok(error);assert.equal(error.message.includes('PRIVATE_CREDENTIAL'),false);};
  try {
    await writeFile(secretPath,canary,{mode:0o600});await rejected();
    await writeFile(secretPath,original,{mode:0o600});const first=await f.start();await delay(50);
    const fence=await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({...f.input(fence),proof:fence.proof.identity});await f.stop(first.child);
    await writeFile(secretPath,canary,{mode:0o600});await rejected();
    await writeFile(secretPath,JSON.stringify({kind:'codex-auth-file',path:{secret:canary}}),{mode:0o600});await rejected();
    await writeFile(secretPath,original,{mode:0o600});const restored=await f.start(),cold=await restored.adapter.coldReady(f.input(await restored.adapter.snapshot()));
    await restored.adapter.releaseFence(f.input(cold),cold);assert.equal(await f.account(),200);
  }finally{await f.close();}
});


test("cold admission rejects a changed stable service environment and restores the original selector", async () => {
  const f=await fixture();
  try {
    const first=await f.start();await delay(50);const fence=await first.adapter.acquireFence(f.input(await first.adapter.snapshot()));
    await first.adapter.releaseWriter({...f.input(fence),proof:fence.proof.identity});await f.stop(first.child);
    const candidate=await f.start({OPENCRAFT_CORE_TEST_SELECTOR:'changed'});
    await assert.rejects(candidate.adapter.coldReady(f.input(await candidate.adapter.snapshot())));await f.stop(candidate.child);
    const restored=await f.start(),cold=await restored.adapter.coldReady(f.input(await restored.adapter.snapshot()));
    await restored.adapter.releaseFence(f.input(cold),cold);assert.equal(await f.account(),200);
  }finally{await f.close();}
});


test("malformed Host credentials cannot leak through startup or proxy diagnostics", async () => {
  const f=await fixture(),directory=join(f.data,'secrets');
  const name=(await readdir(directory)).find(name=>name.startsWith('host-'))!,path=join(directory,name),original=await readFile(path),canary='PRIVATE_HOST_CANARY_42';
  try {
    await writeFile(path,canary,{mode:0o600});let error:Error|undefined;try{await f.start();}catch(e){error=e as Error;}
    assert.ok(error);assert.equal(error.message.includes('PRIVATE_HOST'),false);
    await writeFile(path,original,{mode:0o600});const first=await f.start();
    await writeFile(path,canary,{mode:0o600});const response=await f.model();assert.equal(response.status,502);await response.text();
    assert.equal(first.logs().includes('PRIVATE_HOST'),false);
    await writeFile(path,original,{mode:0o600});assert.equal((await f.model()).status,200);
  }finally{await f.close();}
});
