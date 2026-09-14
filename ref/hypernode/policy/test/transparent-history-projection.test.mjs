import assert from "node:assert/strict";
import test from "node:test";
import { AppServerProjectionService } from
  "../src/services/appserver-projection.ts";

const projection = Object.create(AppServerProjectionService.prototype);

function harness({ active = false } = {}) {
  const sent = [];
  const subscriptions = [];
  const thread = {
    id: "thread-1",
    cwd: "/workspace/projects/demo",
    turns: [{ id: "stale-turn", items: [] }],
  };
  const canonicalTurns = [{
    id: "canonical-turn",
    items: [{ id: "user-1", type: "userMessage", content: [{ type: "text", text: "hello" }] }],
  }];
  projection.ctx = {
    threadManager: {
      get(threadId) {
        assert.equal(threadId, "thread-1");
        return thread;
      },
    },
    canonicalTimeline: {
      turns(threadId) {
        assert.equal(threadId, "thread-1");
        return canonicalTurns;
      },
    },
    transparentSubscription: {
      subscribe(connection, threadId) {
        subscriptions.push([connection, threadId]);
      },
    },
    appServer: {
      send(_connection, message) {
        sent.push(message);
      },
    },
    modelGateway: {
      activeForConnection() {
        return { model: "model-1", providerId: "provider-1" };
      },
    },
    threadExecution: {
      table: {
        get() {
          return active ? {} : null;
        },
      },
    },
  };
  return { sent, subscriptions };
}

test("transparent history reads only canonical timeline turns", () => {
  const connection = {};
  const { sent, subscriptions } = harness();
  assert.equal(projection.handleHistory({
    connection,
    threadId: "thread-1",
    message: { id: "read-1", method: "thread/read", params: { includeTurns: true } },
  }), true);

  assert.equal(connection.activeThreadId, "thread-1");
  assert.deepEqual(subscriptions, [[connection, "thread-1"]]);
  assert.deepEqual(sent[0].result.thread.turns.map((turn) => turn.id), ["canonical-turn"]);
});

test("transparent history resume restores lifecycle projection without an engine port", () => {
  const connection = {};
  const { sent } = harness({ active: true });
  projection.handleHistory({
    connection,
    threadId: "thread-1",
    message: {
      id: "resume-1",
      method: "thread/resume",
      params: { excludeTurns: true, initialTurnsPage: { limit: 5 } },
    },
  });

  assert.equal(sent[0].id, "resume-1");
  assert.equal(sent[1].method, "thread/started");
  assert.deepEqual(sent[2], {
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active", activeFlags: [] } },
  });
  assert.equal("executionEngine" in projection.ctx, false,
    "read-side service must not expose an execution engine");
});
