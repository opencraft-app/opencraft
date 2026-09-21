import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendRpcService } from "../src/services/transparent-backend-rpc.ts";

function createHarness() {
  const service = Object.create(TransparentBackendRpcService.prototype);
  const connectionA = { id: "a" };
  const connectionB = { id: "b" };
  const state = {
    internalRequests: new Map(),
    forwardedRequests: new Map(),
    internalControlRequests: new Map(),
    abandonedRequestIds: new Set(),
    serverRequestIds: new Map(),
  };
  return { service, state, connectionA, connectionB };
}

test("backend RPC correlation consumes internal and forwarded responses exactly once", () => {
  const { service, state, connectionA } = createHarness();
  const internal = { outerThreadId: "thread-1", method: "thread/resume" };
  const forwarded = {
    connection: connectionA,
    clientId: "client-1",
    outerThreadId: "thread-1",
    method: "turn/start",
  };
  service.trackInternal(state, "internal-1", internal);
  service.trackForwarded(state, "forwarded-1", forwarded);

  assert.equal(service.takeInternal(state, { id: "internal-1", result: {} }), internal);
  assert.equal(service.takeInternal(state, { id: "internal-1", result: {} }), null);
  assert.equal(service.takeForwarded(state, { id: "forwarded-1", result: {} }), forwarded);
  assert.equal(service.takeForwarded(state, { id: "forwarded-1", result: {} }), null);
  assert.equal(
    service.takeForwarded(state, { id: "forwarded-1", method: "turn/started" }),
    null,
    "notifications with ids are server requests, not client responses",
  );
});

test("internal controls receive the native error/result shape once", () => {
  const { service, state } = createHarness();
  const callbacks = [];
  state.internalControlRequests.set("control-1", {
    callback: (...args) => callbacks.push(args),
  });
  const response = { id: "control-1", result: { account: null } };

  assert.equal(service.completeInternalControl(state, response), true);
  assert.deepEqual(callbacks, [[null, { account: null }, state]]);
  assert.equal(service.completeInternalControl(state, response), false);
});

test("server request response is consumed only by its routed connection", () => {
  const { service, state, connectionA, connectionB } = createHarness();
  const route = { innerId: 7, connection: connectionA };
  service.trackServerRequest(state, "server-1", route);

  assert.equal(
    service.takeServerResponse(state, connectionB, { id: "server-1", result: {} }),
    null,
  );
  assert.equal(state.serverRequestIds.size, 1);
  assert.equal(
    service.takeServerResponse(state, connectionA, { id: "server-1", result: {} }),
    route,
  );
  assert.equal(state.serverRequestIds.size, 0);
});

test("connection abandonment fences late forwarded replies and drops server routes", () => {
  const { service, state, connectionA, connectionB } = createHarness();
  service.trackForwarded(state, "a-1", {
    connection: connectionA,
    clientId: 1,
    outerThreadId: "thread-1",
  });
  service.trackForwarded(state, "b-1", {
    connection: connectionB,
    clientId: 2,
    outerThreadId: "thread-2",
  });
  service.trackServerRequest(state, "server-a", { innerId: 3, connection: connectionA });
  service.trackServerRequest(state, "server-b", { innerId: 4, connection: connectionB });

  service.abandonConnection(state, connectionA);
  assert.deepEqual([...state.forwardedRequests.keys()], ["b-1"]);
  assert.deepEqual([...state.abandonedRequestIds], ["a-1"]);
  assert.deepEqual([...state.serverRequestIds.keys()], ["server-b"]);
  assert.equal(service.consumeAbandoned(state, { id: "a-1", result: {} }), true);
  assert.equal(service.consumeAbandoned(state, { id: "a-1", result: {} }), false);
});

test("turn/steer abandonment reports correlation only and never request content", () => {
  const { service, state, connectionA } = createHarness();
  connectionA.connectionId = "connection-a";
  connectionA.sessionId = "session-a";
  service.trackForwarded(state, "backend-steer-1", {
    connection: connectionA,
    clientId: "frontend-steer-1",
    outerThreadId: "thread-1",
    method: "turn/steer",
    forwardedAtMs: Date.now() - 10,
    clientUserMessageId: "message-1",
    expectedTurnId: "turn-1",
    secretText: "must-not-be-logged",
  });
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args.map(String).join(" "));
  try {
    service.abandonConnection(state, connectionA);
  } finally {
    console.info = originalInfo;
  }

  const output = logs.join("\n");
  assert.match(output, /"stage":"connection-abandoned"/);
  assert.match(output, /"backendId":"backend-steer-1"/);
  assert.doesNotMatch(output, /must-not-be-logged/);
});
