import assert from "node:assert/strict";
import test from "node:test";

import { TransparentAccountEventService } from "../src/services/transparent-account-event.ts";

function service(states) {
  const instance = Object.create(TransparentAccountEventService.prototype);
  instance.ctx = {
    deviceIdentity: {
      setBindingState: (...args) => states.push(args),
    },
  };
  return instance;
}

test("account notifications update only their owning SSH device and are emitted once", () => {
  const states = [];
  const events = [];
  const instance = service(states);

  assert.equal(instance.handle("user:alice", {
    method: "account/login/completed",
    params: { success: true },
  }, (event) => events.push(event)), true);
  assert.equal(instance.handle("user:alice", {
    method: "account/updated",
    params: { authMode: null },
  }, (event) => events.push(event)), true);
  assert.equal(instance.handle("user:alice", {
    method: "turn/started",
    params: {},
  }, assert.fail), false);

  assert.deepEqual(states, [
    ["user:alice", "bound"],
    ["user:alice", "unbound"],
  ]);
  assert.equal(events.length, 2);
});

test("failed account login is observable but does not erase an existing binding", () => {
  const states = [];
  const events = [];
  const instance = service(states);
  assert.equal(instance.handle("user:alice", {
    method: "account/login/completed",
    params: { success: false, error: "expired" },
  }, (event) => events.push(event)), true);
  assert.deepEqual(states, []);
  assert.equal(events.length, 1);
});

test("account event subscribers survive backend replacement and can unsubscribe", () => {
  const instance = service([]);
  const observed = [];
  const state = { backendKey: "runtime-1" };
  const unsubscribe = instance.on((ownerUserId, message, backend) => {
    observed.push({ ownerUserId, method: message.method, backend });
  });

  instance.emit("user:alice", { method: "account/updated", params: {} }, state);
  unsubscribe();
  instance.emit("user:alice", { method: "account/updated", params: {} }, state);

  assert.deepEqual(observed, [{
    ownerUserId: "user:alice",
    method: "account/updated",
    backend: state,
  }]);
});
