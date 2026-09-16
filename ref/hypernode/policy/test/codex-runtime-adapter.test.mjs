import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntimeAdapterTable } from "../src/services/codex-runtime-adapter.ts";

test("a successful unsubscribe is immediately quiescent", () => {
  const adapter = new CodexRuntimeAdapterTable();
  let callback;
  let ready = 0;
  adapter.quiesce("runtime-a", "thread-1", (method, params, next) => {
    assert.equal(method, "thread/unsubscribe");
    assert.deepEqual(params, { threadId: "thread-1" });
    callback = next;
  }, { ready: () => { ready += 1; }, error: assert.fail }, 1_000);
  callback(null, { status: "unsubscribed" });
  assert.equal(ready, 1);
});

test("an active turn is interrupted before its runtime is unsubscribed", () => {
  const adapter = new CodexRuntimeAdapterTable();
  const requests = [];
  let ready = 0;
  adapter.observe("runtime-a", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  adapter.quiesce("runtime-a", "thread-1", (method, params, callback) => {
    requests.push({ method, params, callback });
  }, { ready: () => { ready += 1; }, error: assert.fail }, 1_000);

  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [{
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" },
  }]);
  requests[0].callback(null, {});
  assert.equal(requests[1].method, "thread/unsubscribe");
  assert.deepEqual(requests[1].params, { threadId: "thread-1" });
  requests[1].callback(null, { status: "unsubscribed" });
  assert.equal(ready, 1);
});

test("natural completion while interrupting advances to unsubscribe exactly once", () => {
  const adapter = new CodexRuntimeAdapterTable();
  const requests = [];
  let ready = 0;
  adapter.observe("runtime-a", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  adapter.quiesce("runtime-a", "thread-1", (method, params, callback) => {
    requests.push({ method, params, callback });
  }, { ready: () => { ready += 1; }, error: assert.fail }, 1_000);

  adapter.observe("runtime-a", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  });
  assert.deepEqual(requests.map(({ method }) => method), ["turn/interrupt", "thread/unsubscribe"]);
  requests[0].callback({ message: "no active turn to interrupt" });
  assert.equal(requests.length, 2);
  requests[1].callback(null, { status: "notSubscribed" });
  assert.equal(ready, 1);
});

test("notLoaded is already quiescent and timeout identifies its phase", () => {
  const adapter = new CodexRuntimeAdapterTable({ timeoutMs: 25 });
  let ready = 0;
  adapter.quiesce("runtime-a", "thread-1", (_method, _params, callback) => {
    callback(null, { status: "notLoaded" });
  }, { ready: () => { ready += 1; }, error: assert.fail }, 1_000);
  assert.equal(ready, 1);

  let error;
  adapter.quiesce("runtime-a", "thread-2", () => {}, {
    ready: assert.fail,
    error: (value) => { error = value; },
  }, 2_000);
  adapter.tick(2_025);
  assert.match(error.message, /Timed out.*unsubscribe/);
});
