import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { InterruptedTurnRecovery, RecoveryNotSubmitted, type TurnRecoveryPort } from "@opencraft/host-recovery";

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
