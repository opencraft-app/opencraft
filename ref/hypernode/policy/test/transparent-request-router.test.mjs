import assert from "node:assert/strict";
import test from "node:test";
import { TransparentRequestRouterService } from
  "../src/services/transparent-request-router.ts";

const router = Object.create(TransparentRequestRouterService.prototype);
const connection = { identity: { id: "user-1" } };

test("transparent request router leaves outer catalog mutations to the catalog owner", () => {
  assert.deepEqual(router.classify({
    id: "request-1",
    method: "thread/metadata/update",
    params: { threadId: "thread-1" },
  }, connection), {
    kind: "pass",
    reason: "outerCatalog",
  });
});

test("thread goals stay in the engine-neutral outer metadata plane", () => {
  for (const method of ["thread/goal/get", "thread/goal/set", "thread/goal/clear"]) {
    assert.deepEqual(router.classify({
      id: `request:${method}`,
      method,
      params: { threadId: "thread-1" },
    }, connection), {
      kind: "pass",
      reason: "outerCatalog",
    });
  }
});

test("Desktop MCP App requests stay on the host even when they carry thread context", () => {
  for (const method of [
    "mcpServerStatus/list",
    "mcpServer/resource/read",
    "mcpServer/tool/call",
  ]) {
    assert.deepEqual(router.classify({
      id: `request:${method}`,
      method,
      params: {
        connectorId: "hypernode-calculator",
        server: "hypernode-calculator",
        threadId: "thread-1",
      },
    }, connection), {
      kind: "pass",
      reason: "localCapability",
    });
  }
});

test("transparent request router distinguishes backend responses and notifications", () => {
  assert.deepEqual(router.classify({ id: "backend-1", result: {} }, connection), {
    kind: "backendServerResponse",
    message: { id: "backend-1", result: {} },
  });
  assert.deepEqual(router.classify({ method: "thread/started", params: {} }, connection), {
    kind: "pass",
    reason: "notification",
  });
});

test("transparent request router classifies thread protocol operations", () => {
  for (const [method, operation] of [
    ["thread/resume", "history"],
    ["thread/settings/update", "settings"],
    ["thread/fork", "fork"],
    ["turn/start", "turnStart"],
    ["turn/steer", "turnSteer"],
    ["turn/interrupt", "turnInterrupt"],
    ["thread/queue/add", "queue"],
    ["thread/queue/start", "queue"],
    ["custom/thread/action", "forward"],
  ]) {
    assert.deepEqual(router.classify({
      id: `request:${method}`,
      method,
      params: { threadId: "thread-1" },
    }, connection), {
      kind: "thread",
      message: {
        id: `request:${method}`,
        method,
        params: { threadId: "thread-1" },
      },
      threadId: "thread-1",
      operation,
    });
  }
});

test("transparent request router keeps thread creation separate from existing threads", () => {
  assert.deepEqual(router.classify({
    id: "start-1",
    method: "thread/start",
    params: { cwd: "/workspace/projects/demo" },
  }, connection), {
    kind: "threadStartCandidate",
    message: {
      id: "start-1",
      method: "thread/start",
      params: { cwd: "/workspace/projects/demo" },
    },
    cwd: "/workspace/projects/demo",
  });
});

test("transparent request router does not steal user controls before identity exists", () => {
  const request = { id: "account-1", method: "account/read", params: {} };
  assert.deepEqual(router.classify(request, { identity: null }), {
    kind: "pass",
    reason: "missingThreadId",
  });
  assert.deepEqual(router.classify(request, connection), {
    kind: "userBackendControl",
    message: request,
  });
});
