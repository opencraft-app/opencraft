import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";

for (const [method, reason] of [["thread/archived", "archived"], ["thread/deleted", "not-found"]] as const) test(`${method} retires a current Workbench Read before its held reply`, { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000,
    frameScheduler: { schedule(run) { queueMicrotask(run); return () => {}; } }, onRecoveryEvent() {} });
  const unavailable: string[] = []; const remove = runtime.resources.threads.subscribeUnavailable?.((_id, why) => unavailable.push(why));
  let restoring: Promise<unknown> | undefined;
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush();
    assert.equal(view.getSnapshot().authoritative, true); const generation = runtime.getSnapshot().connectionGeneration;
    f.hold = true; let settled = false; restoring = view.retryRestore().then(() => { settled = true; }, () => { settled = true; }); await flush();
    assert.ok(f.held.length > 0); f.emit(method, { threadId: "a" }); await flush();
    assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), reason, "resource authority cannot wait for a historical reply");
    assert.deepEqual(unavailable, [reason]); assert.equal(settled, true, "local restore must retire without remote completion");
    assert.equal(runtime.getSnapshot().phase, "ready"); assert.equal(runtime.getSnapshot().connectionGeneration, generation);
    await assert.rejects(view.interrupt("known-turn"));
    f.hold = false; f.release(); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), reason);
    view.release();
  } finally { remove?.(); f.hold = false; f.release(); await runtime.dispose(); await restoring; }
});

test("one Session Read cannot hold global native observers or a peer Session projection", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "notification-ownership", version: "1" } });
  const a = await createCordisThreadSessionRuntime({ client }), b = await createCordisThreadSessionRuntime({ client });
  const controller = new AbortController(); const native: string[] = [];
  const remove = client.subscribeNotification(n => { if (n.method === "thread/status/changed") native.push(n.method); });
  let reading: Promise<unknown> | undefined;
  try {
    await a.resume.read("a"); await b.resume.read("a"); const revision = a.views.get("a")!.notificationRevision;
    f.hold = true; reading = a.resume.read("a", { signal: controller.signal }).catch(() => undefined); await flush();
    f.emit("thread/status/changed", { threadId: "a", status: { type: "active", activeFlags: [] } }); await flush();
    assert.deepEqual(native, ["thread/status/changed"]); assert.deepEqual(b.views.get("a")?.thread?.status, { type: "active", activeFlags: [] });
    assert.equal(a.views.get("a")?.notificationRevision, revision, "only the reading Session's historical projector remains buffered");
    controller.abort(); await reading; f.hold = false; f.release(); await flush();
    assert.equal(native.length, 1, "discarding or releasing one historical projection cannot replay the global native event");
    assert.deepEqual(b.views.get("a")?.thread?.status, { type: "active", activeFlags: [] });
  } finally { remove(); controller.abort(); f.hold = false; f.release(); await reading; await a.dispose(); await b.dispose(); await client.close(); }
});

test("buffered projector failures preserve Client error isolation and the next projection", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "notification-errors", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client }); const errors: Error[] = [], native: string[] = [], projected: string[] = [];
  const removeError = client.subscribeProtocolError(e => errors.push(e));
  const removeNative = client.subscribeNotification(n => { if (n.method.startsWith("fixture/")) native.push(n.method); });
  const removeProjector = session.notificationProjectors.register({ name: "synthetic-errors", priority: 1000, project(view, notification) {
    if (notification.method === "fixture/bad") throw Error("Synthetic projector failure");
    if (notification.method === "fixture/good") projected.push(notification.method); return view;
  } });
  let reading: Promise<unknown> | undefined;
  try {
    await session.resume.read("a"); f.hold = true; reading = session.resume.read("a"); await flush();
    f.emit("fixture/bad", { threadId: "a" }); f.emit("fixture/good", { threadId: "a" }); await flush();
    assert.deepEqual(native, ["fixture/bad", "fixture/good"]); assert.deepEqual(projected, []); assert.equal(errors.length, 0);
    f.hold = false; f.release(); await reading; await flush();
    assert.deepEqual(projected, ["fixture/good"]); assert.equal(errors.length, 1); assert.match(errors[0]!.message, /notification listener failed/);
    assert.equal(native.length, 2, "releasing projections cannot republish global native observations");
  } finally { f.hold = false; f.release(); await reading?.catch(() => undefined); removeProjector(); removeNative(); removeError(); await session.dispose(); await client.close(); }
});

test("native restoration and a later deletion cannot be replaced by a late historical success", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000, onRecoveryEvent() {} });
  let restoring: Promise<unknown> | undefined;
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush();
    f.emit("thread/archived", { threadId: "a" }); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), "archived");
    f.hold = true; f.emit("thread/unarchived", { threadId: "a" }); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null);
    let settled = false; restoring = view.retryRestore().then(() => { settled = true; }, () => { settled = true; }); await flush(); assert.ok(f.held.length > 0);
    f.emit("thread/deleted", { threadId: "other" }); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null); assert.equal(settled, false);
    f.emit("thread/deleted", { threadId: "a" }); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), "not-found"); assert.equal(settled, true);
    f.hold = false; f.release(); await flush(); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), "not-found"); view.release();
  } finally { f.hold = false; f.release(); await runtime.dispose(); await restoring; }
});


test("a canonical reread keeps non-snapshot Hook start/completion while native observers see them once", async () => {
  let peer!: import("@opencraft/appserver-transport-memory").InMemoryAppServerPeer, reads = 0, release!: () => void;
  const turn = { id: "hook-turn", status: "completed", items: [], itemsView: "full", error: null };
  const transport = new MemoryTransport({ receive(frame, current) {
    peer = current; const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
    const reply = (result: unknown) => current.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") reply({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "non-snapshot-projections", capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } });
    else if (request.method === "thread/read") { reads++; const send = () => reply({ thread: { id: "a", cwd: "/fixture", turns: [], historyMode: "paginated" }, initialTurnsPage: { data: [turn], nextCursor: null } }); if (reads === 2) release = send; else send(); }
  } });
  const client = new JsonRpcAppServerClient({ hostId: "h", transport }); await client.connect({ clientInfo: { name: "hooks", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client }), native: string[] = [];
  const remove = client.subscribeNotification(n => { if (n.method.startsWith("hook/")) native.push(n.method); });
  const run = { id: "hook", eventName: "afterToolUse", source: "project", status: "running", startedAt: 1, completedAt: null, entries: [] };
  let reading: Promise<unknown> | undefined;
  try {
    await session.resume.read("a"); reading = session.resume.read("a"); await flush();
    const emit = (method: string, params: unknown) => peer.send(encodeJsonRpcMessage({ method, params }));
    emit("hook/started", { threadId: "a", turnId: turn.id, run });
    emit("turn/started", { threadId: "a", turn: { ...turn, status: "inProgress" } });
    emit("hook/completed", { threadId: "a", turnId: turn.id, run: { ...run, status: "completed", completedAt: 2 } }); await flush();
    assert.deepEqual(native, ["hook/started", "hook/completed"]); release(); await reading;
    const view = session.views.get("a")!, result = view.turns[0] as typeof turn & { hookRuns?: { id: string; run: { status: string } }[] };
    assert.equal(reads, 3); assert.equal(result.status, "completed"); assert.deepEqual(result.hookRuns?.map(hook => [hook.id, hook.run.status]), [["hook", "completed"]]);
    assert.equal(native.length, 2);
  } finally { release?.(); await reading?.catch(() => undefined); remove(); await session.dispose(); await client.close(); }
});

test("a reentrant native restoration retains its successor while archive retires the previous Read", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(run => run()), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000, onRecoveryEvent() {} });
  let previous: Promise<unknown> | undefined, successor: Promise<unknown> | undefined, remove = () => {};
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush(); f.hold = true;
    let oldSettled = false, newSettled = false;
    previous = view.retryRestore().then(() => { oldSettled = true; }, () => { oldSettled = true; }); await flush();
    remove = runtime.resources.threads.subscribeUnavailable?.((_id, reason) => {
      if (reason !== "archived") return;
      f.emit("thread/unarchived", { threadId: "a" });
      successor = view.retryRestore().then(() => { newSettled = true; }, () => { newSettled = true; });
    }) ?? (() => {});
    f.emit("thread/archived", { threadId: "a" }); await flush();
    assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null); assert.equal(oldSettled, true); assert.ok(successor); assert.equal(newSettled, false); assert.ok(f.reads >= 3);
    f.hold = false; f.release(); await successor; await flush();
    assert.equal(view.getSnapshot().authoritative, true); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null); view.release();
  } finally { remove(); f.hold = false; f.release(); await runtime.dispose(); await previous; await successor; }
});


test("native resource restoration schedules current history for an already retained View", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, onRecoveryEvent() {} });
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush();
    const generation = runtime.getSnapshot().connectionGeneration;
    f.emit("thread/archived", { threadId: "a" }); await flush(); f.hold = true;
    f.emit("thread/unarchived", { threadId: "a" }); await flush();
    assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null); assert.equal(f.reads, 2, "availability restoration must schedule the retained View without reselecting its route");
    f.emit("thread/unarchived", { threadId: "a" }); await flush(); assert.equal(f.reads, 2, "duplicate availability is not a new recovery epoch");
    f.hold = false; f.release(); await flush(); assert.equal(view.getSnapshot().authoritative, true); assert.equal(runtime.getSnapshot().connectionGeneration, generation); view.release();
  } finally { f.hold = false; f.release(); await runtime.dispose(); }
});

test("an old unarchive ACK cannot override a newer native deletion", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, onRecoveryEvent() {} });
  let restoring: Promise<unknown> | undefined;
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); view.setRecoveryVisibility(true); await flush();
    f.emit("thread/archived", { threadId: "a" }); await flush(); f.hold = true;
    restoring = runtime.resources.threads.unarchive!("a"); await flush(); assert.equal(f.held.length, 1);
    f.emit("thread/deleted", { threadId: "a" }); await flush(); f.hold = false; f.release(); await restoring; await flush();
    assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), "not-found"); assert.equal(f.reads, 1, "stale ACK must not admit another resource Read"); view.release();
  } finally { f.hold = false; f.release(); await runtime.dispose(); await restoring; }
});

test("restoring a cached resource without View demand does not manufacture a Read", { timeout: 5000 }, async () => {
  const f = executionChannelsFixture(), runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, onRecoveryEvent() {} });
  try {
    await runtime.connect(); const view = await runtime.acquireThread("a"); await flush(); view.release();
    f.emit("thread/archived", { threadId: "a" }); await flush(); f.emit("thread/unarchived", { threadId: "a" }); await flush();
    assert.equal(f.reads, 1); assert.equal(runtime.resources.threads.getUnavailableReason?.("a"), null);
    const next = await runtime.acquireThread("a"); await flush(); assert.equal(f.reads, 2); assert.equal(next.getSnapshot().authoritative, true); next.release();
  } finally { f.hold = false; f.release(); await runtime.dispose(); }
});
