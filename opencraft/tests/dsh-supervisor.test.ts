import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { DshSupervisor } from "../apps/local-agent-host/src/dsh-supervisor.js";
import { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
import { createServer } from "node:http";
import { DshRestartBudget } from "../apps/local-agent-host/src/dsh-restart-budget.js";
const executable = resolve("tests/fixtures/dsh-supervisor-runtime.mjs");

test("brief readiness does not reset a repeated-crash budget", () => {
  const budget = new DshRestartBudget(3, 100);
  for (let n = 0; n < 3; n++) {
    budget.ready(n * 10); budget.begin(n * 10 + 1);
    assert.equal(budget.take(), true);
  }
  budget.ready(40); budget.begin(41);
  assert.equal(budget.take(), false);
  budget.ready(50); budget.begin(151);
  assert.equal(budget.take(), true);
});

test("startup failure releases ownership and allows retry", async () => {
  const supervisor = new DshSupervisor({ executable, dataDirectory: "/tmp/early-exit" });
  await assert.rejects(supervisor.start(), /before startup/);
  await assert.rejects(supervisor.start(), /before startup/);
  await supervisor.stop();
});
test("startup timeout escalates shutdown of an uncooperative child", async () => {
  const supervisor = new DshSupervisor({ executable, dataDirectory: "/tmp/timeout", startupTimeoutMs: 200, shutdownTimeoutMs: 50 });
  const start = Date.now();
  await assert.rejects(supervisor.start(), /Timed out/);
  assert.ok(Date.now() - start < 3000);
  await supervisor.stop();
});
test("unexpected post-start exit is reported, intentional stop is not", async () => {
  let report!: (error: Error) => void;
  const exited = new Promise<Error>(resolve => { report = resolve; });
  const supervisor = new DshSupervisor({ executable, dataDirectory: "/tmp/late-exit", onUnexpectedExit: report });
  await supervisor.start();
  assert.match((await exited).message, /during execution/);
  const reports: Error[] = [];
  const normal = new DshSupervisor({ executable, dataDirectory: "/tmp/ready", onUnexpectedExit: error => reports.push(error) });
  await normal.start();
  await normal.stop();
  assert.deepEqual(reports, []);
});
test("stalled DSH RPC has a bounded timeout", async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const client = new DshClient(`http://127.0.0.1:${address.port}`, 30);
    await assert.rejects(client.call("host.describe"), /timeout|aborted/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("caller cancellation does not replace the DSH RPC deadline", async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const lifetime = new AbortController();
  try {
    const address = server.address() as { port: number };
    const client = new DshClient(`http://127.0.0.1:${address.port}`, 30);
    const outcome = await Promise.race([
      client.call("session.history", {}, lifetime.signal).then(
        () => "resolved",
        error => error,
      ),
      new Promise<"still pending">(resolve => setTimeout(() => resolve("still pending"), 150)),
    ]);

    assert.notEqual(outcome, "still pending");
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /timeout|aborted/i);
    assert.equal(lifetime.signal.aborted, false);
  } finally {
    lifetime.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
