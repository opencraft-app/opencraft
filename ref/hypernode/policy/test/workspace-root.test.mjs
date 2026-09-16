import assert from "node:assert/strict";
import test from "node:test";
import { ThreadManagerService } from "../src/services/thread-manager.js";
import {
  allocateWorkspaceForThread,
  establishWorkspaceRoot,
  ordinaryWorkspaceThread,
} from "../src/services/workspace-root.ts";

function manager() {
  const value = Object.create(ThreadManagerService.prototype);
  value.principal = { id: "alice" };
  value.threads = new Map();
  value.metadata = new Map();
  value.archivedThreadIds = new Set();
  value.createListeners = new Set();
  value.archiveGuards = new Set();
  value.archiveListeners = new Set();
  value.unarchiveListeners = new Set();
  value.titleService = null;
  value.persist = () => {};
  value.invalidateCatalog = () => {};
  return value;
}

test("create lifecycle rolls back a Thread when workspace allocation fails", () => {
  const threads = manager();
  threads.onCreate(() => { throw new Error("snapshot failed"); });
  assert.throws(() => threads.create({ cwd: "/workspace/projects" }, { id: "thread-a" }), /snapshot failed/);
  assert.equal(threads.find("thread-a"), null);
  assert.equal(threads.metadataFor("thread-a"), null);
});

test("archive guards run before a Thread becomes archived", () => {
  const threads = manager();
  threads.create({ cwd: "/workspace/projects" }, { id: "root" });
  threads.addArchiveGuard((threadId) => {
    if (threadId === "root") throw new Error("root workspace conversation cannot be archived");
  });
  assert.throws(() => threads.archive("root"), /cannot be archived/);
  assert.equal(threads.isArchived("root"), false);
});

test("only ordinary durable workspace conversations receive workspace forks", () => {
  assert.equal(ordinaryWorkspaceThread({ cwd: "/workspace/projects", ephemeral: false }, { kind: "conversation" }), true);
  assert.equal(ordinaryWorkspaceThread({ cwd: "/workspace/projects" }, { kind: "transparentCodex" }), true);
  assert.equal(ordinaryWorkspaceThread({ cwd: "/workspace/projects", ephemeral: true }, { kind: "conversation" }), false);
  assert.equal(ordinaryWorkspaceThread({ cwd: "/workspace/projects" }, { kind: "management" }), false);
  assert.equal(ordinaryWorkspaceThread({ cwd: "/workspace/projects" }, { kind: "all" }), false);
  assert.equal(ordinaryWorkspaceThread({ cwd: "/localhost/project" }, { kind: "conversation" }), false);
});

test("the node management Thread is the only workspace root", () => {
  let root = null;
  const ensured = [];
  const hostWorkspaces = {
    root: () => root,
    createWorkspace: (threadId) => {
      ensured.push(threadId);
      root = { threadId, workspace: { id: threadId, driver: "test" } };
      return { workspace: root.workspace, becameRoot: true };
    },
  };
  assert.deepEqual(establishWorkspaceRoot(hostWorkspaces, "management-root"), root);
  assert.deepEqual(ensured, ["management-root"]);
  assert.deepEqual(establishWorkspaceRoot(hostWorkspaces, "management-root"), root);
  assert.deepEqual(ensured, ["management-root"]);
});

test("a conflicting durable workspace root requires explicit migration", () => {
  const hostWorkspaces = {
    root: () => ({ threadId: "legacy-root", workspace: { id: "legacy", driver: "test" } }),
    createWorkspace: () => assert.fail("must not mutate a conflicting root"),
  };
  assert.throws(
    () => establishWorkspaceRoot(hostWorkspaces, "management-root"),
    (error) => error.code === -32073 && error.data?.kind === "workspaceRootMigrationRequired",
  );
});

test("ordinary Threads fork the node root unless they name an explicit source", () => {
  const calls = [];
  const hostWorkspaces = {
    forkWorkspace: (sourceThreadId, destinationThreadId) => {
      calls.push([sourceThreadId, destinationThreadId]);
      return { id: destinationThreadId, driver: "test" };
    },
  };
  const thread = { id: "task-a", cwd: "/workspace/projects/demo" };
  assert.deepEqual(
    allocateWorkspaceForThread(hostWorkspaces, "management-root", thread, { kind: "conversation" }),
    { id: "task-a", driver: "test" },
  );
  allocateWorkspaceForThread(hostWorkspaces, "management-root", { ...thread, id: "task-b" }, {
    kind: "conversation",
    workspaceSourceThreadId: "task-a",
  });
  assert.deepEqual(calls, [["management-root", "task-a"], ["task-a", "task-b"]]);
});
