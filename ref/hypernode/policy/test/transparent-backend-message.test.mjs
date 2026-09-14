import assert from "node:assert/strict";
import test from "node:test";
import { TransparentBackendMessageService } from "../src/services/transparent-backend-message.ts";

const service = Object.create(TransparentBackendMessageService.prototype);

function harness(overrides = {}) {
  const calls = [];
  const host = {
    observe: () => calls.push("observe"),
    handleBootstrap: () => (calls.push("bootstrap"), false),
    handleAccount: () => (calls.push("account"), false),
    observeRuntime: () => (calls.push("runtime"), false),
    deferUntilBinding: () => (calls.push("binding"), false),
    handleProcess: () => (calls.push("process"), false),
    completeInternalControl: () => (calls.push("control"), false),
    consumeAbandoned: () => (calls.push("abandoned"), false),
    takeInternal: () => (calls.push("takeInternal"), null),
    handleInternal: () => (calls.push("internal"), false),
    takeForwarded: () => (calls.push("takeForwarded"), null),
    handleForwarded: () => calls.push("forwarded"),
    handleUnmatchedResponse: () => calls.push("unmatched"),
    handleServerRequest: () => calls.push("serverRequest"),
    handleNotification: () => calls.push("notification"),
    ...overrides,
  };
  return { calls, host };
}

test("backend ingress consumes bootstrap before any execution projection", () => {
  const { calls, host } = harness();
  host.handleBootstrap = () => (calls.push("bootstrap"), true);

  service.handle({}, { id: "initialize", result: {} }, host);

  assert.deepEqual(calls, ["observe", "bootstrap"]);
});

test("a correlated response is routed only after control and internal ownership checks", () => {
  const forwarded = { outerThreadId: "outer-1" };
  const { calls, host } = harness();
  host.takeForwarded = () => (calls.push("takeForwarded"), forwarded);

  service.handle({}, { id: "request-1", result: {} }, host);

  assert.deepEqual(calls, [
    "observe",
    "bootstrap",
    "account",
    "runtime",
    "binding",
    "process",
    "control",
    "abandoned",
    "takeInternal",
    "takeForwarded",
    "forwarded",
  ]);
});

test("backend server requests and notifications have disjoint terminal routes", () => {
  const first = harness();
  service.handle({}, { id: "approval-1", method: "item/requestApproval", params: {} }, first.host);
  assert.equal(first.calls.at(-1), "serverRequest");

  const second = harness();
  service.handle({}, { method: "turn/completed", params: {} }, second.host);
  assert.equal(second.calls.at(-1), "notification");
});
