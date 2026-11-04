import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderTurnRetry, codexProviderFailure, pooledRetryAt, providerRetryDecision, type ProviderRetryPort, type ProviderRetry } from "@opencraft/host-recovery";

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

test("temporary admission pause retains a wakeup without requiring a browser event", async t => {
  const directory = await mkdtemp(join(tmpdir(), "provider-retry-admission-"));
  let open = true, sends = 0;
  const owner = new ProviderTurnRetry(directory, { serialize: async (_id, work) => work(), inspect: async row => ({ failure: row.failure }),
    continue: async (_row, _current, admit) => { if (!admit()) return null; sends++; return "continued"; }, changed() {} }, Date.now, () => 0, () => open);
  t.after(async () => { await owner.close(); await rm(directory, { recursive: true, force: true }); });
  // This due time reaches the send boundary immediately; admission pauses before it can run.
  (owner as any).now = () => 1000;
  owner.failed("t", "initial", { kind: "overloaded" });
  (owner as any).now = () => 10_000;
  open = false;
  await owner.recover();
  assert.equal(sends, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  open = true;
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(sends, 1, "resume admission must not depend on a new View or native event");
});
