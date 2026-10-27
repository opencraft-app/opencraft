import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { AppServerInteractionBroker, encodeServerRequestId } from "@opencraft/composer-appserver";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

import { executionChannelsFixture as fixture, flush } from "./fixtures/execution-channels";

for (const end of ["cancel", "complete"] as const) test(`history ${end} cannot own live settings or a native question`, { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window" });
  const broker = new AppServerInteractionBroker({ hostId: "h", client, store: session.views });
  const controller = new AbortController();
  let reading: Promise<unknown> | undefined;
  try {
    await session.resume.read("a"); await session.resume.activate({ threadId: "a" });
    f.hold = true; reading = session.resume.read("a", { signal: controller.signal }).catch(error => ({ code: error.code })); await flush();
    assert.equal(f.reads, 2); f.settings("live-new"); f.question(); await flush();
    assert.equal(session.views.get("a")?.execution.model, "live-new", "live execution metadata must be observed before Read settles");
    assert.equal(session.views.get("a")?.pendingInteractions.length, 1, "the execution question must be answerable while Read is held");
    if (end === "cancel") controller.abort(); else f.release(); await reading;
    await broker.respond({ hostId: "h", threadId: "a" }, { type: "question", requestId: encodeServerRequestId("question"), answers: { choice: ["yes"] } });
    await flush(); assert.deepEqual(f.replies, [{ id: "question", result: { answers: { choice: { answers: ["yes"] } } } }]);
    await session.resume.activate({ threadId: "a" }); assert.equal(f.activations, 1);
    assert.equal(session.views.get("a")?.execution.model, "live-new");
  } finally { controller.abort(); f.release(); await reading; broker.dispose(); await session.dispose(); await client.close(); }
});

test("legacy full Resume ACK preserves live fields observed during its history wait", { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client, historyModeHint: "message-window" });
  try {
    await session.resume.read("a"); f.hold = true;
    const resume = session.resume.resume({ threadId: "a", force: true }); await flush();
    f.settings("live-new"); await flush(); assert.equal(session.views.get("a")?.execution.model, "live-new");
    f.release(); await resume; assert.equal(session.views.get("a")?.execution.model, "live-new", "stale ACK cannot overwrite an intervening live setting");
  } finally { f.release(); await session.dispose(); await client.close(); }
});

test("a retired inbound request cannot enter a handler through a held interceptor", { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport }); let calls = 0;
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  let proceed!: () => Promise<unknown>;
  client.interceptServerRequest((_request, next) => new Promise((resolve, reject) => { proceed = () => next().then(resolve, reject); }));
  client.handleServerRequest("item/tool/requestUserInput", () => { calls++; return { answers: {} }; });
  try {
    f.question(); await flush(); f.emit("serverRequest/resolved", { threadId: "a", requestId: "question" }); await flush();
    await proceed(); await flush(); assert.equal(calls, 0, "retirement must fence handler admission, not just the final response write"); assert.equal(f.replies.length, 0);
  } finally { await client.close(); }
});

test("Workbench responds to a current native question without waiting for historical authority", { timeout: 5000 }, async () => {
  const f = fixture(); f.hold = true;
  const runtime = createAppServerWorkbenchRuntime({ hostId: "h", transport: f.transport, autoReconnect: false, requestTimeoutMs: 60000, frameScheduler: { schedule(run) { queueMicrotask(run); return () => {}; } }, onRecoveryEvent() {} });
  let reply: Promise<void> | undefined;
  try {
    await runtime.connect(); const lease = await runtime.acquireThread("a"); lease.setRecoveryVisibility(true); await flush();
    assert.equal(f.reads, 1); assert.equal(lease.getSnapshot().authoritative, false);
    f.question(); await flush(); assert.equal(lease.getSnapshot().pendingInteractions.length, 1);
    let settled = false; reply = lease.respond({ type: "question", requestId: encodeServerRequestId("question"), answers: { choice: ["yes"] } }).then(() => { settled = true; });
    await flush(); assert.equal(settled, true, "reply to an already admitted native request cannot depend on the history server");
    assert.equal(f.replies.length, 1); assert.equal(lease.getSnapshot().authoritative, false); assert.equal(f.activations, 0);
    f.emit("serverRequest/resolved", { threadId: "a", requestId: "question" });
    lease.release();
  } finally { f.release(); await runtime.dispose(); await reply?.catch(() => undefined); }
});


test("native retirement cannot consume a same-id successor admitted by an abort observer", { timeout: 5000 }, async () => {
  const f = fixture(run => run()), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  const contexts: import("@opencraft/appserver-client").ServerRequestResponseContext[] = [];
  client.handleServerRequest("item/tool/requestUserInput", (_params, _request, context) => {
    contexts.push(context);
    if (contexts.length === 1) context.signal.addEventListener("abort", () => f.question("question", "successor"), { once: true });
    return new Promise(() => {});
  });
  try {
    f.question(); await flush(); f.emit("serverRequest/resolved", { threadId: "a", requestId: "question" }); await flush();
    assert.equal(contexts.length, 2); assert.equal(contexts[0]?.retirement, "resolved");
    assert.equal(contexts[1]?.signal.aborted, false, "the original resolution can retire only contexts present at its own boundary");
    assert.equal(f.replies.length, 0);
  } finally { await client.close(); }
});


test("retirement during response serialization fences native transport admission", { timeout: 5000 }, async () => {
  const f = fixture(run => run()), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  client.handleServerRequest("item/tool/requestUserInput", () => ({ toJSON() {
    f.emit("serverRequest/resolved", { threadId: "a", requestId: "question" });
    return { answers: {} };
  } }));
  try { f.question(); await flush(); assert.equal(f.replies.length, 0, "serialized data cannot re-admit a retired native response"); }
  finally { await client.close(); }
});


test("Host withdrawal releases the old Broker slot before same-id UI observer reentry", { timeout: 5000 }, async () => {
  const f = fixture(run => run()), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "channels", version: "1" } });
  const pending = new Map<string, import("@opencraft/chat-runtime").PendingInteraction>(); let replace = true;
  const broker = new AppServerInteractionBroker({ hostId: "h", client, store: {
    upsertPendingInteraction(interaction) { pending.set(interaction.requestId, interaction); },
    removePendingInteraction(_thread, id) { pending.delete(id); if (replace) { replace = false; f.question("question", "successor"); } },
  } });
  try {
    f.question(); await flush(); f.emit("serverRequest/resolved", { threadId: "a", requestId: "question" }); await flush();
    assert.equal(pending.size, 1); assert.equal(pending.get(encodeServerRequestId("question"))?.itemId, "successor");
    assert.equal(f.replies.length, 0);
    await broker.respond({ hostId: "h", threadId: "a" }, { type: "question", requestId: encodeServerRequestId("question"), answers: {} });
    assert.equal(f.replies.length, 1); assert.equal(pending.size, 0);
  } finally { broker.dispose(); await client.close(); }
});
