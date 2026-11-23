import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderTurnRetry, codexProviderFailure, pooledRetryAt, providerRetryDecision, type ProviderRetryPort, type ProviderRetry } from "@opencraft/host-recovery";
import { boundedWakeTimer, MAX_WAKE_DELAY_MS, type OwnerWakeTimerFactory } from "@opencraft/workspace-host";
import { DAY, fakeWakeClock, flush, HOUR, MINUTE } from "../support/fake-wake-clock";

async function fixture(t: test.TestContext, override: Partial<ProviderRetryPort> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "provider-retry-"));
  let now = 1_000_000;
  const sent: ProviderRetry[] = [];
  const port: ProviderRetryPort = { serialize: async (_id, work) => work(), inspect: async row => ({ failure: row.failure }),
    continue: async (row, _current, admit) => { if (!admit()) return null; sent.push(row); return `auto-${sent.length}`; }, changed() {}, ...override };
  let owner = new ProviderTurnRetry(directory, port, () => now, () => 0);
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, sent, port, get owner() { return owner; }, advance(ms: number) { now += ms; }, async reboot() { await owner.close(); owner = new ProviderTurnRetry(directory, port, () => now, () => 0); } };
}

test("only structured transient provider errors retry, including native retry exhaustion", () => {
  for (const info of ["unauthorized", "badRequest", "contextWindowExceeded", "sessionBudgetExceeded", "sandboxError", "cyberPolicy", "other", undefined]) assert.equal(codexProviderFailure({ codexErrorInfo: info }).kind, "permanent");
  for (const variant of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
    assert.equal(codexProviderFailure({ codexErrorInfo: { [variant]: { httpStatusCode: 503 } } }).kind, "unavailable");
    assert.equal(codexProviderFailure({ codexErrorInfo: { [variant]: { httpStatusCode: 401 } } }).kind, "permanent");
    assert.equal(codexProviderFailure({ codexErrorInfo: { [variant]: { httpStatusCode: 429 } } }).kind, "rate-limit");
    assert.equal(codexProviderFailure({ codexErrorInfo: { [variant]: {} } }).kind, "permanent");
  }
  assert.equal(codexProviderFailure({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }).kind, "unavailable");
  assert.equal(codexProviderFailure({ message: "HTTP 503 overloaded" }).kind, "permanent");
});
test("backoff, jitter, total attempt limit and known quota resets are bounded", () => {
  assert.deepEqual(providerRetryDecision({ kind: "overloaded" }, 0, 100, 0), { kind: "retry", retryAt: 5100 });
  assert.deepEqual(providerRetryDecision({ kind: "unavailable" }, 2, 100, .5), { kind: "retry", retryAt: 180100 });
  assert.deepEqual(providerRetryDecision({ kind: "overloaded" }, 4, 100), { kind: "decline", reason: "exhausted" });
  assert.deepEqual(providerRetryDecision({ kind: "rate-limit" }, 0, 100), { kind: "decline", reason: "reset-unknown" });
  assert.deepEqual(providerRetryDecision({ kind: "rate-limit", retryAt: 22_000_000 }, 0, 100), { kind: "decline", reason: "wait-too-long" });
  assert.deepEqual(providerRetryDecision({ kind: "rate-limit", retryAt: 1000 }, 0, 100, .5), { kind: "retry", retryAt: 31_000 });
});
test("pool readiness uses eligible accounts and all reported reset windows", () => {
  const blocked = { enabled: true, credentialConfigured: true, status: "exhausted", limitWindows: [{ resetAt: 3000 }, { resetAt: 6000 }] };
  assert.equal(pooledRetryAt([blocked], 1000), 6000);
  assert.equal(pooledRetryAt([blocked, { ...blocked, status: "ready" }], 1000), 1000);
  assert.equal(pooledRetryAt([{ ...blocked, limitWindows: [{ resetAt: null }] }], 1000), undefined);
  assert.equal(pooledRetryAt([{ ...blocked, enabled: false }, { ...blocked, credentialConfigured: false }], 1000), undefined);
  assert.equal(pooledRetryAt([{ ...blocked, status: "error" }], 1000), undefined);
});
test("one failure earns one durable retry, with a limit that survives restarts", async t => {
  const f = await fixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  f.owner.failed("t", "initial", { kind: "overloaded" });
  const at = f.owner.snapshot("t")!.retryAt;
  await f.reboot(); await f.owner.recover(); assert.equal(f.sent.length, 0);
  assert.equal(f.owner.snapshot("t")?.retryAt, at);
  for (let n = 1; n <= 4; n++) {
    f.advance(240_000); await f.owner.recover(); assert.equal(f.sent.length, n);
    assert.equal(f.owner.snapshot("t")?.attempts, n);
    f.owner.failed("t", `auto-${n}`, { kind: n % 2 ? "unavailable" : "overloaded" });
    await f.reboot();
  }
  f.advance(240_000); await f.owner.recover();
  assert.equal(f.sent.length, 4); assert.equal(f.owner.notice("t")?.state, "exhausted");
  assert.equal(f.owner.notice("t")?.rootTurnId, "initial");
});
test("stop while inspecting or preparing revokes the last send boundary", async t => {
  for (const phase of ["inspect", "prepare"]) {
    const f = await fixture(t);
    if (phase === "inspect") f.port.inspect = async row => { f.owner.handled("t"); return { failure: row.failure }; };
    else f.port.continue = async (_row, current, admit) => { f.owner.handled("t"); assert.equal(current(), false); assert.equal(admit(), false); return null; };
    f.owner.failed("t", "initial", { kind: "overloaded" }); f.advance(60_000);
    await f.owner.recover(); await f.reboot(); await f.owner.recover();
    assert.equal(f.sent.length, 0); assert.equal(f.owner.notice("t"), null);
  }
});
test("unknown dispatch acknowledgement is never replayed after restart", async t => {
  let sends = 0;
  const f = await fixture(t, { continue: async (_row, _current, admit) => { assert.ok(admit()); sends++; throw new Error("ACK lost"); } });
  f.owner.failed("t", "initial", { kind: "unavailable" }); f.advance(240_000); await f.owner.recover();
  assert.equal(f.owner.notice("t")?.state, "unconfirmed");
  await f.reboot(); f.advance(240_000); await f.owner.recover(); assert.equal(sends, 1);
});
test("native start before ACK preserves the chain, and a late old failure cannot replace it", async t => {
  const f = await fixture(t);
  f.port.continue = async (row, _current, admit) => { assert.ok(admit()); f.owner.started("t", "accepted"); f.owner.failed("t", "accepted", { kind: "unavailable" }); return "accepted"; };
  f.owner.failed("t", "initial", { kind: "overloaded" }); f.advance(60_000); await f.owner.recover();
  assert.equal(f.owner.snapshot("t")?.attempts, 1); assert.equal(f.owner.snapshot("t")?.state, "waiting");
  f.owner.failed("t", "initial", { kind: "overloaded" }); assert.equal(f.owner.snapshot("t")?.turnId, "accepted");
});
test("live or completed native work and newer user intentions never start a second execution", async t => {
  for (const state of ["live", "finished", "handled"] as const) {
    const f = await fixture(t, { inspect: async () => state });
    f.owner.failed("t", "initial", { kind: "overloaded" }); f.advance(60_000); await f.owner.recover();
    assert.equal(f.sent.length, 0);
  }
});
test("preparation failures are bounded and restart retains the spent budget", async t => {
  const f = await fixture(t, { continue: async () => { throw new Error("preparation unavailable"); } });
  f.owner.failed("t", "initial", { kind: "overloaded" });
  for (let n = 0; n < 6; n++) { f.advance(240_000); await f.owner.recover(); await f.reboot(); }
  assert.equal(f.owner.notice("t")?.state, "exhausted"); assert.equal(f.owner.snapshot("t")?.attempts, 4);
});
test("a restart during preparation consumes the durable attempt before any send", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  f.port.continue = async (_row, _current, admit) => { entered(); await gate; return admit() ? "unexpected" : null; };
  f.owner.failed("t", "initial", { kind: "overloaded" }); f.advance(60_000);
  const work = f.owner.recover(); await preparing;
  assert.equal(f.owner.snapshot("t")?.attempts, 1);
  const closing = f.owner.close(); release(); await work; await closing;
  await f.reboot();
  f.port.continue = async (_row, _current, admit) => admit() ? "after-restart" : null;
  await f.owner.recover(); assert.equal(f.owner.snapshot("t")?.attempts, 2);
});

// Owner-driven wake-up (workspace-host-split.md §4.3): the next pass is armed through the OwnerWakeTimer port from
// durable rows (`retryAt`), never a private setTimeout, and every pass decides due-ness from durable state.
async function wakeFixture(t: test.TestContext, options: { admission?: () => boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "provider-retry-wake-"));
  const time = fakeWakeClock();
  let armed: number | null = null, hold: Promise<void> | null = null;
  const sent: string[] = [];
  const raw: (() => void)[] = [];
  const port: ProviderRetryPort = {
    serialize: async (_id, work) => work(),
    inspect: async row => row.state === "running" ? "live" : { failure: row.failure },
    continue: async (row, _current, admit) => {
      if (hold) await hold;
      if (!admit()) return null;
      sent.push(row.inputId!); return `auto-${sent.length}`;
    },
    changed() {},
  };
  const wakeTimer: OwnerWakeTimerFactory = wake => {
    raw.push(wake);
    const timer = boundedWakeTimer(time.clock, wake);
    return { arm(at) { armed = at; timer.arm(at); }, cancel() { armed = null; timer.cancel(); } };
  };
  const open = () => new ProviderTurnRetry(directory, port, time.clock.now, () => 0, options.admission, wakeTimer);
  let owner = open();
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    time, sent, raw,
    get owner() { return owner; },
    get armed() { return armed; },
    holdContinue() { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
    async reopen() { await owner.close(); owner = open(); },
  };
}

test("wake-up: a durable retryAt arms the owner wake-up, which dispatches once when due", async t => {
  const f = await wakeFixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  await flush();
  const retryAt = f.owner.snapshot("t")!.retryAt;
  assert.equal(retryAt, f.time.now + 5000);
  f.time.elapse(0); await flush();
  assert.equal(f.armed, retryAt, "the settled pass arms the durable retry time");
  f.time.elapse(4999); await flush(); assert.equal(f.sent.length, 0);
  f.time.elapse(1); await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.owner.snapshot("t")?.state, "running");
  assert.equal(f.armed, f.time.now + 30_000, "an admitted retry reconciles a missed terminal receipt");
  f.owner.finished("t", "auto-1");
  f.time.elapse(30_000); await flush();
  assert.equal(f.armed, null, "nothing pending, nothing armed"); assert.equal(f.time.pending, 0);
});

test("wake-up: restart re-arms from durable rows once the engine wakes the owner, and catches up overdue retries", async t => {
  const f = await wakeFixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  const retryAt = f.owner.snapshot("t")!.retryAt;
  await f.reopen();
  assert.equal(f.armed, null, "a reopened owner is passive until native initialize");
  f.owner.wake(); f.time.elapse(0); await flush();
  assert.equal(f.sent.length, 0); assert.equal(f.armed, retryAt, "the wake-up comes from the durable row");
  await f.reopen();
  f.time.jump(HOUR); f.time.elapse(MINUTE); await flush();
  assert.equal(f.sent.length, 0);
  f.owner.wake(); f.time.elapse(0); await flush();
  assert.equal(f.sent.length, 1, "an overdue retry runs once on the first pass");
  assert.equal(f.owner.snapshot("t")?.attempts, 1);
});

test("wake-up: a clock set back never dispatches before the durable retryAt, and a forward jump loses nothing", async t => {
  const f = await wakeFixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  f.time.elapse(0); await flush();
  const retryAt = f.owner.snapshot("t")!.retryAt;
  f.time.jump(-HOUR); f.time.elapse(10_000); await flush();
  assert.equal(f.sent.length, 0, "the owner clock has not reached retryAt");
  await f.owner.recover(); f.owner.wake(); f.time.elapse(0); await flush();
  assert.equal(f.sent.length, 0, "explicit passes still decide from durable state");
  assert.equal(f.armed, retryAt);
  f.time.elapse(retryAt - f.time.now); await flush();
  assert.equal(f.sent.length, 1);
  f.owner.failed("t", "auto-1", { kind: "unavailable" });
  f.time.jump(DAY); f.time.elapse(MAX_WAKE_DELAY_MS); await flush();
  assert.equal(f.sent.length, 2, "the retry passed by the jump runs once");
  assert.equal(new Set(f.sent).size, 2);
});

test("wake-up: close cancels the wake-up and drains the in-flight retry", async t => {
  const f = await wakeFixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  const release = f.holdContinue();
  f.time.elapse(0); await flush();
  f.time.elapse(5000); await flush();
  let closed = false;
  const closing = f.owner.close().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false, "close waits for the pass crossing the engine boundary");
  assert.equal(f.time.pending, 0, "no wake-up remains armed");
  release(); await closing;
  for (const wake of f.raw) wake();
  f.time.elapse(DAY); await flush();
  assert.equal(f.sent.length, 0, "closing revoked admission; late wake-ups do nothing");
  await f.reopen();
  assert.equal(f.owner.snapshot("t")?.state, "preparing", "the drained pass left its durable attempt");
  f.owner.wake(); f.time.elapse(0); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.owner.snapshot("t")?.attempts, 2);
});

test("wake-up: late and concurrent wake-ups dispatch each retry once", async t => {
  const f = await wakeFixture(t);
  f.owner.failed("t", "initial", { kind: "overloaded" });
  f.time.elapse(5000);
  const release = f.holdContinue();
  const passes = [f.owner.recover(), f.owner.recover()];
  f.owner.wake(); f.time.elapse(0);
  for (const wake of f.raw) wake();
  await flush();
  release(); await Promise.all(passes); await flush();
  f.time.elapse(0);
  for (const wake of f.raw) wake();
  await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.owner.snapshot("t")?.state, "running");
});

test("wake-up: a fenced owner re-checks pending work without dispatching and resumes without a browser event", async t => {
  let open = true;
  const f = await wakeFixture(t, { admission: () => open });
  f.owner.failed("t", "initial", { kind: "overloaded" });
  f.time.elapse(0); await flush();
  open = false;
  f.time.elapse(5000); await flush();
  assert.equal(f.sent.length, 0);
  assert.ok(f.armed! > f.time.now && f.armed! <= f.time.now + 1000, "fenced work re-checks at the floor cadence");
  f.time.elapse(3000); await flush();
  assert.equal(f.sent.length, 0);
  open = true;
  f.time.elapse(1000); await flush();
  assert.equal(f.sent.length, 1, "reopened admission is noticed by the owner wake-up alone");
});
