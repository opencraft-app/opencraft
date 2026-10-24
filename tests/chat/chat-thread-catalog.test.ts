import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
import { projectAppServerThread } from "@opencraft/workbench-runtime";

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "01a0473e-1f50-7a56-a9af-d656b84deb09",
    name: "☁️ skip发布运维用",
    preview: "skip发布运维用",
    cwd: "/data/opencraft",
    updatedAt: 100,
    status: { type: "idle" },
    forkedFromId: null,
    parentThreadId: null,
    ...overrides,
  } as Thread;
}

test("same-title root, fork and subagent Threads retain visible lineage identity", () => {
  const root = projectAppServerThread(thread({}), 100_000);
  const fork = projectAppServerThread(thread({ forkedFromId: "root-thread" }), 100_000);
  const subagent = projectAppServerThread(thread({ parentThreadId: "parent-thread" }), 100_000);

  assert.equal(root.title, "skip发布运维用");
  assert.equal(root.project, "opencraft");
  assert.equal(root.lineage, "root");
  assert.equal(fork.lineage, "fork");
  assert.equal(subagent.lineage, "subagent");
});

test("AppServer loading and failure states retain their product meaning", () => {
  assert.equal(projectAppServerThread(thread({ status: { type: "notLoaded" } }), 100_000).status, "ready");
  assert.equal(projectAppServerThread(thread({ status: { type: "idle" } }), 100_000).status, "ready");
  assert.equal(projectAppServerThread(thread({ status: { type: "active", activeFlags: [] } }), 100_000).status, "running");
  assert.equal(projectAppServerThread(thread({ status: { type: "systemError" } }), 100_000).status, "error");
});

test("catalog preserves native creation and recency separately for active ordering", () => {
  const projected = projectAppServerThread(thread({ createdAt: 10, updatedAt: 300, recencyAt: 200 }), 300_000);
  assert.equal(projected.createdAt, 10);
  assert.equal(projected.updatedAt, 200);
  assert.equal(projectAppServerThread(thread({ updatedAt: 300 })).updatedAt, 300);
});
