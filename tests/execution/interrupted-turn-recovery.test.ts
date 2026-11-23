import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { InterruptedTurnRecovery, RecoveryNotSubmitted, type RecoveryTurn, type TurnRecoveryPort } from "@opencraft/host-recovery";
import { boundedWakeTimer, type OwnerWakeTimerFactory } from "@opencraft/workspace-host";
import { DAY, fakeWakeClock, flush, HOUR } from "../support/fake-wake-clock";

async function fixture(t: test.TestContext, override: Partial<TurnRecoveryPort> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "interrupted-turn-"));
  const starts: any[] = [];
  const port: TurnRecoveryPort = {
    serialize: async (_id, work) => work(), inspect: async () => "lost",
    continue: async (row, _current, admit) => { if (!admit()) return null; starts.push(row); return `auto-${starts.length}`; }, changed() {}, ...override,
  };
  let recovery = new InterruptedTurnRecovery(directory, port);
  t.after(async () => { await recovery.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, starts, port, get recovery() { return recovery; }, async reboot() {
    await recovery.close(); recovery = new InterruptedTurnRecovery(directory, port);
  } };
}
test("accepted unfinished execution resumes without a browser, under a durable system attempt", async t => {
  const f = await fixture(t);
  f.recovery.started("thread", "user-turn"); await f.reboot();
  await f.recovery.recover();
  assert.equal(f.starts.length, 1);
  assert.match(f.starts[0].inputId, /^restart-recovery:/);
  assert.deepEqual(f.recovery.notice("thread"), { threadId: "thread", rootTurnId: "user-turn", turnId: "auto-1", attempts: 1, limit: 3, sourceKind: "system", state: "continued" });
  f.recovery.finished("thread", "user-turn"); // Late completion cannot erase its successor.
  f.recovery.lost(); await f.reboot(); await f.recovery.recover();
  assert.equal(f.starts.length, 2);
  assert.equal(f.recovery.notice("thread")?.attempts, 2);
});
test("three attempts across owner restarts exhaust the original chain and stop", async t => {
  let stopped = 0;
  const f = await fixture(t, { stop: async () => { stopped++; } });
  f.recovery.started("thread", "original");
  for (let attempt = 1; attempt <= 4; attempt++) {
    f.recovery.lost(); await f.reboot(); await f.recovery.recover();
    assert.equal(f.starts.length, Math.min(3, attempt));
  }
  assert.equal(f.recovery.notice("thread")?.state, "exhausted"); assert.equal(stopped, 1);
  await f.reboot(); await f.recovery.recover(); assert.equal(f.starts.length, 3);
});
for (const action of ["new-message", "stop"]) test(`${action} durably cancels pending recovery, including late native evidence`, async t => {
  const f = await fixture(t);
  f.recovery.started("thread", "original"); f.recovery.lost(); f.recovery.handled("thread");
  f.recovery.started("thread", "original");
  await f.reboot(); await f.recovery.recover();
  assert.equal(f.starts.length, 0); assert.equal(f.recovery.notice("thread"), null);
});
test("a live execution and an already completed execution never restart", async t => {
  let state: "live" | "finished" = "live";
  const f = await fixture(t, { inspect: async () => state });
  f.recovery.started("thread", "original"); await f.reboot(); await f.recovery.recover();
  assert.equal(f.starts.length, 0);
  state = "finished"; await f.recovery.recover(); await f.reboot(); await f.recovery.recover();
  assert.equal(f.starts.length, 0);
});
test("a new intention during inspection or preparation revokes admission", async t => {
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(t, { inspect: async () => { await barrier; return "lost"; } });
  f.recovery.started("thread", "original"); const running = f.recovery.recover();
  f.recovery.handled("thread"); finish(); await running; assert.equal(f.starts.length, 0);
  f.recovery.started("thread", "next");
  f.port.continue = async (_turn, current) => { f.recovery.handled("thread"); assert.equal(current(), false); return null; };
  await f.recovery.recover(); assert.equal(f.recovery.notice("thread"), null);
});
test("unknown acceptance stays visible and is never blindly resent after restart", async t => {
  let sent = 0;
  const f = await fixture(t, { continue: async (_turn, _current, admit) => { assert.equal(admit(), true); sent++; throw new Error("connection lost before ACK"); } });
  f.recovery.started("thread", "original"); await f.recovery.recover();
  assert.equal(f.recovery.notice("thread")?.state, "unconfirmed");
  await f.reboot(); await f.recovery.recover(); assert.equal(sent, 1);
});
test("a stop racing an already sent continuation survives its late start and ACK", async t => {
  const f = await fixture(t);
  f.recovery.started("thread", "original");
  f.port.continue = async (row, _current, admit) => {
    assert.equal(admit(), true);
    f.recovery.handled("thread");
    f.recovery.started("thread", "late-auto", row.inputId!);
    return "late-auto";
  };
  await f.recovery.recover(); await f.reboot(); await f.recovery.recover();
  assert.equal(f.recovery.notice("thread"), null); assert.equal(f.starts.length, 0);
});
test("preparation failure retries across restart and is bounded by the same limit", async t => {
  let prepared = 0;
  const f = await fixture(t, { continue: async () => { prepared++; throw new Error("Runtime preparation unavailable"); } });
  f.recovery.started("thread", "original");
  for (let n = 0; n < 4; n++) { await f.recovery.recover(); await f.reboot(); }
  assert.equal(prepared, 3); assert.equal(f.recovery.notice("thread")?.state, "exhausted");
});
test("a known rejection can retry, while an accepted-or-unknown send cannot", async t => {
  let attempts = 0;
  const f = await fixture(t, { continue: async (_turn, _current, admit) => {
    assert.equal(admit(), true);
    if (++attempts === 1) throw new RecoveryNotSubmitted("Native request was rejected");
    return "accepted";
  } });
  f.recovery.started("thread", "original"); await f.recovery.recover(); await f.reboot(); await f.recovery.recover();
  assert.equal(attempts, 2); assert.equal(f.recovery.notice("thread")?.turnId, "accepted");
});
test("restart during preparation preserves retryability without an unknown mutation", async t => {
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { continue: async (_turn, _current, admit) => { entered(); await gate; return admit() ? "unexpected" : null; } });
  f.recovery.started("thread", "original"); const running = f.recovery.recover(); await preparing;
  const closed = f.recovery.close(); release(); await running; await closed;
  await f.reboot(); f.port.continue = async (_turn, _current, admit) => admit() ? "continued-after-preparation" : null;
  await f.recovery.recover(); assert.equal(f.recovery.notice("thread")?.turnId, "continued-after-preparation");
});
test("reopening preserves records and a changed migration checksum is rejected", async t => {
  const f = await fixture(t); f.recovery.started("thread", "original");
  await f.reboot(); await f.recovery.recover(); assert.equal(f.starts[0].rootTurnId, "original");
  await f.recovery.close();
  const path = join(f.directory, "interrupted-turn-recovery.sqlite");
  const db = new DatabaseSync(path);
  db.prepare("UPDATE schema_migrations SET checksum='changed' WHERE version=1").run(); db.close();
  assert.throws(() => new InterruptedTurnRecovery(f.directory, f.port), /history|migration|checksum/i);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM interrupted_turns").get()?.n, 1); check.close();
});

// Owner-driven wake-up (workspace-host-split.md §4.3): the pass is armed through the OwnerWakeTimer port, never a
// private setTimeout, and every pass decides from durable rows.
async function wakeFixture(t: test.TestContext, options: { admission?: () => boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "interrupted-turn-wake-"));
  const time = fakeWakeClock();
  let armed: number | null = null, inspections = 0, hold: Promise<void> | null = null;
  let verdict: (row: RecoveryTurn) => "live" | "lost" | "unknown" = row => row.turnId.startsWith("auto-") ? "live" : "lost";
  const starts: string[] = [];
  const raw: (() => void)[] = [];
  const port: TurnRecoveryPort = {
    serialize: async (_id, work) => work(),
    inspect: async row => { inspections++; return verdict(row); },
    continue: async (row, _current, admit) => {
      if (hold) await hold;
      if (!admit()) return null;
      starts.push(row.inputId!); return `auto-${starts.length}`;
    },
    changed() {},
  };
  const wakeTimer: OwnerWakeTimerFactory = wake => {
    raw.push(wake);
    const timer = boundedWakeTimer(time.clock, wake);
    return { arm(at) { armed = at; timer.arm(at); }, cancel() { armed = null; timer.cancel(); } };
  };
  const open = () => new InterruptedTurnRecovery(directory, port, 500, options.admission, time.clock.now, wakeTimer);
  let recovery = open();
  t.after(async () => { await recovery.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    time, starts, raw,
    get recovery() { return recovery; },
    get armed() { return armed; },
    get inspections() { return inspections; },
    set verdict(value: typeof verdict) { verdict = value; },
    holdContinue() { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); return () => { hold = null; release(); }; },
    async reopen() { await recovery.close(); recovery = open(); },
  };
}

test("wake-up: an engine wake arms one pass on the owner clock, only while durable rows are pending", async t => {
  const f = await wakeFixture(t);
  f.recovery.wake();
  assert.equal(f.armed, null, "nothing pending, nothing armed");
  assert.equal(f.time.pending, 0);
  f.recovery.started("thread", "original"); f.recovery.lost("thread");
  f.recovery.wake();
  assert.equal(f.armed, f.time.now + 500);
  f.time.elapse(499); await flush(); assert.equal(f.starts.length, 0);
  f.time.elapse(1); await flush();
  assert.equal(f.starts.length, 1);
  assert.equal(f.recovery.snapshot("thread")?.state, "running");
  assert.equal(f.armed, null, "a continued, live execution is not polled");
  f.time.elapse(HOUR); await flush();
  assert.equal(f.inspections, 1); assert.equal(f.time.pending, 0);
});

test("wake-up: restart catches up durable rows only once the engine wakes the owner", async t => {
  const f = await wakeFixture(t);
  f.recovery.started("thread", "original");
  await f.reopen();
  f.time.jump(DAY); f.time.elapse(HOUR); await flush();
  assert.equal(f.starts.length, 0, "a reopened owner is passive until native initialize");
  f.recovery.wake(); f.time.elapse(500); await flush();
  assert.equal(f.starts.length, 1);
  assert.equal(f.recovery.notice("thread")?.attempts, 1);
});

test("wake-up: unknown evidence re-checks later; a clock set back never fires early or twice", async t => {
  const f = await wakeFixture(t);
  f.verdict = () => "unknown";
  f.recovery.started("thread", "original"); f.recovery.lost("thread");
  f.recovery.wake(); f.time.elapse(500); await flush();
  assert.equal(f.inspections, 1);
  assert.equal(f.armed, f.time.now + 500, "the unsettled row re-checks after delayMs");
  f.time.jump(-HOUR); f.time.elapse(500); await flush();
  assert.equal(f.inspections, 1, "the owner clock is earlier than the target: no pass");
  f.recovery.wake();
  assert.equal(f.armed, f.time.now + 500, "a new engine wake corrects the request to the current clock");
  f.verdict = row => row.turnId.startsWith("auto-") ? "live" : "lost";
  f.time.elapse(500); await flush();
  assert.equal(f.inspections, 2); assert.equal(f.starts.length, 1);
  f.time.jump(DAY); f.time.elapse(HOUR); await flush();
  assert.equal(f.starts.length, 1, "a forward jump finds nothing more to dispatch");
});

test("wake-up: close cancels the wake-up and drains the in-flight continuation", async t => {
  const f = await wakeFixture(t);
  const release = f.holdContinue();
  f.recovery.started("thread", "original"); f.recovery.lost("thread");
  f.recovery.wake(); f.time.elapse(500); await flush();
  let closed = false;
  const closing = f.recovery.close().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false, "close waits for the pass crossing the engine boundary");
  assert.equal(f.time.pending, 0, "no wake-up remains armed");
  release(); await closing;
  assert.equal(f.starts.length, 0, "closing revoked admission before the native send");
  for (const wake of f.raw) wake();
  f.time.elapse(DAY); await flush();
  assert.equal(f.starts.length, 0, "late wake-ups after close do nothing");
  await f.reopen();
  assert.equal(f.recovery.snapshot("thread")?.state, "preparing", "the drained pass left its durable attempt");
  f.recovery.wake(); f.time.elapse(500); await flush();
  assert.equal(f.starts.length, 1); assert.equal(f.recovery.snapshot("thread")?.attempts, 2);
});

test("wake-up: late and concurrent wake-ups dispatch each attempt once", async t => {
  const f = await wakeFixture(t);
  const release = f.holdContinue();
  f.recovery.started("thread", "original"); f.recovery.lost("thread");
  const pass = f.recovery.recover();
  f.recovery.wake(); f.time.elapse(500);
  for (const wake of f.raw) wake();
  await flush();
  release(); await pass; await flush();
  f.time.elapse(500); await flush();
  for (const wake of f.raw) wake();
  await flush();
  assert.equal(f.starts.length, 1, "wake-ups during or after the dispatch only re-read durable state");
  assert.equal(f.recovery.snapshot("thread")?.state, "running");
  assert.ok(f.inspections >= 2);
});

test("wake-up: a fenced owner arms nothing and a reopened admission catches up", async t => {
  let open = false;
  const f = await wakeFixture(t, { admission: () => open });
  f.recovery.started("thread", "original"); f.recovery.lost("thread");
  f.recovery.wake(); f.time.elapse(HOUR); await flush();
  assert.equal(f.armed, null); assert.equal(f.starts.length, 0);
  open = true; f.recovery.wake(); f.time.elapse(500); await flush();
  assert.equal(f.starts.length, 1);
});
