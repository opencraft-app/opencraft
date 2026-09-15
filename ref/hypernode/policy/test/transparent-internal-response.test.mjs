import assert from "node:assert/strict";
import test from "node:test";
import { TransparentInternalResponseService } from "../src/services/transparent-internal-response.ts";

function service({ handoff = false, open = false } = {}) {
  const calls = [];
  const instance = Object.create(TransparentInternalResponseService.prototype);
  instance.ctx = {
    transparentHandoff: {
      handle: (...args) => {
        calls.push(["handoff", ...args]);
        return handoff;
      },
    },
    transparentBackendOpen: {
      handle: (...args) => {
        calls.push(["open", ...args]);
        return open;
      },
    },
  };
  return { calls, instance };
}

const state = { backendKey: "runtime-1" };
const message = { id: "internal-1", result: { thread: { id: "inner-1" } } };
const request = { outerThreadId: "outer-1", method: "thread/resume" };
const host = { handoff: { name: "handoff-host" }, open: { name: "open-host" } };

test("engine handoff owns a matching internal response before ordinary open", () => {
  const { calls, instance } = service({ handoff: true, open: true });
  assert.equal(instance.handle(state, message, request, host), true);
  assert.deepEqual(calls, [["handoff", state, message, undefined, host.handoff]]);
});

test("ordinary open runs only when handoff declines the response", () => {
  const { calls, instance } = service({ open: true });
  assert.equal(instance.handle(state, message, request, host), true);
  assert.deepEqual(calls, [
    ["handoff", state, message, undefined, host.handoff],
    ["open", state, message, request, host.open],
  ]);
});

test("unrecognized internal responses remain available to later routing", () => {
  const { calls, instance } = service();
  assert.equal(instance.handle(state, message, request, host), false);
  assert.equal(calls.length, 2);
});
