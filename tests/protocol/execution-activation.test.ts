import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClientError, JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const aborted = (error: unknown) => error instanceof AppServerClientError && error.code === "ABORTED";
const turn = (tag: string) => ({ id: `turn-${tag}`, status: "completed", itemsView: "full", items: [{ id: `item-${tag}`, type: "agentMessage", text: tag }], error: null });
async function fixture(ignoreCancellation = false) {
  let peer!: InMemoryAppServerPeer, reads = 0, holdReads = false;
  const actors: { reply(): void; fail(): void; params: unknown }[] = [], heldReads: (() => void)[] = [], serverResponses: unknown[] = [];
  const thread = (name: string) => ({ id: "a", sessionId: "a", path: "/fixture/a", cwd: "/persisted", historyMode: "paginated", name, turns: [], model: "persisted-model", modelProvider: "fixture" });
  const transport = new MemoryTransport({ receive(frame, currentPeer) {
    peer = currentPeer; const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) { serverResponses.push(request); return; }
    const send = (result: unknown) => peer.send(encodeJsonRpcMessage({ id: request.id, result }));
    if (request.method === "initialize") send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "activation-test", capabilities: { extensions: { "opencraft/read-history": { version: 1 }, "opencraft/resume-history": { version: 1, initialTurnsPage: true } } } });
    else if (request.method === "thread/read") {
      const index = ++reads, reply = () => send({ thread: thread(`read-${index}`), initialTurnsPage: { data: [turn(`read-${index}`)], nextCursor: "older" } });
      if (holdReads) heldReads.push(reply); else reply();
    } else if (request.method === "thread/resume") {
      const index = actors.length + 1;
      actors.push({ params: request.params, reply: () => send({ thread: { ...thread(`stale-activation-${index}`), turns: [turn("stale-activation-history")] },
        model: `activation-${index}`, modelProvider: "fixture", cwd: "/live", runtimeWorkspaceRoots: ["/live"], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: {},
        initialTurnsPage: { data: [turn("stale-activation-history")], nextCursor: null }, historyRecovery: { invalid: true } }),
        fail: () => peer.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32000, message: "activation denied" } })) });
    } else if (request.method === "thread/turns/list") send({ data: [turn("older-read")], nextCursor: null });
    else send({});
  } });
  const client = new JsonRpcAppServerClient({ hostId: "activation-test", transport });
  await client.connect({ clientInfo: { name: "activation-test", version: "1" }, capabilities: {} });
  if (ignoreCancellation) {
    const request = client.request.bind(client);
    client.request = ((method, params, options) => request(method, params, method === "thread/resume" ? { ...options, signal: undefined } : options)) as typeof client.request;
  }
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "paginated", requestTimeoutMs: 60_000 });
  await session.resume.read("a");
  return { session, client, actors, heldReads, serverResponses, reads: () => reads, holdReads: () => { holdReads = true; },
    notify: (method: string, params: unknown, id?: string) => peer.send(encodeJsonRpcMessage({ method, params, ...(id ? { id } : {}) })),
    releaseReads() { holdReads = false; for (const reply of heldReads.splice(0)) reply(); },
    async close() { for (const a of actors) a.reply(); for (const reply of heldReads.splice(0)) reply(); await session.dispose(); await client.close(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 30 && !check(); i++) await flush(); assert.equal(check(), true); }
test("execution activation preserves a fresh read, metadata and its older-page source", async () => {
  const f = await fixture(); let strategyCalls = 0;
  f.session.historyStrategies.register({ name: "must-not-hydrate", priority: 10_000, matches: () => true, async load() { strategyCalls++; throw Error("unexpected history hydration"); } });
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 1);
    const params = f.actors[0]!.params as Record<string, unknown>; assert.equal(params.excludeTurns, true); assert.equal(params.initialTurnsPage, undefined); assert.equal(params.historyPreviewToken, undefined);
    f.session.resume.markNeedsResume("a"); await f.session.resume.read("a"); assert.equal(f.reads(), 2);
    f.actors[0]!.reply(); await activating;
    const view = f.session.views.get("a")!; assert.equal(view.thread?.name, "read-2"); assert.equal(view.execution.model, "activation-1");
    assert.match(JSON.stringify(view.turns), /read-2/); assert.doesNotMatch(JSON.stringify(view.turns), /stale-activation/); assert.equal(strategyCalls, 0);
    await f.session.resume.loadOlder("a"); assert.match(JSON.stringify(f.session.views.get("a")!.turns), /older-read/);
  } finally { await f.close(); }
});
for (const ignored of [false, true]) test(`cancelled activation fences late ACK and preserves its read/successor (ignored=${ignored})`, async () => {
  const f = await fixture(ignored), controller = new AbortController();
  try {
    const first = f.session.resume.activate({ threadId: "a", signal: controller.signal }); const rejected = assert.rejects(first, aborted);
    await until(() => f.actors.length === 1); f.holdReads(); const reading = f.session.resume.read("a"); await until(() => f.heldReads.length === 1);
    controller.abort(); await rejected;
    const next = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 2);
    f.releaseReads(); await reading; f.actors[1]!.reply(); await next; f.actors[0]!.reply(); for (let i = 0; i < 5; i++) await flush();
    assert.equal(f.session.views.get("a")!.execution.model, "activation-2"); assert.match(JSON.stringify(f.session.views.get("a")!.turns), /read-2/);
    assert.equal(f.session.views.get("a")!.historyError, null);
  } finally { await f.close(); }
});
test("activation coalesces while a joining signal cancels only its own wait", async () => {
  const f = await fixture(), controller = new AbortController(); let settled = false;
  try {
    const first = f.session.resume.activate({ threadId: "a" }); const observed = first.then(() => { settled = true; });
    assert.equal(f.session.resume.activate({ threadId: "a" }), first);
    const joined = f.session.resume.activate({ threadId: "a", signal: controller.signal }); const rejected = assert.rejects(joined, aborted);
    await until(() => f.actors.length === 1); controller.abort(); await rejected; assert.equal(settled, false);
    f.actors[0]!.reply(); await observed; await f.session.resume.activate({ threadId: "a" }); assert.equal(f.actors.length, 1);
  } finally { await f.close(); }
});
test("preaborted activation admits no execution request", async () => {
  const f = await fixture(), controller = new AbortController();
  try { controller.abort(); await assert.rejects(f.session.resume.activate({ threadId: "a", signal: controller.signal }), aborted); assert.equal(f.actors.length, 0); }
  finally { await f.close(); }
});
test("activation failure preserves readable history and its error projection", async () => {
  const f = await fixture();
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); const rejected = assert.rejects(activating, /activation denied/);
    await until(() => f.actors.length === 1); f.actors[0]!.fail(); await rejected;
    assert.equal(f.session.views.get("a")!.resumeError, null); assert.equal(f.session.views.get("a")!.historyError, null);
    await f.session.resume.read("a"); assert.match(JSON.stringify(f.session.views.get("a")!.turns), /read-2/);
    await assert.rejects(f.session.resume.activate({ threadId: "a" }), /activation denied/); assert.equal(f.actors.length, 1);
  } finally { await f.close(); }
});
for (const failed of [false, true]) test(`activation ${failed ? "error" : "ACK"} cannot release the current read buffer`, async () => {
  const f = await fixture(); let delivered = 0, observations = 0, projected = 0;
  const removeProjector = f.session.notificationProjectors.register({ name: "activation-buffer-probe", priority: 1000, project(view, notification) { if (notification.method === "fixture/observation") projected++; return view; } });
  f.client.subscribeNotification(n => { if (n.method === "fixture/observation") observations++; });
  f.client.interceptServerRequest(async (request, next) => { if (request.method !== "fixture/interaction") return next(); delivered++; return { ok: true }; });
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); const outcome = activating.catch(() => undefined); await until(() => f.actors.length === 1);
    f.holdReads(); const reading = f.session.resume.read("a"); await until(() => f.heldReads.length === 1);
    f.notify("fixture/interaction", { threadId: "a" }, "server-request"); f.notify("fixture/observation", { threadId: "a" });
    for (let i = 0; i < 4; i++) await flush(); assert.equal(delivered, 1); assert.equal(observations, 1); assert.equal(projected, 0);
    if (failed) f.actors[0]!.fail(); else f.actors[0]!.reply(); await outcome; assert.equal(delivered, 1); assert.equal(observations, 1); assert.equal(projected, 0);
    f.releaseReads(); await reading; await until(() => delivered === 1); await until(() => f.serverResponses.some(value => (value as { id?: unknown }).id === "server-request"));
    assert.equal(delivered, 1); assert.equal(observations, 1); assert.equal(projected, 1);
  } finally { removeProjector(); await f.close(); }
});
test("a held older read cannot overwrite accepted execution metadata", async () => {
  const f = await fixture();
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 1);
    f.holdReads(); const reading = f.session.resume.read("a"); await until(() => f.heldReads.length === 1);
    f.actors[0]!.reply(); await activating; f.releaseReads(); await reading;
    assert.equal(f.session.views.get("a")!.execution.model, "activation-1"); assert.equal(f.session.views.get("a")!.execution.cwd, "/live");
  } finally { await f.close(); }
});
test("execution settings observed during activation survive its older ACK projection", async () => {
  const f = await fixture();
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 1);
    f.notify("thread/settings/updated", { threadId: "a", threadSettings: { model: "live-choice", effort: "high" } });
    await until(() => f.session.views.get("a")!.execution.model === "live-choice");
    f.actors[0]!.reply(); await activating; assert.equal(f.session.views.get("a")!.execution.model, "live-choice"); assert.equal(f.session.views.get("a")!.execution.reasoningEffort, "high");
    assert.equal(f.session.views.get("a")!.execution.cwd, "/live", "ACK still supplies fields without newer settings");
  } finally { await f.close(); }
});


test("an explicit unchanged setting during activation still supersedes the ACK field", async () => {
  const f = await fixture();
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 1);
    f.notify("thread/settings/updated", { threadId: "a", threadSettings: { model: "persisted-model" } });
    for (let i = 0; i < 4; i++) await flush(); f.actors[0]!.reply(); await activating;
    assert.equal(f.session.views.get("a")!.execution.model, "persisted-model"); assert.equal(f.session.views.get("a")!.execution.cwd, "/live");
  } finally { await f.close(); }
});
test("read metadata cannot erase observed live settings before activation acknowledges", async () => {
  const f = await fixture();
  try {
    const activating = f.session.resume.activate({ threadId: "a" }); await until(() => f.actors.length === 1);
    f.notify("thread/settings/updated", { threadId: "a", threadSettings: { model: "live-choice" } });
    await until(() => f.session.views.get("a")!.execution.model === "live-choice");
    await f.session.resume.read("a"); assert.equal(f.session.views.get("a")!.execution.model, "live-choice");
    f.actors[0]!.reply(); await activating; assert.equal(f.session.views.get("a")!.execution.model, "live-choice");
  } finally { await f.close(); }
});
