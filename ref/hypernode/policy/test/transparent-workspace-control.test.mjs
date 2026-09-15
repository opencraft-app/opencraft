import assert from "node:assert/strict";
import test from "node:test";
import { TransparentWorkspaceControlService } from
  "../src/services/transparent-workspace-control.ts";

const control = Object.create(TransparentWorkspaceControlService.prototype);

function harness(overrides = {}) {
  const calls = [];
  control.ctx = {
    runtimeWorkspace: {
      enabled: true,
      recordFor: overrides.workspaceRecord ?? (() => ({ state: "ready" })),
      assertRuntimeAvailable: overrides.assertRuntimeAvailable ?? (() => {}),
      archive: (...args) => calls.push(["archiveWorkspace", ...args]),
    },
    threadExecution: {
      abortRequest: (...args) => calls.push(["abort", ...args]),
      releaseThread: (...args) => calls.push(["releaseExecution", ...args]),
    },
    transparentBackendChannel: {
      subscribe: (...args) => calls.push(["subscribe", ...args]),
      unsubscribe: (...args) => (calls.push(["unsubscribe", ...args]), true),
      send: (_connection, message) => calls.push(["send", message]),
      broadcastCatalog: (...args) => calls.push(["broadcast", ...args]),
    },
    threadManager: {
      isArchived: () => false,
      archive: (threadId) => ({ id: threadId }),
      isSystem: () => false,
    },
    threadTombstone: {
      record: (...args) => calls.push(["tombstone", ...args]),
    },
    threadWriteLease: {
      releaseThread: (...args) => calls.push(["releaseLease", ...args]),
    },
    transparentThreadBinding: {
      bindings: new Map([["thread-1", {}]]),
    },
    executionEngine: {
      retireThread: (...args) => calls.push(["retireDsh", ...args]),
    },
    transparentRuntimeRetirement: {
      retireThreadRuntimeIfIdle: (...args) => calls.push(["retire", ...args]),
      closeArchivedWorkspaceBackend: (...args) => calls.push(["close", ...args]),
    },
    transparentThreadFork: {
      start: (...args) => calls.push(["fork", ...args]),
    },
  };
  return { calls };
}

function request(operation, method) {
  return {
    connection: { activeThreadId: "thread-1" },
    threadId: "thread-1",
    operation,
    message: { id: `${operation}-1`, method, params: { threadId: "thread-1" } },
  };
}

test("destroyed workspace rejects a new Turn without consulting an engine", () => {
  const unavailable = Object.assign(new Error("workspace destroyed"), { code: -32100 });
  const { calls } = harness({
    workspaceRecord: () => ({ state: "destroyed" }),
    assertRuntimeAvailable: () => { throw unavailable; },
  });
  const input = request("turnStart", "turn/start");

  assert.equal(control.handle(input), "handled");
  assert.deepEqual(calls[0], ["send", {
    id: "turnStart-1",
    error: { code: -32100, message: "workspace destroyed" },
  }]);
  assert.equal(calls[1][0], "abort");
  assert.equal(calls.some(([kind]) => kind === "subscribe"), false);
});

test("workspace archive is an outer control-plane transaction", () => {
  const { calls } = harness();
  assert.equal(control.handle(request("archive", "thread/archive")), "handled");
  assert.deepEqual(calls.map(([kind]) => kind), [
    "archiveWorkspace",
    "releaseLease",
    "releaseExecution",
    "send",
    "broadcast",
    "close",
  ]);
});

test("unsubscribe releases only the outer subscription and idle runtime", () => {
  const { calls } = harness();
  const input = request("unsubscribe", "thread/unsubscribe");
  assert.equal(control.handle(input), "handled");
  assert.equal(input.connection.activeThreadId, null);
  assert.deepEqual(calls.map(([kind]) => kind), ["unsubscribe", "send", "retire"]);
});
