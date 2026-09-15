import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendBootstrapService } from "../src/services/transparent-backend-bootstrap.ts";

function service(ready) {
  const instance = Object.create(TransparentBackendBootstrapService.prototype);
  instance.ctx = { transparentBackendLifecycle: { completeInitialization: () => ready } };
  return instance;
}

function state() {
  const sent = [];
  return {
    sent,
    value: {
      initId: "initialize",
      processId: "runtime",
      realm: "workspace",
      viewId: "main",
      opening: new Set(["outer"]),
      pendingByOuter: new Map([["outer", []]]),
      filesystem: { send: (_processId, message) => sent.push(message) },
    },
  };
}

test("bootstrap releases queued runtime work only after initialize succeeds", () => {
  const backend = state();
  const calls = [];
  const connection = { socket: { send: assert.fail } };
  const pendingMessage = { id: 1, method: "model/list", params: {} };
  const instance = service({
    backendMessages: [{ method: "initialized", params: {} }],
    controls: [{ connection, message: pendingMessage }],
    internalControls: [{ method: "account/read", callback: assert.fail }],
    outerThreadIds: ["outer"],
  });

  assert.equal(instance.handle(backend.value, { id: "other", result: {} }, {}), false);
  assert.equal(instance.handle(backend.value, { id: "initialize", result: {} }, {
    fail: assert.fail,
    forwardControl: (...args) => calls.push(["control", ...args]),
    forwardInternalControl: (...args) => calls.push(["internal", ...args]),
    openOuter: (...args) => calls.push(["open", ...args]),
    failOuter: assert.fail,
  }), true);
  assert.deepEqual(backend.sent, [{ method: "initialized", params: {} }]);
  assert.deepEqual(calls.map(([kind]) => kind), ["control", "internal", "open"]);
});

test("bootstrap converts initialize and queued-open failures into authoritative errors", () => {
  const backend = state();
  const failures = [];
  assert.equal(service(null).handle(backend.value, {
    id: "initialize",
    error: { code: -32000, message: "bad auth" },
  }, {
    fail: (reason) => failures.push(reason),
    forwardControl: assert.fail,
    forwardInternalControl: assert.fail,
    openOuter: assert.fail,
    failOuter: assert.fail,
  }), true);
  assert.deepEqual(failures, ["bad auth"]);

  const openFailures = [];
  service({ backendMessages: [], controls: [], internalControls: [], outerThreadIds: ["outer"] })
    .handle(backend.value, { id: "initialize", result: {} }, {
      fail: assert.fail,
      forwardControl: assert.fail,
      forwardInternalControl: assert.fail,
      openOuter: () => { throw new Error("rollout missing"); },
      failOuter: (...args) => openFailures.push(args),
    });
  assert.deepEqual(openFailures, [["outer", "rollout missing"]]);
  assert.equal(backend.value.opening.has("outer"), false);
});
