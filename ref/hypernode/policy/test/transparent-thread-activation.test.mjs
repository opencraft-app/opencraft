import assert from "node:assert/strict";
import test from "node:test";

import { TransparentThreadActivationService } from
  "../src/services/transparent-thread-activation.ts";

function harness(overrides = {}) {
  const service = Object.create(TransparentThreadActivationService.prototype);
  const controls = {
    isRoot: () => false,
    hasAgent: () => true,
    isTransparent: () => false,
    thread: () => ({ cwd: "/workspace/projects/mono2" }),
    metadata: () => ({ kind: "conversation" }),
    filesystem: () => ({}),
    promote: () => true,
    ...overrides,
  };
  service.ctx = {
    administrator: { hasAgent: controls.hasAgent },
    runtimeWorkspace: {
      enabled: true,
      projectsRoot: () => "/workspace/projects",
      bindMain: () => {},
    },
    threadManager: {
      isRoot: controls.isRoot,
      isTransparentCodex: controls.isTransparent,
      find: controls.thread,
      metadataFor: controls.metadata,
      promoteToTransparentCodex: controls.promote,
      changed: () => {},
    },
    transparentRuntimeAccess: {
      filesystemForCwd: controls.filesystem,
      defaultFilesystem: () => ({}),
    },
  };
  return { service };
}

const connection = { identity: { id: "user:alice" } };

test("explicit management skills remain outside the execution compatibility boundary", () => {
  const { service } = harness();
  const decision = service.activate({
    connection,
    threadId: "root",
    message: {
      method: "turn/start",
      params: { threadId: "root", input: [{ type: "text", text: "$users" }] },
    },
  });
  assert.equal(decision, "pass");
});

test("the root thread stays deterministic until its administrator Agent is enabled", () => {
  const { service } = harness({
    isRoot: () => true,
    hasAgent: () => false,
  });
  assert.equal(service.activate({
    connection,
    threadId: "root",
    message: { method: "turn/start", params: { threadId: "root", input: [] } },
  }), "pass");
});

test("history requests never materialize an ordinary thread execution binding", () => {
  const { service } = harness();
  assert.equal(service.activate({
    connection,
    threadId: "thread-1",
    message: { method: "thread/read", params: { threadId: "thread-1" } },
  }), "pass");
});

test("the first routable Turn promotes an ordinary conversation exactly once", () => {
  let promotions = 0;
  const { service } = harness({
    promote: () => {
      promotions += 1;
      return true;
    },
  });
  assert.equal(service.activate({
    connection,
    threadId: "thread-1",
    message: {
      method: "turn/start",
      params: { threadId: "thread-1", cwd: "/workspace/projects/mono2", input: [] },
    },
  }), "ready");
  assert.equal(promotions, 1);
});

test("the first Turn repairs an ordinary conversation created with a Desktop host cwd", () => {
  const thread = { id: "thread-1", cwd: "/vela" };
  let changed = 0;
  let bound = 0;
  const { service } = harness({
    thread: () => thread,
    filesystem: () => null,
  });
  service.ctx.runtimeWorkspace.bindMain = () => { bound += 1; };
  service.ctx.threadManager.changed = () => { changed += 1; };

  assert.equal(service.activate({
    connection,
    threadId: "thread-1",
    message: { method: "turn/start", params: { threadId: "thread-1", input: [] } },
  }), "ready");
  assert.equal(thread.cwd, "/workspace/projects");
  assert.equal(bound, 1);
  assert.equal(changed, 1);
});

test("an already transparent thread bypasses materialization checks", () => {
  const { service } = harness({
    isTransparent: () => true,
    filesystem: () => null,
    promote: () => false,
  });
  assert.equal(service.activate({
    connection,
    threadId: "thread-1",
    message: { method: "thread/read", params: { threadId: "thread-1" } },
  }), "ready");
});
