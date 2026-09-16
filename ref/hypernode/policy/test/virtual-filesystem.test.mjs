import assert from "node:assert/strict";
import test from "node:test";

import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";
import { createLocalExecutionFilesystem } from "../src/services/local-execution-filesystem.ts";

test("virtual filesystem resolves /localhost beneath the current user's durable home", () => {
  const service = Object.create(VirtualFilesystemService.prototype);
  service.physicalRoot = "/deployment";
  const user = { homePath: "/users/alice" };

  assert.equal(service.toPhysical("/localhost", user), "/users/alice");
  assert.equal(service.toPhysical("/localhost/project/src", user), "/users/alice/project/src");
  assert.equal(service.toVirtual("/users/alice/project/src", user), "/localhost/project/src");
});

test("execution-only Codex home alias resolves without widening the public VFS owner", () => {
  const service = Object.create(VirtualFilesystemService.prototype);
  service.physicalRoot = "/deployment";
  const user = { homePath: "/users/alice" };
  const execution = createLocalExecutionFilesystem(service);

  assert.equal(service.owns("/workspace/.codex"), false);
  assert.equal(execution.owns("/workspace/.codex"), true);
  assert.equal(execution.owns("/workspace/.codex/visualizations/demo.html"), true);
  assert.equal(execution.toPhysical("/workspace/.codex", user), "/users/alice/.codex");
  assert.equal(
    execution.toPhysical("/workspace/.codex/visualizations/demo.html", user),
    "/users/alice/.codex/visualizations/demo.html",
  );
  assert.equal(execution.toVirtual("/users/alice/.codex", user), "/workspace/.codex");
  assert.equal(
    execution.toVirtual("/users/alice/.codex/visualizations/demo.html", user),
    "/workspace/.codex/visualizations/demo.html",
  );
  assert.equal(execution.owns("/workspace/project"), false);
});

test("ensuring a task cwd is recursive, idempotent, and preserves the virtual boundary", () => {
  const service = Object.create(VirtualFilesystemService.prototype);
  service.physicalRoot = "/deployment";
  const calls = [];
  service.createDirectory = (params, user) => calls.push({ params, user });
  const user = { homePath: "/users/alice" };

  assert.equal(service.ensureWorkingDirectory("/localhost/project/../project", user), "/users/alice/project");
  assert.deepEqual(calls, [{ params: { path: "/localhost/project", recursive: true }, user }]);
  assert.throws(() => service.ensureWorkingDirectory("/workspace", user), /outside \/localhost/);
});
