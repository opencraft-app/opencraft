import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendChannelService } from "../src/services/transparent-backend-channel.ts";
import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";
import { TransparentSubscriptionService } from "../src/services/transparent-subscription.ts";

function backendState() {
  return {
    backendKey: "runtime-current",
    connections: new Set(),
    internalRequests: new Map(),
    pendingThreadMessages: new Map(),
    turnEpochs: new Map(),
  };
}

function channel(options = {}) {
  const sent = [];
  const broadcasts = [];
  const subscription = Object.assign(
    Object.create(TransparentSubscriptionService.prototype),
    { threadSubscribers: new Map(), catalogBroadcasts: new Map() },
  );
  const service = Object.assign(Object.create(TransparentBackendChannelService.prototype), {
    sequence: 0,
    ctx: {
      appServer: {
        send: (connection, message, sensitive = false) => {
          sent.push({ connection, message: structuredClone(message), sensitive });
        },
        broadcastNotification: (method, params) => {
          broadcasts.push({ method, params: structuredClone(params) });
        },
      },
      threadExecution: {
        table: {
          get: options.activeExecution ?? (() => null),
          runtimeAuthority: options.runtimeAuthority ?? (() => null),
          latestEpoch: options.latestEpoch ?? (() => null),
        },
      },
      transparentBackendIngress: Object.create(TransparentBackendIngressService.prototype),
      transparentSubscription: subscription,
    },
  });
  return { service, subscription, sent, broadcasts };
}

test("pre-binding backend messages replay in arrival order exactly once", () => {
  const { service } = channel();
  const state = backendState();
  state.internalRequests.set("open", { outerThreadId: "outer", method: "thread/start" });
  const first = { method: "thread/started", params: { thread: { id: "inner" } } };
  const second = { method: "thread/status/changed", params: { threadId: "inner" } };
  const replayed = [];
  const host = {
    hasBinding: () => false,
    outerThreadId: () => null,
    replay: (_state, message) => replayed.push(message),
  };

  assert.equal(service.deferUntilThreadBinding(state, first, host), true);
  assert.equal(service.deferUntilThreadBinding(state, second, host), true);
  service.flushThreadMessages(state, "inner", host);
  service.flushThreadMessages(state, "inner", host);

  assert.deepEqual(replayed, [first, second]);
  assert.equal(state.pendingThreadMessages.size, 0);
});

test("authority fencing rejects superseded runtimes and stale turn epochs", () => {
  const { service } = channel({
    activeExecution: () => ({ epoch: 4, runtimeId: "runtime-current" }),
    runtimeAuthority: () => ({ runtimeId: "runtime-current" }),
    latestEpoch: () => 4,
  });
  const state = backendState();
  state.turnEpochs.set("turn-old", 3);
  state.turnEpochs.set("turn-current", 4);
  const host = {
    hasBinding: () => true,
    outerThreadId: () => "outer",
    replay: assert.fail,
  };

  assert.equal(service.isStaleAuthorityMessage(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-old" },
  }, host), true);
  assert.equal(service.isStaleAuthorityMessage(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-current" },
  }, host), false);

  state.backendKey = "runtime-superseded";
  assert.equal(service.isStaleAuthorityMessage(state, {
    method: "thread/name/updated",
    params: { threadId: "inner" },
  }, host), true);
});

test("fanout follows stable outer subscriptions and catalog events are deduplicated", () => {
  const { service, sent, broadcasts } = channel();
  const executor = { id: "executor" };
  const observer = { id: "observer" };
  const unrelated = { id: "unrelated" };
  const state = backendState();
  state.connections.add(executor);
  state.connections.add(unrelated);
  service.subscribe(executor, "outer");
  service.subscribe(observer, "outer");

  service.broadcast(state, {
    method: "item/agentMessage/delta",
    params: { threadId: "outer", turnId: "turn", delta: "hello" },
  });
  assert.deepEqual(sent.map(({ connection }) => connection), [executor, observer]);

  assert.equal(service.broadcastCatalog("thread/archived", "outer", null, 10_000), true);
  assert.equal(service.broadcastCatalog("thread/archived", "outer", null, 10_100), false);
  assert.equal(service.broadcastCatalog("thread/archived", "outer", null, 12_001), true);
  assert.deepEqual(broadcasts, [
    { method: "thread/archived", params: { threadId: "outer" } },
    { method: "thread/archived", params: { threadId: "outer" } },
  ]);
});
