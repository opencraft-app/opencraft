import assert from "node:assert/strict";
import test from "node:test";

import { abortUnroutedTurnStart } from "../src/services/request-lifecycle.ts";

test("an unrouted turn/start releases the provisional execution and write lease", () => {
  const calls = [];
  const connection = {
    threadExecution: {
      abortRequest: (...args) => {
        calls.push(["execution", ...args]);
        return { executionId: "execution-1" };
      },
    },
    threadWriteLease: {
      release: (...args) => calls.push(["lease", ...args]),
    },
  };
  const message = { id: "request-1", method: "turn/start", params: { threadId: "thread-1" } };

  assert.deepEqual(abortUnroutedTurnStart(message, connection, "methodNotFound"), {
    executionId: "execution-1",
  });
  assert.deepEqual(calls, [
    ["execution", "thread-1", connection, "request-1", "methodNotFound"],
    ["lease", "thread-1", connection],
  ]);
});

test("unrouted non-turn requests do not release thread ownership", () => {
  let called = false;
  const connection = {
    threadExecution: { abortRequest: () => { called = true; } },
    threadWriteLease: { release: () => { called = true; } },
  };

  assert.equal(abortUnroutedTurnStart({ id: 1, method: "thread/read", params: {} }, connection), null);
  assert.equal(called, false);
});
