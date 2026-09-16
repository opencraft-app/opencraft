import assert from "node:assert/strict";
import test from "node:test";

import {
  TransparentBackendMessageCoordinatorService,
} from "../src/services/transparent-backend-message-coordinator.ts";

function createHarness(options = {}) {
  const calls = [];
  const state = {
    ownerUserId: "user-1",
    backendKey: "runtime-1",
    filesystem: {},
    forwardedRequests: new Map(),
  };
  const router = {
    handle(_state, message, host) {
      return options.route?.(message, host);
    },
  };
  const service = Object.assign(
    Object.create(TransparentBackendMessageCoordinatorService.prototype),
    {
      ctx: {
        transparentBackendMessage: router,
        transparentBackendChannel: {
          deferUntilThreadBinding: (...args) => (
            calls.push(["defer", ...args]), false
          ),
          send: (...args) => calls.push(["send", ...args]),
          broadcast: (...args) => calls.push(["broadcast", args[1]]),
          flushThreadMessages: (candidateState, innerThreadId, channelHost) => {
            calls.push(["flush", innerThreadId]);
            channelHost.replay(candidateState, { method: "thread/status/changed" });
          },
        },
        transparentBackendBootstrap: {
          handle: (...args) => (calls.push(["bootstrap", ...args]), true),
        },
        transparentBackendProjection: {
          projectBackend: (...args) => calls.push(["project", args[0]]),
        },
        transparentAccountEvent: {
          handle: (...args) => (calls.push(["account", ...args]), false),
          emit: (...args) => calls.push(["accountEvent", ...args]),
        },
        codexRuntimeAdapter: {
          observe: (...args) => (calls.push(["runtime", ...args]), false),
        },
        transparentBackendRpc: {
          completeInternalControl: (...args) => (
            calls.push(["internalControl", ...args]), false
          ),
          consumeAbandoned: (...args) => (calls.push(["abandoned", ...args]), false),
          takeInternal: (...args) => (calls.push(["internal", ...args]), null),
          takeForwarded: (...args) => (calls.push(["forwarded", ...args]), null),
        },
        transparentForwardedResponse: {
          handle: (...args) => calls.push(["forwardedResponse", ...args]),
        },
        transparentProcessBridge: {
          routeCommandOutput: () => ({ handled: false }),
          routeHostProcessNotification: () => ({ handled: false }),
        },
        transparentProtocolMapper: {
          toOuter: (message) => ({ ...message, outer: true }),
          toVirtual: (path) => path,
        },
        transparentThreadBinding: {
          reverseBindings: new Map(),
        },
        transparentBackendOutbound: {
          handleServerRequest: (...args) => calls.push(["serverRequest", ...args]),
          handleNotification: (...args) => calls.push(["notification", ...args]),
        },
      },
    },
  );
  const host = {
    bootstrap: { fail: () => {} },
    handleInternal: () => false,
    forwardedResponseHost: () => ({ marker: "forwarded-host" }),
  };
  return { calls, host, service, state };
}

test("coordinator owns native bootstrap, account, runtime and RPC wiring", () => {
  const { calls, host, service, state } = createHarness({
    route(message, routed) {
      assert.equal(routed.handleBootstrap(message), true);
      assert.equal(routed.handleAccount(message), false);
      assert.equal(routed.observeRuntime(message), false);
      assert.equal(routed.completeInternalControl(message), false);
      assert.equal(routed.consumeAbandoned(message), false);
      assert.equal(routed.takeInternal(message), null);
      assert.equal(routed.takeForwarded(message), null);
    },
  });
  const message = { id: "response-1", result: {} };

  service.handle(state, message, host);

  assert.deepEqual(calls.map(([name]) => name), [
    "bootstrap",
    "account",
    "runtime",
    "internalControl",
    "abandoned",
    "internal",
    "forwarded",
  ]);
  assert.equal(calls[1][1], "user-1");
  assert.equal(calls[2][1], "runtime-1");
});

test("coordinator converts an unmatched native response before projection and broadcast", () => {
  const { calls, host, service, state } = createHarness({
    route(message, routed) {
      routed.handleUnmatchedResponse(message);
    },
  });

  service.handle(state, { id: "unknown", result: { ok: true } }, host);

  assert.deepEqual(calls, [
    ["project", { id: "unknown", result: { ok: true }, outer: true }],
    ["broadcast", { id: "unknown", result: { ok: true }, outer: true }],
  ]);
});

test("coordinator routes requests and notifications through typed outbound services", () => {
  const { calls, host, service, state } = createHarness({
    route(message, routed) {
      routed.handleServerRequest(message);
      routed.handleNotification(message);
    },
  });
  const message = { id: "approval-1", method: "item/requestApproval", params: {} };

  service.handle(state, message, host);

  assert.equal(calls[0][0], "serverRequest");
  assert.equal(calls[0].length, 3);
  assert.equal(calls[1][0], "notification");
  assert.equal(calls[1].length, 3);
});

test("coordinator replays deferred messages through the same ingress pipeline", () => {
  const { calls, host, service, state } = createHarness({
    route(message) {
      calls.push(["route", message]);
    },
  });

  service.flushDeferred(state, "inner-1", host);

  assert.deepEqual(calls, [
    ["flush", "inner-1"],
    ["route", { method: "thread/status/changed" }],
  ]);
});
