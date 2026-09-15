import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceDriverService } from "../src/services/workspace-driver.ts";

function driver() {
  const value = Object.create(WorkspaceDriverService.prototype);
  value.enabled = globalThis.hostWorkspaces?.enabled === true;
  return value;
}

test("workspace driver maps policy resource verbs to the host ABI", () => {
  const previous = globalThis.hostWorkspaces;
  const calls = [];
  let root = null;
  globalThis.hostWorkspaces = {
    enabled: true,
    root: () => root,
    status: () => ({ enabled: true, driver: "test" }),
    ensureThread(threadId) {
      calls.push(["ensureThread", threadId]);
      root ??= { threadId, workspace: { id: threadId, driver: "test" } };
      return { workspace: root.workspace, becameRoot: root.threadId === threadId };
    },
    forkThread(source, destination) {
      calls.push(["forkThread", source, destination]);
      return { id: destination, driver: "test" };
    },
    deleteThread(threadId) { calls.push(["deleteThread", threadId]); },
    attach(...args) {
      calls.push(["attach", ...args]);
      return { id: "attachment-a", endpoint: { host: "127.0.0.1", port: 2201 } };
    },
    detach(id) { calls.push(["detach", id]); },
  };
  try {
    const workspaces = driver();
    assert.equal(workspaces.enabled, true);
    workspaces.createWorkspace("root");
    assert.equal(workspaces.root().threadId, "root");
    assert.deepEqual(workspaces.forkWorkspace("root", "task-a"), { id: "task-a", driver: "test" });
    assert.equal(
      workspaces.attachWorkspace("task-a", { id: "alice", username: "alice" }, "readWrite").id,
      "attachment-a",
    );
    workspaces.detachWorkspace("attachment-a");
    workspaces.deleteWorkspace("task-a");
    assert.deepEqual(calls, [
      ["ensureThread", "root"],
      ["forkThread", "root", "task-a"],
      ["attach", "task-a", "alice", "alice", "readWrite"],
      ["detach", "attachment-a"],
      ["deleteThread", "task-a"],
    ]);
  } finally {
    globalThis.hostWorkspaces = previous;
  }
});
