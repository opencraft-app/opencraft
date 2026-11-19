import assert from "node:assert/strict";
import test from "node:test";
import { ReceiptReconciliation } from "../../packages/access-control/src/receipt-reconciliation";

test("health is independent from execution: slow probes continue after circuit recovery is required", () => {
  let now = 100;
  const health = new ReceiptReconciliation(() => now);
  assert.deepEqual(health.status("x"), { state: "ready" });
  for (let n = 1; n <= 3; n++) {
    const result = health.failed("x", { code: -32602, message: "secret" });
    assert.equal(result.failures, n);
    assert.equal(result.reason, "protocol");
    assert.equal(health.canAttempt("x"), false);
    assert.equal(result.nextAttemptAt - now, n === 3 ? 300_000 : n * 30_000);
    assert.equal(result.state, n === 3 ? "recovery_required" : "waiting");
    now = result.nextAttemptAt;
    assert.equal(health.canAttempt("x"), true);
  }
  assert.equal(health.canAttempt("another"), true);
  health.succeeded("x");
  assert.deepEqual(health.status("x"), { state: "ready" });
});

test("transient failures back off, authority changes are classified and returned hints are immutable copies", () => {
  let now = 0;
  const health = new ReceiptReconciliation(() => now);
  assert.equal(health.failed("x", Error("private")).nextAttemptAt, 1000);
  now = 1000;
  assert.equal(health.failed("x", Error("private")).nextAttemptAt, 3000);
  now = 3000;
  const value = health.failed("x", { status: 403 });
  assert.equal(value.reason, "authority");
  assert.equal(value.failures, 1);
  assert.equal(value.nextAttemptAt, 33_000);
  value.nextAttemptAt = 0;
  assert.equal(health.canAttempt("x"), false);
  const publicValue = health.status("x");
  if (publicValue.state !== "ready") publicValue.nextAttemptAt = 0;
  assert.equal(health.canAttempt("x"), false);
  assert.equal(JSON.stringify(health.status("x")).includes("private"), false);
});

test("request-health hints are bounded and discarded hints never create execution evidence", () => {
  const health = new ReceiptReconciliation(() => 0);
  for (let i = 0; i < 4097; i++) health.failed(String(i), { code: -32601 });
  assert.deepEqual(health.status("0"), { state: "ready" });
  assert.equal(health.status("4096").state, "waiting");
});

test("transient failures get a bounded retry window before slower recovery probes", () => {
  let now = 0;
  const health = new ReceiptReconciliation(() => now);
  for (let n = 1; n <= 8; n++) {
    const result = health.failed("network", { code: "ECONNRESET" });
    assert.equal(result.state, n === 8 ? "recovery_required" : "waiting");
    assert.equal(result.nextAttemptAt - now, n === 8 ? 300_000 : Math.min(30_000, 1000 * 2 ** (n - 1)));
    now = result.nextAttemptAt;
  }
});

test("invalid RPC is a protocol failure, not inferred credential revocation", () => {
  const health = new ReceiptReconciliation(() => 0);
  assert.equal(health.failed("invalid", { code: -32600 }).reason, "protocol");
  assert.equal(health.failed("denied", { code: -32602, status: 403 }).reason, "authority");
});
