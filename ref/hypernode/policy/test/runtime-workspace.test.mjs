import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeWorkspaceService } from "../src/services/runtime-workspace.ts";

function createService({ enabled = true, supportsPersistentRuntimeFencing = false } = {}) {
  const calls = [];
  const workspaceFilesystem = {
    enabled,
    supportsPersistentRuntimeFencing,
    mount: "/workspace",
    owns: (path) => path.startsWith("/workspace"),
    terminateThreadRuntime: (...args) => calls.push(["terminate", ...args]),
  };
  const workspaceView = {
    prepareStartParams: (params) => ({ ...params, prepared: true }),
    bindMain: (thread) => calls.push(["bindMain", thread]),
    recordFor: (threadId) => ({ threadId, viewId: "view-1", kind: "fork" }),
    viewIdForThread: (threadId) => `view:${threadId}`,
    assertRuntimeAvailable: (threadId) => calls.push(["assert", threadId]),
    projectsRoot: (viewId = "main") => `/workspace/@${viewId}/projects`,
    fork: (params, connection, options) => ({
      thread: { id: params.threadId, cwd: params.cwd },
      connection,
      options,
    }),
    archive: (thread) => calls.push(["archive", thread.id]),
    discardFork: (threadId) => calls.push(["discard", threadId]),
  };
  const service = Object.create(RuntimeWorkspaceService.prototype);
  service.ctx = { workspaceFilesystem, workspaceView };
  return { service, workspaceFilesystem, calls };
}

test("runtime Workspace port selects filesystems without exposing the concrete driver", () => {
  const { service, workspaceFilesystem } = createService();
  const local = {
    enabled: true,
    mount: "/localhost",
    owns: (path) => path.startsWith("/localhost"),
  };

  assert.equal(service.defaultFilesystem(local), workspaceFilesystem);
  assert.equal(service.filesystemForCwd("/workspace/projects/repo", local), workspaceFilesystem);
  assert.equal(service.filesystemForCwd("/localhost/repo", local), local);
  assert.equal(service.filesystemForCwd("/outside", local), null);
  assert.equal(service.filesystemForRealm("workspace", local), workspaceFilesystem);
  assert.equal(service.filesystemForRealm("localhost", local), local);
  assert.equal(service.isWorkspaceFilesystem(workspaceFilesystem), true);
  assert.equal(service.isWorkspaceFilesystem(local), false);
  assert.equal(service.supportsPersistentRuntimeFencing, false);
});

test("runtime Workspace port delegates view lifecycle through one typed boundary", () => {
  const { service, calls } = createService();
  const connection = { id: "connection-1" };
  const params = { threadId: "thread-1", cwd: "/workspace/projects/repo" };

  assert.deepEqual(service.prepareStartParams(params), { ...params, prepared: true });
  assert.equal(service.viewIdForThread("thread-1"), "view:thread-1");
  assert.equal(service.projectsRoot("fork-1"), "/workspace/@fork-1/projects");
  assert.equal(service.recordFor("thread-1").viewId, "view-1");
  assert.equal(service.fork(params, connection).thread.id, "thread-1");

  service.bindMain({ id: "thread-1", cwd: "/workspace/projects/repo" });
  service.assertRuntimeAvailable("thread-1");
  service.archive({ id: "thread-1", cwd: "/workspace/projects/repo" });
  service.discardFork("thread-1");
  service.terminateThreadRuntime("process-1", "view-1", "thread-1", 5000);

  assert.deepEqual(calls, [
    ["bindMain", { id: "thread-1", cwd: "/workspace/projects/repo" }],
    ["assert", "thread-1"],
    ["archive", "thread-1"],
    ["discard", "thread-1"],
    ["terminate", "process-1", "view-1", "thread-1", 5000],
  ]);
});

test("disabled Workspace falls back to the local runtime filesystem", () => {
  const { service } = createService({ enabled: false });
  const local = { owns: () => true };

  assert.equal(service.defaultFilesystem(local), local);
  assert.equal(service.filesystemForRealm("workspace", local), local);
});
