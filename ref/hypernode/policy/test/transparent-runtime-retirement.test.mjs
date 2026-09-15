import assert from "node:assert/strict";
import test from "node:test";

import {
  TransparentRuntimeRetirementService,
} from "../src/services/transparent-runtime-retirement.ts";

function fixture() {
  const backends = new Map();
  const executions = new Map();
  const subscriptions = new Set();
  const calls = [];
  const localFilesystem = { kind: "local" };
  const statesByThread = new Map();
  const service = Object.assign(
    Object.create(TransparentRuntimeRetirementService.prototype),
    {
      ctx: {
        executionEngine: {
          retireThread: (threadId) => {
            calls.push(["engine", threadId]);
            return false;
          },
        },
        runtimeWorkspace: { recordFor: () => null },
        threadExecution: { table: executions },
        transparentBackendLifecycle: {
          closeProcess: (state, threadId) => {
            calls.push(["close", state.backendKey, threadId]);
            return true;
          },
          retireIsolated: (state, threadId, strict) => {
            calls.push(["isolated", state?.backendKey, threadId, strict]);
            return Boolean(state);
          },
        },
        transparentBackendRegistry: { backends },
        transparentRuntimeAccess: { localFilesystem },
        transparentRuntimeLocator: {
          stateForOuter: (threadId, filesystem) => {
            calls.push(["locate", threadId, filesystem]);
            return statesByThread.get(threadId) ?? null;
          },
        },
        transparentSubscription: {
          hasSubscribers: (threadId) => subscriptions.has(threadId),
        },
      },
    },
  );
  return {
    service,
    backends,
    executions,
    subscriptions,
    calls,
    statesByThread,
    localFilesystem,
  };
}

test("runtime retirement preserves subscribed and actively executing runtimes", () => {
  const { service, subscriptions, executions, calls } = fixture();
  subscriptions.add("subscribed");
  executions.set("active", { connection: {}, epoch: 1, runtimeId: "runtime:active" });

  assert.equal(service.retireThreadRuntimeIfIdle("subscribed"), false);
  assert.equal(service.retireThreadRuntimeIfIdle("active"), false);
  assert.deepEqual(calls, []);
});

test("runtime retirement gives an engine adapter first right of retirement", () => {
  const { service, calls } = fixture();
  service.ctx.executionEngine.retireThread = (threadId) => {
    calls.push(["engine", threadId]);
    return true;
  };

  assert.equal(service.retireThreadRuntimeIfIdle("thread"), true);
  assert.deepEqual(calls, [["engine", "thread"]]);
});

test("runtime retirement falls back to the located isolated Codex runtime", () => {
  const { service, calls, statesByThread, localFilesystem } = fixture();
  statesByThread.set("thread", { backendKey: "runtime:codex" });

  assert.equal(service.retireThreadRuntimeIfIdle("thread"), true);
  assert.deepEqual(calls, [
    ["engine", "thread"],
    ["locate", "thread", localFilesystem],
    ["isolated", "runtime:codex", "thread", false],
  ]);
});

test("archived fork retirement is fenced by realm and workspace view", () => {
  const { service, calls } = fixture();
  service.ctx.runtimeWorkspace.recordFor = () => ({
    kind: "fork",
    deleted: true,
    viewId: "fork-7",
  });
  const matching = {
    backendKey: "runtime:fork",
    realm: "workspace",
    viewId: "fork-7",
  };
  const stale = { ...matching, viewId: "fork-old" };

  service.closeArchivedWorkspaceBackend("thread", stale);
  service.closeArchivedWorkspaceBackend("thread", matching);
  assert.deepEqual(calls, [
    ["close", "runtime:fork", "thread"],
  ]);
});

test("user retirement defers live runtimes and retires idle shared and isolated runtimes", () => {
  const { service, backends, executions, calls } = fixture();
  backends.set("live", { backendKey: "live", ownerUserId: "user", isolatedOuterThreadId: null });
  backends.set("isolated", {
    backendKey: "isolated",
    ownerUserId: "user",
    isolatedOuterThreadId: "thread-isolated",
  });
  backends.set("shared", { backendKey: "shared", ownerUserId: "user", isolatedOuterThreadId: null });
  backends.set("other", { backendKey: "other", ownerUserId: "other", isolatedOuterThreadId: null });
  executions.set("thread-live", { connection: {}, epoch: 2, runtimeId: "live" });

  assert.deepEqual(service.retireIdleUserBackends("user"), {
    retired: 2,
    deferred: 1,
  });
  assert.deepEqual(calls, [
    ["isolated", "isolated", "thread-isolated", false],
    ["close", "shared", null],
  ]);
});
