import assert from "node:assert/strict";
import test from "node:test";
import { TransparentBackendOutboundService } from "../src/services/transparent-backend-outbound.ts";

const state = {
  backendKey: "runtime-1",
  connections: new Set(),
  filesystem: { toVirtual: (path) => path },
};

function harness(overrides = {}) {
  const calls = [];
  const owner = { name: "owner" };
  const reverseBindings = new Map([["inner-1", "outer-1"]]);
  const ctx = {
    transparentThreadBinding: { reverseBindings },
    transparentProtocolMapper: {
      outerThreadId: () => "outer-1",
      toOuter: (message) => ({ ...message, params: { threadId: "outer-1" } }),
      toVirtual: (path) => path,
    },
    transparentRuntimeLocator: { ownerConnection: () => owner },
    transparentRuntimeAccess: { filesystem: (candidate) => candidate.filesystem },
    transparentBackendChannel: {
      nextServerRequestId: () => "public-1",
      isStaleAuthorityMessage: () => false,
      send: (...args) => calls.push(["send", ...args]),
      broadcast: (_state, notification) => calls.push(["broadcast", notification]),
      broadcastCatalog: (...args) => calls.push(["catalog", ...args]),
    },
    transparentBackendRpc: {
      trackServerRequest: (_state, publicId, request) =>
        calls.push(["track", publicId, request.innerId, request.connection]),
    },
    transparentBackendIngress: { backendThreadId: () => "inner-1" },
    appServerProjection: {
      prepare: (method, params) => {
        calls.push("canonical");
        return { method, params };
      },
    },
    transparentBackendProjection: {
      projectBackend: () => calls.push("read-model"),
    },
    ...overrides,
  };
  const service = Object.assign(
    Object.create(TransparentBackendOutboundService.prototype),
    { ctx },
  );
  return { calls, ctx, owner, service };
}

test("server requests retain native correlation while exposing a public id", () => {
  const { calls, owner, service } = harness();
  service.handleServerRequest(state, {
    id: "inner-request",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "inner-1" },
  });
  assert.deepEqual(calls, [
    ["track", "public-1", "inner-request", owner],
    ["send", owner, {
      id: "public-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "outer-1" },
    }],
  ]);
});

test("stale reverse bindings are fenced before canonical projection", () => {
  const { calls, ctx, service } = harness();
  ctx.transparentProtocolMapper.outerThreadId = () => null;
  service.handleNotification(state, {
    method: "turn/started",
    params: { threadId: "inner-1" },
  });
  assert.deepEqual(calls, []);
});

test("execution notifications commit canonical facts before read-model projection and fanout", () => {
  const { calls, ctx, service } = harness();
  ctx.appServerProjection.prepare = (method, params) => {
    calls.push("canonical");
    return { method, params: { ...params, committed: true } };
  };
  service.handleNotification(state, {
    method: "turn/completed",
    params: { threadId: "inner-1" },
  });
  assert.deepEqual(calls, [
    "canonical",
    "read-model",
    ["broadcast", {
      method: "turn/completed",
      params: { threadId: "outer-1", committed: true },
    }],
  ]);
});

test("catalog lifecycle notifications use the global fanout path", () => {
  const { calls, service } = harness();
  service.handleNotification(state, {
    method: "thread/archived",
    params: { threadId: "inner-1" },
  });
  assert.deepEqual(calls, [
    "canonical",
    "read-model",
    ["catalog", "thread/archived", "outer-1", {
      method: "thread/archived",
      params: { threadId: "outer-1" },
    }],
  ]);
});
