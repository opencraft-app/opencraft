import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";

for (const facade of [false, true]) test(`scoped notification delivery stays local and isolated through ${facade ? "Cordis" : "raw Client"}`, async () => {
  const f = executionChannelsFixture(), cordis = facade ? await createCordisAppServerClient({ hostId: "h", transport: f.transport }) : null;
  const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "scoped-notifications", version: "1" } });
  const global: string[] = [], scoped: string[] = [], deferred: (() => void)[] = [], errors: Error[] = [];
  const removeGlobal = client.subscribeNotification(n => global.push(n.method));
  const removeError = client.subscribeProtocolError(e => errors.push(e));
  const remove = client.subscribeNotification(n => { scoped.push(n.method); if (n.method === "fixture/bad") throw Error("Synthetic deferred failure"); }, { intercept: (_n, next) => deferred.push(next) });
  try {
    f.emit("fixture/bad", { threadId: "a" }); f.emit("fixture/good", { threadId: "a" }); await flush();
    assert.deepEqual(global, ["fixture/bad", "fixture/good"]); assert.deepEqual(scoped, []);
    assert.doesNotThrow(() => deferred[0]!()); assert.equal(errors.length, 1);
    deferred[0]!(); assert.equal(errors.length, 2, "duplicate delivery is reported without invoking the consumer again");
    deferred[1]!(); assert.deepEqual(scoped, ["fixture/bad", "fixture/good"]); assert.equal(global.length, 2);
    f.emit("fixture/retired", { threadId: "a" }); await flush(); remove(); deferred[2]!();
    assert.equal(scoped.length, 2, "unsubscribed consumers cannot be revived by an old continuation"); assert.equal(errors.length, 2);
  } finally { remove(); removeGlobal(); removeError(); if (cordis) await cordis.dispose(); else await client.close(); }
});

test("a retained subscription cannot project an old physical generation", async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  const initialize = { clientInfo: { name: "scoped-generation", version: "1" } }; await client.connect(initialize);
  const deferred: (() => void)[] = [], projected: string[] = [];
  const remove = client.subscribeNotification(n => projected.push(n.method), { intercept: (_n, next) => deferred.push(next) });
  try {
    f.emit("fixture/old", { threadId: "a" }); await flush(); const generation = client.connectionGeneration;
    await f.transport.close(); await client.connect(initialize); assert.notEqual(client.connectionGeneration, generation);
    f.emit("fixture/current", { threadId: "a" }); await flush(); deferred[0]!(); deferred[1]!();
    assert.deepEqual(projected, ["fixture/current"]);
  } finally { remove(); await client.close(); }
});

test("a failing subscription interceptor cannot prevent another native consumer", async () => {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "h", transport: f.transport });
  await client.connect({ clientInfo: { name: "interceptor-isolation", version: "1" } }); const native: string[] = [], errors: Error[] = [];
  const remove = client.subscribeNotification(() => { throw Error("unreachable"); }, { intercept() { throw Error("Synthetic subscription gate failure"); } });
  const removeNative = client.subscribeNotification(n => native.push(n.method)), removeError = client.subscribeProtocolError(e => errors.push(e));
  try { f.emit("fixture/observation", { threadId: "a" }); await flush(); assert.deepEqual(native, ["fixture/observation"]); assert.equal(errors.length, 1); }
  finally { remove(); removeNative(); removeError(); await client.close(); }
});
