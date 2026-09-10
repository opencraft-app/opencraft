import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServer } from "@opencraft/appserver-transport-memory";

import {
  LabUsageError,
  labScenarioNames,
  parseLabArgs,
} from "../apps/appserver-lab/src/args";
import { FaultInjectingTransport } from "../apps/appserver-lab/src/fault-injecting-transport";
import { NotificationJournal } from "../apps/appserver-lab/src/notification-journal";
import { NdjsonReporter, preview } from "../apps/appserver-lab/src/reporter";
import { RequestJournal } from "../apps/appserver-lab/src/request-journal";

test("argument parser recognizes every documented TypeScript scenario", () => {
  for (const name of labScenarioNames) {
    const options = parseLabArgs(["scenario", name]);
    assert.deepEqual(options.command, { kind: "scenario", name });
  }
});

test("argument parser applies all numeric and transport options", () => {
  const options = parseLabArgs([
    "scenario", "concurrency",
    "--url", "ws://example.test/rpc",
    "--host", "durable",
    "--timeout-ms", "99",
    "--limit", "7",
    "--requests", "11",
    "--cycles", "4",
    "--thread", "thread-a",
    "--project-id", "project-a",
    "--inbound-latency-ms", "0",
    "--disconnect-after-ms", "0",
    "--record", "/tmp/lab.json",
  ]);
  assert.equal(options.url, "ws://example.test/rpc");
  assert.equal(options.hostId, "durable");
  assert.equal(options.timeoutMs, 99);
  assert.equal(options.limit, 7);
  assert.equal(options.requests, 11);
  assert.equal(options.cycles, 4);
  assert.equal(options.threadId, "thread-a");
  assert.equal(options.projectId, "project-a");
  assert.equal(options.inboundLatencyMs, 0);
  assert.equal(options.disconnectAfterMs, 0);
  assert.equal(options.recordPath, "/tmp/lab.json");
});

test("argument parser rejects ambiguous, malformed, and unknown input", () => {
  assert.throws(() => parseLabArgs(["scenario", "missing"]), LabUsageError);
  assert.throws(() => parseLabArgs(["scenario", "smoke", "--requests", "0"]), /positive integer/);
  assert.throws(() => parseLabArgs(["scenario", "smoke", "--cycles", "1.5"]), /positive integer/);
  assert.throws(() => parseLabArgs(["scenario", "smoke", "--unknown", "x"]), /Unknown option/);
  assert.throws(() => parseLabArgs(["scenario", "smoke", "--url"]), /Missing value/);
  assert.throws(
    () => parseLabArgs(["scenario", "smoke", "--record", "a", "--replay", "b"]),
    /mutually exclusive/,
  );
  assert.throws(() => parseLabArgs(["request", "thread/list", "{"]), /must be JSON/);
  assert.throws(() => parseLabArgs(["scenario", "smoke", "garbage"]), /unexpected arguments/);
  assert.throws(() => parseLabArgs(["request", "thread\/list", "{}", "garbage"]), /unexpected arguments/);
});

test("raw request command preserves typed JSON values", () => {
  const options = parseLabArgs(["request", "thread/list", "{\"limit\":3,\"archived\":false}"]);
  assert.deepEqual(options.command, {
    kind: "request",
    method: "thread/list",
    params: { limit: 3, archived: false },
  });
});

test("notification journal bounds samples without losing exact counts", () => {
  const journal = new NotificationJournal(2);
  assert.equal(journal.handle({ method: "turn/delta", params: { index: 1 } }).emitSample, true);
  assert.equal(journal.handle({ method: "turn/delta", params: { index: 2 } }).emitSample, true);
  const third = journal.handle({ method: "turn/delta", params: { index: 3 } });
  assert.equal(third.emitSample, false);
  assert.equal(third.emitSuppressedMarker, true);
  journal.handle({ method: "thread/updated", params: { id: "a" } });
  assert.deepEqual(journal.getSnapshot(), [
    { method: "turn/delta", count: 3, samples: [{ index: 1 }, { index: 2 }] },
    { method: "thread/updated", count: 1, samples: [{ id: "a" }] },
  ]);
});

function started(id: string, method = "thread/list"): AppServerRequestLifecycleEvent {
  return {
    type: "started",
    id,
    hostId: "local",
    method,
    priority: "background",
    startedAtMs: 2,
    queueWaitMs: 1,
    params: { cursor: null },
    timeoutMs: 100,
  };
}

test("request journal is bounded newest-first and projects completion", () => {
  const journal = new RequestJournal(2);
  journal.handle(started("one"));
  journal.handle(started("two"));
  journal.handle(started("three"));
  journal.handle({
    type: "completed",
    id: "three",
    hostId: "local",
    method: "thread/list",
    priority: "background",
    endedAtMs: 9,
    durationMs: 7,
    result: { data: [] },
  });
  const snapshot = journal.getSnapshot();
  assert.deepEqual(snapshot.map((entry) => entry.id), ["three", "two"]);
  assert.equal(snapshot[0]?.status, "completed");
  assert.deepEqual(snapshot[0]?.resultPreview, { data: [] });
});

test("request journal projects timeout, abort, and failure separately", () => {
  const journal = new RequestJournal(3);
  for (const id of ["timeout", "abort", "failure"]) journal.handle(started(id));
  for (const [id, type] of [
    ["timeout", "timed-out"],
    ["abort", "aborted"],
    ["failure", "failed"],
  ] as const) {
    journal.handle({
      type,
      id,
      hostId: "local",
      method: "thread/list",
      priority: "background",
      endedAtMs: 10,
      durationMs: 8,
      error: new Error(type),
    });
  }
  const byId = new Map(journal.getSnapshot().map((entry) => [entry.id, entry]));
  assert.equal(byId.get("timeout")?.status, "timed-out");
  assert.equal(byId.get("abort")?.status, "aborted");
  assert.equal(byId.get("failure")?.status, "failed");
});

test("reporter emits monotonic NDJSON and safely serializes errors", () => {
  const lines: string[] = [];
  const reporter = new NdjsonReporter({ write: (line) => lines.push(line) }, { now: () => 42 });
  reporter.emit("first", { error: Object.assign(new Error("boom"), { code: "E_BOOM" }) });
  reporter.emit("second", { value: 2n });
  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(entries[0]?.error, { name: "Error", message: "boom", code: "E_BOOM" });
  assert.equal(entries[1]?.value, "2");
});

test("preview truncates large payloads and terminates circular graphs", () => {
  assert.equal((preview("x".repeat(100), 10) as { truncated: boolean }).truncated, true);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.deepEqual(preview(circular), { self: "[Circular]" });
});

test("preview distinguishes shared references from actual cycles", () => {
  const shared = { value: 1 };
  assert.deepEqual(preview({ first: shared, second: shared }), {
    first: { value: 1 },
    second: { value: 1 },
  });
});

test("preview terminates circular arrays", () => {
  const circular: unknown[] = [];
  circular.push(circular);
  assert.deepEqual(preview(circular), ["[Circular]"]);
});

test("preview remains total for function, symbol, and undefined diagnostics", () => {
  const namedFunction = function diagnosticCallback(): void {};
  assert.equal(preview(namedFunction), "[Function diagnosticCallback]");
  assert.equal(preview(Symbol.for("lab")), "Symbol(lab)");
  assert.equal(preview(undefined), null);
});

test("fault transport blackhole drops inbound frames and can be restored", async () => {
  const server: InMemoryAppServer = { receive: (_frame, peer) => peer.send("reply") };
  const transport = new FaultInjectingTransport({ transport: new MemoryTransport(server) });
  const messages: string[] = [];
  transport.subscribeMessage((frame) => messages.push(frame));
  await transport.connect();
  transport.setInboundBlackhole(true);
  await transport.send("one");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.deepEqual(messages, []);
  transport.setInboundBlackhole(false);
  await transport.send("two");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.deepEqual(messages, ["reply"]);
  await transport.close();
});

test("fault transport disconnect cancels delayed inbound delivery", async () => {
  const server: InMemoryAppServer = { receive: (_frame, peer) => peer.send("late") };
  const transport = new FaultInjectingTransport({
    transport: new MemoryTransport(server),
    inboundLatencyMs: 15,
  });
  const messages: string[] = [];
  transport.subscribeMessage((frame) => messages.push(frame));
  await transport.connect();
  await transport.send("one");
  await transport.disconnect();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  assert.deepEqual(messages, []);
});
