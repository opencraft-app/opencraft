import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerClient, JsonRpcAppServerClient, type AppServerClient } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./fixtures/execution-channels";

for (const facade of [false, true]) for (const lane of ["native", "scoped", "diagnostic", "lifecycle"] as const) {
  test(`Client callbacks keep their bare-function receiver: ${facade ? "Cordis" : "raw Client"} ${lane}`, async () => {
    const f = executionChannelsFixture(), cordis = facade ? await createCordisAppServerClient({ hostId: "receiver", transport: f.transport }) : null;
    const client: AppServerClient = cordis?.client ?? new JsonRpcAppServerClient({ hostId: "receiver", transport: f.transport });
    await client.connect({ clientInfo: { name: "callback-receiver", version: "1" } });
    const receivers: unknown[] = [];
    function callback(this: unknown) { receivers.push(this); }
    const remove = lane === "diagnostic" ? client.subscribeProtocolError(callback)
      : lane === "lifecycle" ? client.subscribeRequestLifecycle(function(this: unknown, e) {
        if ("method" in e && e.method === "fixture/receiver" && e.type === "queued") callback.call(this);
      }) : client.subscribeNotification(callback, lane === "scoped" ? { intercept: (_n, next) => next() } : undefined);
    const removeSource = lane === "diagnostic" ? client.subscribeNotification(() => { throw Error("Synthetic receiver diagnostic"); }) : () => {};
    try {
      if (lane === "lifecycle") await client.requestRaw("fixture/receiver", {});
      else f.emit("fixture/receiver", {});
      await flush(); assert.deepEqual(receivers, [undefined], "an internal registration record must never become a callback receiver");
    } finally { remove(); removeSource(); if (cordis) await cordis.dispose(); else await client.close(); }
  });
}
