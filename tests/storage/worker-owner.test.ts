import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerOwner, WorkerOwnerUnavailable } from "../../packages/worker-owner/src/index.ts";
import { CounterError, type Counter } from "../fixtures/worker-owner/counter.ts";

const entry = new URL("../fixtures/worker-owner/counter.worker.ts", import.meta.url);
const open = (workerData: object = {}) =>
  WorkerOwner.open<Counter, { opened: boolean }>(entry, {
    name: "Counter storage",
    workerData,
    errors: [CounterError],
  });

test("calls run in the Worker in the order they were made", async (t) => {
  const { owner, ready } = await open();
  t.after(() => owner.close());
  assert.deepEqual(ready, { opened: true });
  // The slow call is first; a later fast call must not overtake it.
  const results = await Promise.all([owner.call.slowAdd(1, 30), owner.call.add(10), owner.call.add(100)]);
  assert.deepEqual(results, [1, 11, 111]);
});

test("a domain error keeps its class and fields, and the owner continues", async (t) => {
  const { owner } = await open();
  t.after(() => owner.close());
  const error = await owner.call.add(-1).catch((caught: unknown) => caught);
  assert.ok(error instanceof CounterError);
  assert.deepEqual([error.code, error.status, error.message], ["negative", 400, "negative"]);
  assert.equal(await owner.call.add(2), 2);
});

test("a fatal error fences the owner instead of letting callers continue", async (t) => {
  const failures: Error[] = [];
  const { owner } = await WorkerOwner.open<Counter>(entry, {
    name: "Counter storage",
    onFailure: (e) => failures.push(e),
  });
  t.after(() => owner.close());
  await assert.rejects(owner.call.lose(), /handle lost/);
  await assert.rejects(owner.call.add(1), WorkerOwnerUnavailable);
  assert.equal(failures.length, 1);
});

test("a Worker that exits rejects pending and later calls; nothing runs on the main thread", async (t) => {
  const { owner } = await open();
  t.after(() => owner.close());
  const crash = owner.call.crash();
  const queuedBehindCrash = owner.call.add(1);
  await assert.rejects(crash, WorkerOwnerUnavailable);
  await assert.rejects(queuedBehindCrash, WorkerOwnerUnavailable);
  await assert.rejects(owner.call.add(1), WorkerOwnerUnavailable);
  assert.ok(owner.unavailable);
});

test("close runs every earlier call, closes the owner, then refuses new calls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "worker-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closedMarker = join(directory, "closed");
  const { owner } = await open({ closedMarker });
  const earlier = owner.call.slowAdd(5, 30);
  const closed = owner.close();
  await assert.rejects(owner.call.add(1), /closed/);
  assert.equal(await earlier, 5);
  await closed;
  assert.equal(await readFile(closedMarker, "utf8"), "5", "the owner closed after the earlier call committed");
  assert.equal(owner.close(), owner.close(), "close is idempotent");
});

test("an owner that fails to open rejects open with its error", async () => {
  const error = await open({ refuse: true }).catch((caught: unknown) => caught);
  assert.ok(error instanceof CounterError);
  assert.equal(error.status, 503);
});

// A storage owner left open (for example, deliberately retained until process
// exit) must not keep the process alive by itself, as a SQLite handle would not.
test("an idle owner does not keep the process alive; a call in flight does", async () => {
  const { spawn } = await import("node:child_process");
  const script = `
    const { WorkerOwner } = await import(${JSON.stringify(new URL("../../packages/worker-owner/src/index.ts", import.meta.url).href)});
    const { owner } = await WorkerOwner.open(new URL(${JSON.stringify(entry.href)}), { name: "Counter storage" });
    const value = await owner.call.slowAdd(2, 200);
    console.log("answered " + value);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(output.trim(), "answered 2", "the in-flight call kept the process alive until it answered");
  assert.equal(code, 0, "the idle owner then let the process exit");
});
