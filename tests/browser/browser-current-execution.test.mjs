import test from "node:test";
import assert from "node:assert/strict";
import { readConversationCurrentTurn } from "../../scripts/conversation-execution.mjs";

function fixture({ providers = [], global = {}, result, error } = {}) {
  const sent = [],
    contexts = [];
  let closed = 0;
  return {
    sent,
    contexts,
    get closed() {
      return closed;
    },
    host: {
      accept(port, _client, context) {
        contexts.push(context);
        port.subscribe((message) => {
          if (message.type === "hello") port.postMessage({ type: "ready" });
          if (message.type === "host/connect")
            port.postMessage({ type: "response", requestId: "connect", ok: true, result: { generation: 1 } });
          if (message.type === "host/send") {
            const frame = JSON.parse(message.frame);
            sent.push(frame);
            const response =
              frame.method === "initialize"
                ? {
                    result: {
                      capabilities: { extensions: { ...global, "opencraft/execution-engines": { providers } } },
                    },
                  }
                : error
                  ? { error }
                  : { result };
            port.postMessage({
              type: "host/frame",
              hostId: message.hostId,
              generation: 1,
              frame: JSON.stringify({ id: frame.id, ...response }),
            });
          }
        });
        return {
          close() {
            closed++;
          },
        };
      },
    },
  };
}
const binding = { hostId: "host", threadId: "bridge_thread" };
const declared = [{ threadPrefix: "bridge_", extensions: { "opencraft/execution-current": { version: 1 } } }];

test("current execution uses the exact provider declaration and preserves Actor context without a history read", async () => {
  const f = fixture({ providers: declared, result: { turn: { id: "canonical", status: "inProgress" } } });
  const context = { sender: null, actorContext: { actorId: "human", generation: 1 } };
  assert.deepEqual(await readConversationCurrentTurn(f.host, binding, context), {
    id: "canonical",
    status: "inProgress",
  });
  assert.deepEqual(f.contexts, [context]);
  assert.equal(f.closed, 1);
  assert.deepEqual(
    f.sent.map((frame) => frame.method),
    ["initialize", "opencraft/execution/current"],
  );
  assert.deepEqual(f.sent[1].params, { threadId: binding.threadId });
});

test("legacy provider uses only the bounded latest metadata page, even when another provider advertises the new read", async () => {
  const f = fixture({
    providers: [{ ...declared[0], threadPrefix: "other_" }],
    result: { data: [{ id: "legacy", status: "inProgress", items: ["not forwarded"] }] },
  });
  assert.deepEqual(await readConversationCurrentTurn(f.host, binding, {}), { id: "legacy", status: "inProgress" });
  assert.deepEqual(f.sent[1], {
    id: "operation",
    method: "thread/turns/list",
    params: { threadId: binding.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
  });
});

test("unconfirmed, missing and rejected current execution never fall back to stale history", async () => {
  for (const turn of [null, { id: "old", status: "unconfirmed" }]) {
    const f = fixture({ providers: declared, result: { turn } });
    assert.deepEqual(await readConversationCurrentTurn(f.host, binding, {}), turn);
    assert.equal(f.sent.length, 2);
  }
  for (const settings of [
    { result: {} },
    { result: { turn: { id: "", status: "inProgress" } } },
    { error: { code: 503, message: "unavailable" } },
  ]) {
    const f = fixture({ providers: declared, ...settings });
    await assert.rejects(readConversationCurrentTurn(f.host, binding, {}));
    assert.equal(f.sent.length, 2);
    assert.equal(f.closed, 1);
  }
});
