import assert from "node:assert/strict";
import test from "node:test";
import { TransparentForwardedResponseService } from "../src/services/transparent-forwarded-response.ts";

function harness(overrides = {}) {
  const calls = [];
  const service = Object.assign(Object.create(TransparentForwardedResponseService.prototype), {
    ctx: {
      collaborationMode: { fallbackFor: () => null },
      runtimeWorkspace: { archive: () => {} },
      threadExecution: {
        table: { get: () => ({ epoch: 3 }) },
        abortRequest: () => calls.push("abortTurn"),
        bindTurn: () => calls.push("bindTurn"),
        releaseThread: () => {},
      },
      threadManager: {
        archive: (threadId) => {
          calls.push("archive");
          return { id: threadId, cwd: "/workspace", status: "idle" };
        },
        unarchive: () => calls.push("unarchive"),
      },
      threadTitle: { set: () => calls.push("rename") },
      transparentBackendChannel: {
        send: (_connection, message) => calls.push(["send", message]),
        broadcastCatalog: (method) => calls.push(method),
      },
      transparentBackendProjection: {
        projectBackend: () => calls.push("project"),
      },
      transparentProcessBridge: {
        releaseCommandProcess: () => calls.push("releaseCommand"),
        releaseHostProcess: () => calls.push("releaseHost"),
      },
      transparentProtocolMapper: {
        toOuter: (message) => message,
        toVirtual: (path) => path,
      },
      transparentRuntimeAccess: {
        filesystem: (candidate) => candidate.filesystem,
      },
      transparentThreadBinding: { promoteBinding: () => calls.push("promote") },
      userDirectory: { setCodexAccount: (userId, account) => calls.push(["account", userId, account]) },
    },
  });
  const host = {
    completeWorkspaceFork: () => false,
    closeArchivedWorkspaceBackend: () => calls.push("closeWorkspace"),
  };
  Object.assign(service.ctx, overrides.ctx ?? {});
  Object.assign(host, overrides.host ?? {});
  return { calls, host, service };
}

function state() {
  return {
    ownerUserId: "alice",
    turnEpochs: new Map(),
    filesystem: { owns: () => false },
  };
}

const connection = {};

test("a stale turn response is fenced before it mutates public projection", () => {
  const { calls, host, service } = harness({
    ctx: { threadExecution: { table: { get: () => ({ epoch: 4 }) } } },
  });
  service.handle(state(), { id: "backend", result: { turn: { id: "turn-1" } } }, {
    connection,
    clientId: "client",
    outerThreadId: "thread-1",
    method: "turn/start",
    authorityEpoch: 3,
  }, host);
  assert.deepEqual(calls, []);
});

test("history pages remain wire responses and never mutate the public read model", () => {
  const turns = harness();
  turns.service.handle(state(), { result: { data: [{ id: "turn-1", items: [] }] } }, {
    connection,
    clientId: 1,
    outerThreadId: "thread-1",
    method: "thread/turns/list",
  }, turns.host);
  assert.deepEqual(turns.calls, [
    "project",
    ["send", { result: { data: [{ id: "turn-1", items: [] }] }, id: 1 }],
  ]);

  const items = harness();
  items.service.handle(state(), { result: { data: [{ turnId: "turn-1", item: { id: "item-1" } }] } }, {
    connection,
    clientId: 2,
    outerThreadId: "thread-1",
    method: "thread/items/list",
  }, items.host);
  assert.deepEqual(items.calls, [
    "project",
    ["send", {
      result: { data: [{ turnId: "turn-1", item: { id: "item-1" } }] },
      id: 2,
    }],
  ]);
});

test("collaboration fallback preserves its catalog payload without path projection", () => {
  const fallback = { data: [{ name: "Default" }] };
  const { calls, host, service } = harness({
    ctx: { collaborationMode: { fallbackFor: () => fallback } },
  });
  service.handle(state(), { id: "backend", error: { code: -32601, message: "missing" } }, {
    connection,
    clientId: 9,
    outerThreadId: null,
    method: "collaborationMode/list",
  }, host);
  assert.deepEqual(calls.at(-1), ["send", { id: 9, result: fallback }]);
});

test("archive commits the control-plane state before broadcasting and retiring runtime", () => {
  const { calls, host, service } = harness();
  service.handle(state(), { result: {} }, {
    connection,
    clientId: 3,
    outerThreadId: "thread-1",
    method: "thread/archive",
  }, host);
  assert.deepEqual(calls, [
    "archive",
    "project",
    ["send", { result: {}, id: 3 }],
    "thread/archived",
    "closeWorkspace",
  ]);
});
