import assert from "node:assert/strict";
import test from "node:test";

import { AppServerProjectionService } from "../src/services/appserver-projection.ts";

function serviceFixture(recordAppServer) {
  const calls = [];
  const service = Object.create(AppServerProjectionService.prototype);
  service.ctx = {
    canonicalTimeline: { recordAppServer },
    appServer: {
      broadcastNotification(method, params) {
        calls.push({ method, params });
      },
    },
  };
  return { calls, service };
}

test("AppServer projection delivers the payload committed to the canonical timeline", () => {
  const order = [];
  const committed = {
    id: "event-1",
    threadId: "thread-1",
    epoch: "epoch-1",
    seq: 1,
    type: "item.completed",
    time: 1,
    turnId: "turn-1",
    itemId: "item-1",
    source: { engine: "dsh", kind: "execution" },
    data: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", type: "agentMessage", text: "committed" },
      },
    },
  };
  const { calls, service } = serviceFixture(() => {
    order.push("commit");
    return { appended: true, event: committed, head: {
      threadId: "thread-1", epoch: "epoch-1", nextSeq: 2, minSeq: 0,
    } };
  });
  service.ctx.appServer.broadcastNotification = (method, params) => {
    order.push("deliver");
    calls.push({ method, params });
  };

  service.broadcast("item/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    item: { id: "item-1", type: "agentMessage", text: "uncommitted" },
  }, { engine: "dsh", kind: "execution" });

  assert.deepEqual(order, ["commit", "deliver"]);
  assert.equal(calls[0].params.item.text, "committed");
});

test("live deltas remain deliverable without making presentation cadence durable", () => {
  const seen = [];
  const { calls, service } = serviceFixture((method, params, source) => {
    seen.push({ method, params, source });
    return null;
  });
  const params = {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello",
  };

  service.broadcast("item/agentMessage/delta", params, {
    engine: "dsh", kind: "execution",
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(calls, [{ method: "item/agentMessage/delta", params }]);
});

test("canonical persistence failures do not swallow terminal Desktop notifications", () => {
  const failure = {
    appended: false,
    persisted: false,
    failure: {
      threadId: "thread-1",
      method: "turn/completed",
      eventId: "turn/completed:turn-1",
      sourceEngine: "codex",
      errorMessage: "disk full",
      failedAtMs: 1,
    },
  };
  const { calls, service } = serviceFixture(() => failure);
  const params = {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "failed" },
  };

  assert.equal(service.broadcast("turn/completed", params, {
    engine: "codex", kind: "execution",
  }), failure);
  assert.deepEqual(calls, [{ method: "turn/completed", params }]);
});
