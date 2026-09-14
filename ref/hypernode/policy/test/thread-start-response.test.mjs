import assert from "node:assert/strict";
import test from "node:test";

import {
  threadMetadataUpdateResponse,
  threadStartResponse,
} from "../src/services/thread-protocol.ts";

test("thread/start projects the complete native response required by Desktop", () => {
  const response = threadStartResponse({
    cwd: "/workspace/projects/mono2",
    model: "glm-5.3",
    modelProvider: "hypernode-public-glm-5-3",
    reasoningEffort: "medium",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  }, {
    id: "thread-1",
    cwd: "/workspace/projects/mono2",
    status: { type: "idle" },
    turns: [{ id: "must-not-leak" }],
  });

  assert.deepEqual(response.thread.turns, []);
  assert.equal(response.thread.status.type, "idle");
  assert.equal(response.model, "glm-5.3");
  assert.equal(response.modelProvider, "hypernode-public-glm-5-3");
  assert.equal(response.reasoningEffort, "medium");
  assert.equal(response.approvalPolicy, "never");
  assert.equal(response.approvalsReviewer, "user");
  assert.equal(response.cwd, "/workspace/projects/mono2");
  assert.equal(response.sandbox.type, "dangerFullAccess");
  assert.deepEqual(response.instructionSources, []);
});

test("thread/start always supplies a typed sandbox for lazy DSH runtimes", () => {
  const response = threadStartResponse({ cwd: "/workspace/projects/mono2" }, {
    id: "thread-2",
    cwd: "/workspace/projects/mono2",
    status: { type: "idle" },
    turns: [],
  });

  assert.equal(response.sandbox.type, "workspaceWrite");
  assert.deepEqual(response.sandbox.writableRoots, ["/workspace/projects/mono2"]);
});

test("thread/start maps Desktop permission profiles onto the native sandbox field", () => {
  const response = threadStartResponse({
    cwd: "/workspace/projects/mono2",
    permissions: ":danger-full-access",
  }, {
    id: "thread-3",
    cwd: "/workspace/projects/mono2",
    status: { type: "idle" },
    turns: [],
  });

  assert.deepEqual(response.sandbox, { type: "dangerFullAccess" });
});

test("thread/metadata/update returns metadata without replaying Turn history", () => {
  const response = threadMetadataUpdateResponse({
    id: "thread-4",
    cwd: "/workspace/projects/mono2",
    gitInfo: { branch: "main" },
    turns: [{ id: "active-inline-visualization" }],
  });

  assert.equal(response.thread.id, "thread-4");
  assert.deepEqual(response.thread.gitInfo, { branch: "main" });
  assert.deepEqual(response.thread.turns, []);
});
