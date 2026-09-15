import assert from "node:assert/strict";
import test from "node:test";

import {
  TransparentRuntimeLocatorService,
} from "../src/services/transparent-runtime-locator.ts";
import { threadRuntimeBackendKey } from "../src/services/transparent-thread-routing.ts";

function locator(overrides = {}) {
  const localFilesystem = { kind: "local" };
  const workspaceFilesystem = { kind: "workspace" };
  const runtimeHints = overrides.runtimeHints ?? new Map();
  const bindings = overrides.bindings ?? new Map();
  const backends = overrides.backends ?? new Map();
  const executions = overrides.executions ?? new Map();
  const threads = overrides.threads ?? new Map();
  const service = Object.assign(Object.create(TransparentRuntimeLocatorService.prototype), {
    ctx: {
      runtimeWorkspace: {
        enabled: true,
        filesystemForRealm: (realm) => (
          realm === "workspace" ? workspaceFilesystem : localFilesystem
        ),
        isWorkspaceFilesystem: (filesystem) => filesystem === workspaceFilesystem,
        viewIdForThread: () => "main",
      },
      threadExecution: { table: executions },
      threadManager: {
        find: (threadId) => threads.get(threadId) ?? null,
        ownerOf: () => "user:owner",
      },
      transparentBackendRegistry: { backends },
      transparentThreadBinding: {
        bindings,
        runtimeHintFor: (threadId) => runtimeHints.get(threadId) ?? null,
      },
    },
  });
  return { service, localFilesystem, backends, executions, runtimeHints };
}

test("runtime locator prefers the active execution runtime over durable routing hints", () => {
  const active = { backendKey: "runtime:active" };
  const hinted = { backendKey: "runtime:hinted" };
  const { service, localFilesystem, backends, executions, runtimeHints } = locator();
  backends.set(active.backendKey, active);
  backends.set(hinted.backendKey, hinted);
  executions.set("thread", {
    connection: { connectionId: "owner" },
    epoch: 7,
    runtimeId: active.backendKey,
  });
  runtimeHints.set("thread", {
    ownerUserId: "user:owner",
    backendKey: hinted.backendKey,
  });

  assert.equal(service.stateForOuter("thread", localFilesystem), active);
  assert.equal(service.ownerConnection(active, "thread").connectionId, "owner");
  assert.equal(service.ownerEpoch(active, "thread"), 7);
  assert.equal(service.ownerConnection(hinted, "thread"), null);
  assert.equal(service.ownerEpoch(hinted, "thread"), undefined);
});

test("runtime locator falls back from a stale active runtime to a live hinted runtime", () => {
  const hinted = { backendKey: "runtime:hinted" };
  const { service, localFilesystem, backends, executions, runtimeHints } = locator();
  backends.set(hinted.backendKey, hinted);
  executions.set("thread", {
    connection: { connectionId: "owner" },
    epoch: 3,
    runtimeId: "runtime:gone",
  });
  runtimeHints.set("thread", {
    ownerUserId: "user:owner",
    backendKey: hinted.backendKey,
  });

  assert.equal(service.stateForOuter("thread", localFilesystem), hinted);
});

test("runtime locator derives the isolated backend from public thread routing facts", () => {
  const bindings = new Map([["thread", { realm: "workspace", viewId: "fork-7" }]]);
  const { service, localFilesystem, backends } = locator({ bindings });
  const key = threadRuntimeBackendKey(
    "user:owner",
    "workspace",
    "fork-7",
    "thread",
  );
  const isolated = { backendKey: key };
  backends.set(key, isolated);

  assert.equal(service.stateForOuter("thread", localFilesystem), isolated);
});
