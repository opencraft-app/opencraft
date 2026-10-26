import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { createAppServerConversationCommandPort } from "@opencraft/composer-appserver";

import { createStopControlFixture as setup, drainStopFixture as drain, stopControlTransportFixture as fixture } from "../protocol/fixtures/stop-control";

test("known Turn stop reaches the current Host before a retained history read returns", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup(); let stopping: Promise<void> | undefined;
  try {
    const generation = runtime.getSnapshot().connectionGeneration; f.holdRead = true; await runtime.reconnect(); await drain();
    assert.equal(f.reads.length, 1); assert.equal(view.getSnapshot().authoritative, false);
    let settled = false; stopping = view.interrupt("known-turn").then(() => { settled = true; }); void stopping.catch(() => undefined); await drain();
    assert.deepEqual(f.stops, ["known-turn"], "stop must not depend on historical authority"); assert.equal(settled, true);
    assert.equal(runtime.getSnapshot().connectionGeneration, generation); assert.equal(f.initializations, 1);
    assert.equal(f.readCount, 2); assert.equal(view.getSnapshot().authoritative, false);
    assert.ok(!f.methods.some(method => ["thread/resume", "turn/start", "turn/steer"].includes(method)));
  } finally { f.release(); await runtime.dispose(); await stopping?.catch(() => undefined); }
});

test("known Turn stop does not wait for the delivery receipt of an implicit question dismissal", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup(); let stopping: Promise<void> | undefined;
  try {
    f.holdReceipt = true; f.question(); await drain(); assert.equal(view.getSnapshot().pendingInteractions.length, 1);
    let settled = false; stopping = view.interrupt("known-turn").then(() => { settled = true; }); void stopping.catch(() => undefined); await drain();
    assert.deepEqual(f.stops, ["known-turn"], "best-effort prompt dismissal cannot hold the native stop channel"); assert.equal(settled, true);
    assert.equal(view.getSnapshot().authoritative, true); assert.equal(f.readCount, 1);
    assert.ok(f.receipts.length <= 1); assert.ok(f.responses.length <= 1);
  } finally { f.release(); await runtime.dispose(); await stopping?.catch(() => undefined); }
});

test("reentrant stop from a request observer joins the registered original intent", { timeout: 5000 }, async () => {
  const { f, runtime, view, client } = await setup(); let nested: Promise<void> | undefined, once = false;
  const remove = client.subscribeRequestLifecycle(event => {
    if (event.type === "started" && event.method === "turn/interrupt" && !once) { once = true; nested = view.interrupt("known-turn"); }
  });
  try { await view.interrupt("known-turn"); await nested; assert.equal(once, true); assert.deepEqual(f.stops, ["known-turn"]); }
  finally { remove(); f.release(); await runtime.dispose(); }
});

test("a stale known Turn is rejected without selecting a successor or replaying the stop", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup();
  try {
    f.active = "new-turn";
    await assert.rejects(view.interrupt("known-turn"), /Active Turn changed/); await drain();
    assert.deepEqual(f.stops, ["known-turn"]); assert.equal(f.readCount, 1);
  } finally { f.release(); await runtime.dispose(); }
});

test("stop command admission checks Host permission, client identity and final beforeSend ownership", { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "stop-port", version: "1" } });
  const key = { hostId: "h", threadId: "a" }, interactions = { respond: async () => {} };
  try {
    const denied = createAppServerConversationCommandPort({ hostId: "h", client, interactions, canRequest: method => method !== "turn/interrupt" });
    await assert.rejects(denied.interrupt(key, "known-turn")); assert.equal(f.stops.length, 0);
    const foreign = createAppServerConversationCommandPort({ hostId: "other", client, interactions });
    await assert.rejects(foreign.interrupt({ hostId: "other", threadId: "a" }, "known-turn"), /Host|host/); assert.equal(f.stops.length, 0);
    const port = createAppServerConversationCommandPort({ hostId: "h", client, interactions }); let current = true;
    const remove = client.subscribeRequestLifecycle(event => { if (event.type === "started" && event.method === "turn/interrupt") current = false; });
    await assert.rejects(port.interrupt(key, "known-turn", undefined, { canDispatch: () => current }), error => error instanceof Error && "code" in error && error.code === "ABORTED");
    remove(); assert.equal(f.stops.length, 0);
  } finally { f.release(); await client.close(); }
});


test("disposing Runtime from final request observation prevents the stop frame", { timeout: 5000 }, async () => {
  const { f, runtime, view, client } = await setup(); let disposal: Promise<void> | undefined;
  const remove = client.subscribeRequestLifecycle(event => {
    if (event.type === "started" && event.method === "turn/interrupt") disposal = runtime.dispose();
  });
  try {
    await assert.rejects(view.interrupt("known-turn")); await disposal; assert.deepEqual(f.stops, []);
  } finally { remove(); f.release(); await runtime.dispose(); }
});

test("releasing the View preserves an admitted stop", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup();
  try {
    const stopping = view.interrupt("known-turn"); view.release(); await stopping;
    assert.deepEqual(f.stops, ["known-turn"]);
  } finally { f.release(); await runtime.dispose(); }
});

test("a native stop transport failure is surfaced once without choosing another target", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup();
  f.holdStopReply = true;
  const send = f.transport.send.bind(f.transport); let admitted = 0;
  f.transport.send = async frame => {
    const message = JSON.parse(frame);
    await send(frame);
    if (message.method === "turn/interrupt") { admitted++; throw Error("Synthetic lost stop write receipt"); }
  };
  try { await assert.rejects(view.interrupt("known-turn")); await drain(); assert.equal(admitted, 1); assert.deepEqual(f.stops, ["known-turn"]); }
  finally { f.release(); await runtime.dispose(); }
});

test("stop checks a permission revoked by a final request observer", { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport }); let allowed = true;
  await client.connect({ clientInfo: { name: "stop-permission", version: "1" } });
  const port = createAppServerConversationCommandPort({ hostId: "h", client, interactions: { respond: async () => {} }, canRequest: () => allowed });
  const remove = client.subscribeRequestLifecycle(event => { if (event.type === "started" && event.method === "turn/interrupt") allowed = false; });
  try { await assert.rejects(port.interrupt({ hostId: "h", threadId: "a" }, "known-turn")); assert.deepEqual(f.stops, []); }
  finally { remove(); f.release(); await client.close(); }
});


test("serialization cannot revive a retired stop before transport admission", { timeout: 5000 }, async () => {
  const f = fixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport }); let current = true;
  await client.connect({ clientInfo: { name: "stop-serialization", version: "1" } });
  const port = createAppServerConversationCommandPort({ hostId: "h", client, interactions: { respond: async () => {} } });
  const target = { toJSON() { current = false; return "known-turn"; } } as unknown as string;
  try { await assert.rejects(port.interrupt({ hostId: "h", threadId: "a" }, target, undefined, { canDispatch: () => current })); assert.deepEqual(f.stops, []); }
  finally { f.release(); await client.close(); }
});

test("authoritative Thread retirement prevents dispatch from its retained View", { timeout: 5000 }, async () => {
  const { f, runtime, view } = await setup();
  try { f.archive(); await drain(); await assert.rejects(view.interrupt("known-turn")); assert.deepEqual(f.stops, []); }
  finally { f.release(); await runtime.dispose(); }
});
