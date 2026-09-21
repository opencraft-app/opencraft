import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { DshRoutedClient } from "../apps/local-agent-host/src/dsh-routed-client.js";
import { DshSessionRouting } from "../apps/local-agent-host/src/dsh-session-routing.js";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import { historyBoundary, readTurnWindow } from "../apps/local-agent-host/src/dsh-history-window.js";

test("native message pages are not repaginated into 100-event index refreshes", async () => {
  let reads = 0;
  const events: any[] = [];
  const push = (type: string, data: any) => events.push({ event: { seq: events.length, time: 1000, type, data } });
  for (let turn = 0; turn < 10; turn++) {
    push("turn/start", { turn });
    push("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] });
    for (let n = 0; n < 12000; n++) push("assistant/chunk", { turn, chunk: { type: "text-delta", text: "x" } });
    push("assistant/message", { turn, message: { content: [{ type: "text", text: "x".repeat(12000) }] } });
    push("compaction/prune", { turn: -17 });
    push("turn/end", { turn, reason: { kind: "completed" } });
  }
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const { method, payload } = JSON.parse(text);
    assert.equal(method, "session.history"); reads++;
    const rows = events.filter(e => payload.beforeSeq === undefined || e.event.seq < payload.beforeSeq);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { ok: true, value: { events: rows, hasMore: false } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const routing = new DshSessionRouting(":memory:");
  const client = new DshRoutedClient(`http://127.0.0.1:${(server.address() as any).port}`, routing);
  const adapter = new DshAppServerAdapter(client);
  (adapter as any).summaries.set("s", { sessionId: "s", running: false, cwd: "/", updatedAt: 1 });
  let activations = 0;
  adapter.setThreadEngine({
    describe: async () => ({ selection: { provider: "p", model: "m" }, permissions: {
      approval: "ask", sandbox: { mode: "workspace-write", workspaceRoot: "/" }, preset: "custom",
    } }),
    resume: async () => { activations++; throw new Error("Display must not activate"); },
    create: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {},
  });
  try {
    const started = performance.now();
    const result: any = await adapter.dispatch("thread/resume", { threadId: "s", excludeTurns: true,
      initialTurnsPage: { limit: 2, sortDirection: "desc", itemsView: "full" } });
    assert.equal(activations, 0);
    assert.equal(reads, 1);
    assert.deepEqual(result.initialTurnsPage.data.map((t: any) => t.id), ["dsh-turn-s-9", "dsh-turn-s-8"]);
    assert.equal(result.initialTurnsPage.data[0].items.find((i: any) => i.type === "agentMessage").text.length, 12000);
    const cursor = result.initialTurnsPage.nextCursor;
    assert.ok(historyBoundary("s", cursor)! > 0);
    const older: any = await adapter.dispatch("thread/turns/list", { threadId: "s", cursor, limit: 2 });
    assert.deepEqual(older.data.map((t: any) => t.id), ["dsh-turn-s-7", "dsh-turn-s-6"]);
    assert.equal(reads, 2);
    console.log(JSON.stringify({ jitHistoryEvents: events.length, nativeRequests: reads, elapsedMs: Math.round(performance.now() - started) }));
  } finally { adapter.close(); routing.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("concurrent runtime activation shares one flight and can retry after failure", async () => {
  const adapter = new DshAppServerAdapter({} as any);
  let calls = 0;
  let reject!: (error: Error) => void;
  adapter.setThreadEngine({ resume: async () => { calls++; await new Promise((_, fail) => { reject = fail; }); },
    create: async () => {}, fork: async () => {}, inject: async () => {}, release: async () => {} });
  try {
    const first = adapter.activateThread("s");
    const second = adapter.activateThread("s");
    assert.equal(first, second);
    reject(new Error("fixture activation failed"));
    await assert.rejects(first, /fixture/);
    const retry = adapter.activateThread("s");
    assert.equal(calls, 2);
    reject(new Error("fixture retry failed"));
    await assert.rejects(retry, /fixture/);
  } finally { adapter.close(); }
});

test("model description distinguishes product binding, live pick, history, default and absence", async () => {
  let modelReads = 0, defaultReads = 0;
  const adapter = new DshAppServerAdapter({ call: async (method: string) => {
    if (method === "session.models") { modelReads++; return { current: { provider: "live", model: "picked", reasoningEffort: "high" } }; }
    assert.equal(method, "settings.describe"); defaultReads++;
    return { namespaces: defaultReads === 1 ? [{ ns: "agent-default-model", value: { provider: "default", model: "configured" } }] : [] };
  } } as any);
  try {
    const read = (model: unknown, description: any) => (adapter as any).describedModel("s", model, description);
    assert.deepEqual((await read("dsh-model:saved:blank", { loaded: false })).current, { provider: "saved", model: "blank" });
    assert.equal(modelReads, 0); assert.equal(defaultReads, 0);
    assert.equal((await read(undefined, { loaded: true, selection: { provider: "old", model: "logged" } })).current.model, "picked");
    assert.equal((await read("dsh-model:live:picked", { loaded: true })).current.reasoningEffort, "high");
    const logged = { provider: "history", model: "used" };
    assert.deepEqual((await read(undefined, { loaded: false, selection: logged })).current, logged);
    assert.equal((await read("dsh", { loaded: false })).current.model, "configured");
    assert.equal((await read(undefined, { loaded: false })).current, undefined);
    assert.equal(modelReads, 2);
  } finally { adapter.close(); }
});

test("tail window stops once complete Turn boundaries are covered and rejects foreign cursors", async () => {
  let calls = 0;
  const result = await readTurnWindow(async before => {
    calls++;
    if (before === undefined) return { events: [{ event: { seq: 101, time: 1, type: "turn/end", data: { turn: 8 } } }], hasMore: true };
    assert.equal(before, 101);
    return { events: [{ event: { seq: 100, time: 1, type: "turn/start", data: { turn: 8 } } }], hasMore: true };
  }, undefined, 1);
  assert.equal(calls, 2);
  assert.equal(result.nextBefore, 100);
  assert.throws(() => historyBoundary("other", encodeURIComponent(JSON.stringify({version:2,kind:"dsh-turns",threadId:"s",beforeSeq:100}))), /cursor/);
});

test("native generation pagination excludes copied seeds and continues into the original log", async () => {
  const routing = new DshSessionRouting(":memory:");
  routing.publish("s", { logicalId: "s", nativeId: "new", generation: 1, seedThroughSeq: 2,
    seedThroughTurn: 1, previousLastSeq: 9, previousLastTurn: 3 });
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const { payload } = JSON.parse(body); calls.push(payload);
    const values = payload.sessionId === "new" ? [0, 1, 2, 3, 4] : [7, 8, 9];
    res.end(JSON.stringify({ result: { ok: true, value: { events: values
      .filter(seq => payload.beforeSeq === undefined || seq < payload.beforeSeq)
      .map(seq => ({ event: { seq, time: 1, type: "fixture", data: {} }, view: { preserved: true } })), hasMore: false } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new DshRoutedClient(`http://127.0.0.1:${(server.address() as any).port}`, routing);
  try {
    const tail: any = await client.call("session.history", { sessionId: "s", maxMessages: 50 });
    assert.deepEqual(tail.events.map((e: any) => e.event.seq), [10, 11]);
    assert.equal(tail.hasMore, true);
    assert.deepEqual(tail.events[0].view, { preserved: true });
    const older: any = await client.call("session.history", { sessionId: "s", beforeSeq: 10, maxMessages: 50 });
    assert.deepEqual(older.events.map((e: any) => e.event.seq), [7, 8, 9]);
    assert.equal(older.hasMore, false);
    assert.deepEqual(calls.map(p => p.sessionId), ["new", "s"]);
  } finally { routing.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
