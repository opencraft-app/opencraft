import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceAttachmentService } from "../src/services/workspace-attachment.ts";

function service() {
  const value = Object.create(WorkspaceAttachmentService.prototype);
  value.attachments = new Map();
  value.sequence = 0;
  value.driver = {
    enabled: false,
  };
  return value;
}

const filesystem = {
  owns(path) { return typeof path === "string" && path.startsWith("/workspace/"); },
};

test("one engine attaches idempotently to one workspace view and detaches by reference", () => {
  const attachments = service();
  const first = attachments.attach({
    threadId: "thread-a", engineId: "engine-a", viewId: "fork-a",
    cwd: "/workspace/projects/repo", filesystem, principal: "alice",
  });
  const second = attachments.attach({
    threadId: "thread-a", engineId: "engine-a", viewId: "fork-a",
    cwd: "/workspace/projects/repo", filesystem, principal: "alice",
  });
  assert.equal(first, second);
  assert.equal(attachments.snapshot()[0].references, 2);
  assert.equal(first.detach("turnCompleted"), false);
  assert.equal(attachments.find("thread-a", "engine-a"), first);
  assert.equal(second.detach("engineStopped"), true);
  assert.equal(attachments.find("thread-a", "engine-a"), null);
});

test("an engine cannot silently switch views while attached", () => {
  const attachments = service();
  attachments.attach({
    threadId: "thread-a", engineId: "engine-a", viewId: "main",
    cwd: "/workspace/projects/repo", filesystem,
  });
  assert.throws(() => attachments.attach({
    threadId: "thread-a", engineId: "engine-a", viewId: "fork-a",
    cwd: "/workspace/projects/repo", filesystem,
  }), /different workspace view/);
});

test("attachment rejects a cwd outside the selected filesystem", () => {
  const attachments = service();
  assert.throws(() => attachments.attach({
    threadId: "thread-a", engineId: "engine-a", viewId: "main",
    cwd: "/etc", filesystem,
  }), /not owned/);
});

test("v2 attachment delegates only the current principal capability to the host", () => {
  const calls = [];
  const driver = {
    enabled: true,
    createWorkspace(threadId) {
      calls.push(["createWorkspace", threadId]);
      return { workspace: { id: threadId, driver: "test" }, becameRoot: false };
    },
    attachWorkspace(...args) {
      calls.push(["attachWorkspace", ...args]);
      return { id: "native-1", endpoint: { transport: "ssh", host: "127.0.0.1", port: 2201 } };
    },
    detachWorkspace(id) { calls.push(["detachWorkspace", id]); },
  };
  const attachments = service();
  attachments.driver = driver;
  const mountedFilesystem = { ...filesystem, mount: "/workspace" };
  const handle = attachments.attach({
    threadId: "thread-a", engineId: "engine-a", cwd: "/workspace/projects/repo",
    filesystem: mountedFilesystem, principal: { id: "principal-a", username: "alice" },
  });
  assert.deepEqual(calls[0], ["createWorkspace", "thread-a"]);
  assert.deepEqual(calls[1], ["attachWorkspace", "thread-a", { id: "principal-a", username: "alice" }, "readWrite"]);
  assert.equal(handle.endpoint.port, 2201);
	assert.equal(handle.capabilityId, "native-1");
  handle.detach();
  assert.deepEqual(calls[2], ["detachWorkspace", "native-1"]);
});
