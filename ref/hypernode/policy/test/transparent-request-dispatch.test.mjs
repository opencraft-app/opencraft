import assert from "node:assert/strict";
import test from "node:test";
import { TransparentRequestDispatchService } from
  "../src/services/transparent-request-dispatch.ts";

function dispatchService(route, overrides = {}) {
  const service = Object.create(TransparentRequestDispatchService.prototype);
  service.ctx = {
    transparentRequestRouter: { classify: () => route },
    transparentBackendRegistry: { connections: new Map() },
    transparentBackendRpc: { takeServerResponse: () => null },
    transparentRuntimeAccess: {
      filesystem: () => ({ send: () => {} }),
      toInner: (message) => message,
    },
    transparentBackendSession: { poll: () => {} },
    transparentControlRouting: { queueControl: () => {} },
    transparentOuterQueue: { enqueue: () => {} },
    transparentModelList: { handle: () => {} },
    transparentThreadAdmission: { handle: () => "handled" },
    transparentThreadActivation: { activate: () => "ready" },
    appServerProjection: { handleHistory: () => true },
    transparentThreadSettings: { update: () => {} },
    transparentThreadQueue: { handle: () => "queueCodex" },
    modelGateway: { selectModelForConnection: () => null },
    transparentWorkspaceControl: { handle: () => "continue" },
    transparentTurnExecution: { handle: () => "queueCodex" },
    ...overrides,
  };
  return service;
}

test("transparent request dispatch polls without consuming the request", () => {
  let polls = 0;
  const service = dispatchService({ kind: "poll" }, {
    transparentBackendSession: { poll: () => { polls += 1; } },
  });
  const handled = service.handle(null, {});

  assert.equal(handled, false);
  assert.equal(polls, 1);
});

test("transparent request dispatch returns backend server responses to their runtime", () => {
  const connection = {};
  const state = { processId: 42 };
  const response = { id: "public-request", result: { ok: true } };
  const forwarded = [];
  const service = dispatchService({
    kind: "backendServerResponse",
    message: response,
  }, {
    transparentBackendRegistry: {
      connections: new Map([[connection, new Set([state])]]),
    },
    transparentBackendRpc: {
      takeServerResponse: () => ({ innerId: "inner-request" }),
    },
    transparentRuntimeAccess: {
      filesystem: () => ({ send: (...args) => forwarded.push(args) }),
      toInner: (message) => ({ ...message }),
    },
  });

  const handled = service.handle(response, connection);

  assert.equal(handled, true);
  assert.deepEqual(forwarded, [[42, { ...response, id: "inner-request" }]]);
});

test("transparent request dispatch applies a selected provider before forwarding", () => {
  const connection = {};
  const message = {
    id: "settings-1",
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "model-public" },
  };
  const updates = [];
  const service = dispatchService({
    kind: "thread",
    message,
    threadId: "thread-1",
    operation: "settings",
  }, {
    modelGateway: {
      selectModelForConnection: () => ({
        kind: "dsh",
        provider: { id: "provider-public" },
      }),
    },
    transparentThreadSettings: {
      update: (...args) => updates.push(args),
    },
  });

  const handled = service.handle(message, connection);

  assert.equal(handled, true);
  assert.deepEqual(updates, [[{
    connection,
    threadId: "thread-1",
    message,
    provider: { id: "provider-public" },
  }]]);
});

test("transparent request dispatch queues the unconsumed request for Codex", () => {
  const connection = {};
  const message = {
    id: "forward-1",
    method: "custom/thread/action",
    params: { threadId: "thread-1" },
  };
  const queued = [];
  const service = dispatchService({
    kind: "thread",
    message,
    threadId: "thread-1",
    operation: "forward",
  }, {
    transparentOuterQueue: { enqueue: (...args) => queued.push(args) },
  });

  const handled = service.handle(message, connection);

  assert.equal(handled, true);
  assert.deepEqual(queued, [[{
    connection,
    outerThreadId: "thread-1",
    action: { connection, message, respondFromOpen: false },
  }]]);
});

test("transparent request dispatch lets the engine-neutral queue consume DSH submissions", () => {
  const connection = {};
  const message = {
    id: "queue-add-1",
    method: "thread/queue/add",
    params: {
      threadId: "thread-1",
      clientUserMessageId: "user-message-1",
      input: [{ type: "text", text: "hello" }],
    },
  };
  const handledByQueue = [];
  const queuedForCodex = [];
  const service = dispatchService({
    kind: "thread",
    message,
    threadId: "thread-1",
    operation: "queue",
  }, {
    transparentThreadQueue: {
      handle: (request) => {
        handledByQueue.push(request);
        return "handled";
      },
    },
    transparentOuterQueue: { enqueue: (request) => queuedForCodex.push(request) },
  });

  assert.equal(service.handle(message, connection), true);
  assert.deepEqual(handledByQueue, [{ connection, message, threadId: "thread-1" }]);
  assert.deepEqual(queuedForCodex, []);
});
