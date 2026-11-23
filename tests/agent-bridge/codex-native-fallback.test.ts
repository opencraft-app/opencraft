import assert from "node:assert/strict";
import test from "node:test";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { CodexNativeFallback } from "../../apps/opencraft-daemon/src/codex-native-fallback.js";

function fallback() {
  const requests: [string, unknown][] = [];
  let notify: (method: string, params: Record<string, unknown>) => void = () => {};
  const native = new CodexNativeFallback({
    initializeResult: async () => ({
      userAgent: "codex/test",
      capabilities: { extensions: { "opencraft/desktop": { version: 1 }, "native/feature": { version: 1 } } },
    }),
    request: async (method, params) => {
      requests.push([method, params]);
      return method === "thread/list" ? { data: [{ id: "native-1" }], nextCursor: null } : { ok: method };
    },
    subscribeNotification: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  const frames: any[] = [];
  native.subscribeMessage((raw) => frames.push(JSON.parse(raw)));
  const send = async (client: string, id: number, method: string, params: unknown = {}) => {
    await native.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
    return frames.find((frame) => frame.id === id && frame[LOGICAL_CLIENT_FIELD] === client);
  };
  return {
    native,
    frames,
    requests,
    send,
    notify: (method: string, params: Record<string, unknown>) => notify(method, params),
  };
}

test("the native fallback answers initialize, the catalog and reads, and refuses everything that executes", async () => {
  const { native, send, requests, frames, notify } = fallback();
  await native.connect();
  assert.equal(native.status.state, "open");
  assert.equal((await send("a", 1, "thread/list")).error.message, "Client is not initialized");
  const init = await send("a", 2, "initialize", { clientInfo: { name: "t" } });
  const extensions = init.result.capabilities.extensions;
  assert.equal(extensions["opencraft/desktop"], undefined, "machine-owned extensions are not native's to claim");
  assert.deepEqual(extensions["native/feature"], { version: 1 });
  assert.equal(init.result.userAgent, "codex/test");

  assert.deepEqual((await send("a", 3, "thread/list", { limit: 5 })).result.data, [{ id: "native-1" }]);
  assert.deepEqual((await send("a", 4, "thread/read", { threadId: "t1" })).result, { ok: "thread/read" });
  assert.deepEqual((await send("a", 5, "thread/archive", { threadId: "t1" })).result, { ok: "thread/archive" });
  for (const [id, method] of [
    [6, "turn/start"],
    [7, "thread/start"],
    [8, "command/exec"],
    [9, "turn/steer"],
  ] as const)
    assert.equal((await send("a", id, method, { threadId: "t1" })).error.code, -32601, method);
  assert.deepEqual(
    requests.map(([method]) => method),
    ["thread/list", "thread/read", "thread/archive"],
  );
  assert.deepEqual((await send("a", 10, "thread/unsubscribe", { threadId: "t1" })).result, {});

  // Catalog changes and Thread-independent notifications reach clients; private Threads never do.
  frames.length = 0;
  notify("thread/archived", { threadId: "t1" });
  notify("account/rateLimits/updated", { rateLimits: {} });
  notify("thread/started", { thread: { id: "title-thread", ephemeral: true } });
  notify("item/agentMessage/delta", { threadId: "title-thread", delta: "x" });
  assert.deepEqual(
    frames.map((frame) => frame.method),
    ["thread/archived", "account/rateLimits/updated"],
  );

  await native.send(JSON.stringify({ method: "runtime/client/disconnect", params: {}, [LOGICAL_CLIENT_FIELD]: "a" }));
  assert.equal((await send("a", 11, "thread/list")).error.message, "Client is not initialized");
  await native.close();
});
