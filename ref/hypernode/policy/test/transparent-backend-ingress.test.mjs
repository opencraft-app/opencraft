import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendIngressService } from "../src/services/transparent-backend-ingress.ts";

function service() {
  return Object.create(TransparentBackendIngressService.prototype);
}

function state() {
  return {
    backendKey: "runtime-new",
    turnEpochs: new Map([["turn-old", 1], ["turn-new", 2]]),
    internalRequests: new Map(),
    pendingThreadMessages: new Map(),
  };
}

test("native message identity recognizes every AppServer thread and turn carrier", () => {
  const ingress = service();
  assert.equal(ingress.backendThreadId({ method: "turn/started", params: { thread: { id: "inner" } } }), "inner");
  assert.equal(ingress.backendThreadId({ method: "item/started", params: { threadId: "inner" } }), "inner");
  assert.equal(ingress.messageTurnId({ method: "turn/started", params: { turn: { id: "turn-a" } } }), "turn-a");
  assert.equal(ingress.messageTurnId({ method: "item/started", params: { item: { turnId: "turn-b" } } }), "turn-b");
});

test("runtime and execution epochs fence stale native notifications", () => {
  const ingress = service();
  const backend = state();
  const authority = {
    outerThreadId: () => "outer",
    activeExecution: () => ({ epoch: 2, runtimeId: "runtime-new" }),
    runtimeAuthority: () => ({ runtimeId: "runtime-new" }),
    latestEpoch: () => 2,
  };
  assert.equal(ingress.isStaleAuthorityMessage(backend, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-old" },
  }, authority), true);
  assert.equal(ingress.isStaleAuthorityMessage(backend, {
    method: "item/agentMessage/delta",
    params: { threadId: "inner", turnId: "turn-new" },
  }, authority), false);

  backend.backendKey = "runtime-old";
  assert.equal(ingress.isStaleAuthorityMessage(backend, {
    method: "thread/name/updated",
    params: { threadId: "inner", threadName: "stale" },
  }, authority), true);
});

test("pre-binding messages drain once after thread identity is established", () => {
  const ingress = service();
  const backend = state();
  backend.internalRequests.set("open", { outerThreadId: "outer", method: "thread/start" });
  const message = { method: "thread/started", params: { thread: { id: "inner" } } };

  assert.equal(ingress.deferUntilThreadBinding(backend, message, () => false), true);
  assert.deepEqual(ingress.takeDeferredThreadMessages(backend, "inner"), [message]);
  assert.deepEqual(ingress.takeDeferredThreadMessages(backend, "inner"), []);

  backend.pendingThreadMessages.set("orphan", [message]);
  assert.equal(ingress.discardUnmatchedThreadMessages(backend), false);
  backend.internalRequests.clear();
  assert.equal(ingress.discardUnmatchedThreadMessages(backend), true);
  assert.equal(backend.pendingThreadMessages.size, 0);
});
