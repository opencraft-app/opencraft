import assert from "node:assert/strict";
import test from "node:test";

import {
  TransparentConnectionCleanupService,
} from "../src/services/transparent-connection-cleanup.ts";

function fixture() {
  const calls = [];
  const connection = { connectionId: "frontend" };
  const state = {
    backendKey: "runtime",
    connections: new Set([connection]),
    ephemeralOuterIds: new Map([[connection, new Set(["ephemeral"])]]),
  };
  const connections = new Map([[connection, new Set([state])]]);
  const service = Object.assign(
    Object.create(TransparentConnectionCleanupService.prototype),
    {
      ctx: {
        transparentBackendRegistry: {
          connections,
          detachConnection: (candidate, frontend) => {
            calls.push(["detach", candidate.backendKey, frontend.connectionId]);
            candidate.connections.delete(frontend);
          },
        },
        transparentBackendRpc: {
          abandonConnection: (candidate, frontend) => {
            calls.push(["abandon", candidate.backendKey, frontend.connectionId]);
          },
        },
        transparentProcessBridge: {
          closeConnectionProcesses: (candidate, frontend, filesystem) => {
            calls.push(["processes", candidate.backendKey, frontend.connectionId, filesystem]);
          },
        },
        transparentRuntimeAccess: { filesystem: () => filesystem },
        transparentRuntimeRetirement: {
          retireThreadRuntimeIfIdle: (threadId) => {
            calls.push(["retire", threadId]);
            return true;
          },
        },
        transparentSubscription: {
          removeConnection: () => ["subscribed"],
        },
        transparentThreadBinding: {
          clearBinding: (threadId) => calls.push(["binding", threadId]),
        },
        threadManager: { forget: (threadId) => calls.push(["forget", threadId]) },
      },
    },
  );
  const filesystem = { kind: "filesystem" };
  return { service, connection, state, connections, calls, filesystem };
}

test("connection cleanup removes process and RPC ownership before retiring runtimes", () => {
  const { service, connection, state, connections, calls, filesystem } = fixture();

  service.close(connection);

  assert.deepEqual(calls, [
    ["processes", "runtime", "frontend", filesystem],
    ["abandon", "runtime", "frontend"],
    ["detach", "runtime", "frontend"],
    ["binding", "ephemeral"],
    ["forget", "ephemeral"],
    ["retire", "subscribed"],
  ]);
  assert.equal(connections.has(connection), false);
  assert.equal(state.connections.has(connection), false);
  assert.equal(state.ephemeralOuterIds.has(connection), false);
});

test("connection cleanup retires orphan subscriptions even without a backend attachment", () => {
  const { service, connection, connections, calls } = fixture();
  connections.delete(connection);

  service.close(connection);

  assert.deepEqual(calls, [["retire", "subscribed"]]);
});

test("connection cleanup is idempotent after every topology edge is gone", () => {
  const { service, connection, connections, calls } = fixture();
  service.ctx.transparentSubscription.removeConnection = () => [];
  connections.delete(connection);

  service.close(connection);
  service.close(connection);

  assert.deepEqual(calls, []);
});
