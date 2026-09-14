import assert from "node:assert/strict";
import test from "node:test";

import { AppServerProjectionService } from "../src/services/appserver-projection.ts";
import {
  TransparentBackendProjectionService,
} from "../src/services/transparent-backend-projection.ts";

function createHarness() {
  const calls = [];
  const threads = new Map();
  const threadManager = {
    project(threadId, source, mapPath = (value) => value) {
      const projected = {
        ...(threads.get(threadId) ?? { id: threadId, turns: [] }),
        ...source,
      };
      if (typeof projected.cwd === "string") projected.cwd = mapPath(projected.cwd);
      if (typeof projected.path === "string") projected.path = mapPath(projected.path);
      threads.set(threadId, projected);
      calls.push(["project", threadId, source]);
      return projected;
    },
    projectTurn(threadId, turn, phase = null) {
      const thread = threads.get(threadId) ?? { id: threadId, turns: [] };
      thread.turns = [...(thread.turns ?? []).filter((entry) => entry.id !== turn.id), turn];
      threads.set(threadId, thread);
      calls.push(["turn", threadId, turn.id, phase]);
      return thread;
    },
    archive(threadId) {
      calls.push(["archive", threadId]);
      return threads.get(threadId) ?? { id: threadId };
    },
    unarchive(threadId) {
      calls.push(["unarchive", threadId]);
      return threads.get(threadId) ?? { id: threadId };
    },
  };
  const service = Object.assign(Object.create(AppServerProjectionService.prototype), {
    ctx: { threadManager },
  });
  const effects = [];
  const host = {
    virtualPath(path) {
      return path.replace("/physical", "/workspace");
    },
    turnStarted(threadId, turn) {
      effects.push(["started", threadId, turn.id]);
    },
    turnCompleted(threadId, turn) {
      effects.push(["completed", threadId, turn?.id ?? null]);
    },
    threadArchived(threadId) {
      effects.push(["archived", threadId]);
    },
  };
  return { service, host, calls, effects, threads };
}

test("native turn notifications project paths and preserve lifecycle order", () => {
  const { service, host, calls, effects, threads } = createHarness();
  service.projectBackend({
    method: "turn/started",
    params: {
      thread: { id: "outer-1", cwd: "/physical/projects/demo" },
      turn: { id: "turn-1", status: "inProgress", items: [] },
    },
  }, host);
  service.projectBackend({
    method: "turn/completed",
    params: {
      threadId: "outer-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    },
  }, host);

  assert.equal(threads.get("outer-1").cwd, "/workspace/projects/demo");
  assert.deepEqual(calls.map((entry) => entry[0]), ["project", "turn", "turn"]);
  assert.deepEqual(effects, [
    ["started", "outer-1", "turn-1"],
    ["completed", "outer-1", "turn-1"],
  ]);
});

test("thread response projects metadata without importing backend history", () => {
  const { service, host, calls, effects } = createHarness();
  service.projectBackend({
    id: "resume-1",
    result: {
      thread: {
        id: "outer-1",
        path: "/physical/.codex/session.jsonl",
        turns: [{ id: "turn-embedded", status: "completed", items: [] }],
      },
      initialTurnsPage: {
        data: [{ id: "turn-old", status: "completed", items: [] }],
      },
    },
  }, host);

  assert.deepEqual(calls.map((entry) => entry[0]), ["project"]);
  assert.equal(Object.hasOwn(calls[0][2], "turns"), false);
  assert.deepEqual(effects, []);
});

test("archive and unarchive update the read model while lifecycle effects stay explicit", () => {
  const { service, host, calls, effects } = createHarness();
  service.projectBackend({ method: "thread/archived", params: { threadId: "outer-1" } }, host);
  service.projectBackend({ method: "thread/unarchived", params: { threadId: "outer-1" } }, host);

  assert.deepEqual(calls, [["archive", "outer-1"], ["unarchive", "outer-1"]]);
  assert.deepEqual(effects, [["archived", "outer-1"]]);
});

function state() {
  return {
    backendKey: "runtime-1",
    turnEpochs: new Map(),
  };
}

function projection(options = {}) {
  const calls = {
    projected: [],
    turns: [],
    started: [],
    completed: [],
    archived: [],
    workspaceArchived: [],
    released: [],
    executionReleased: [],
    retired: [],
  };
  const ownerConnection = options.ownerConnection ?? {
    threadWriteLease: {
      release: (...args) => calls.released.push(args),
    },
  };
  const thread = { id: "outer", cwd: "/workspace/project" };
  const threadManager = {
    project: (threadId, metadata, mapPath) => {
      calls.projected.push({
        threadId,
        metadata: structuredClone(metadata),
        cwd: mapPath(metadata.cwd),
      });
    },
    projectTurn: (...args) => calls.turns.push(args),
    archive: (threadId) => calls.archived.push(threadId),
    unarchive: () => {},
    get: () => thread,
  };
  const appServerProjection = Object.assign(
    Object.create(AppServerProjectionService.prototype),
    { ctx: { threadManager } },
  );
  const service = Object.assign(
    Object.create(TransparentBackendProjectionService.prototype),
    {
      ctx: {
        appServerProjection,
        runtimeWorkspace: {
          archive: (value) => calls.workspaceArchived.push(value),
        },
        threadExecution: {
          markNativeStarted: (...args) => calls.started.push(args),
          complete: (...args) => calls.completed.push(args),
          releaseThread: (...args) => calls.executionReleased.push(args),
        },
        threadManager,
        transparentRuntimeLocator: {
          stateForOuter: options.stateForOuter ?? (() => null),
          ownerConnection: options.resolveOwner ?? (() => ownerConnection),
          ownerEpoch: options.ownerEpoch ?? (() => 7),
        },
        transparentRuntimeAccess: {
          localFilesystem: null,
          toVirtual: (path) => `/virtual${path}`,
        },
        transparentRuntimeRetirement: {
          retireThreadRuntimeIfIdle: (threadId) => calls.retired.push(threadId),
        },
      },
    },
  );
  const localFilesystem = { owns: () => true };
  service.ctx.transparentRuntimeAccess.localFilesystem = localFilesystem;
  return { service, calls, localFilesystem, ownerConnection, thread };
}

test("thread metadata resolves the live runtime and virtualizes paths", () => {
  const runtime = state();
  const resolved = [];
  const { service, calls, localFilesystem } = projection({
    stateForOuter: (threadId, filesystem) => {
      resolved.push({ threadId, filesystem });
      return runtime;
    },
  });

  service.projectThread("outer", {
    id: "outer",
    cwd: "/physical/project",
    turns: [{ id: "legacy-history" }],
  }, null);

  assert.deepEqual(resolved, [{ threadId: "outer", filesystem: localFilesystem }]);
  assert.deepEqual(calls.projected, [{
    threadId: "outer",
    metadata: { id: "outer", cwd: "/physical/project" },
    cwd: "/virtual/physical/project",
  }]);
});

test("native turn lifecycle preserves the matching runtime epoch", () => {
  const runtime = state();
  const { service, calls, ownerConnection } = projection();

  service.projectBackend({
    method: "turn/started",
    params: {
      threadId: "outer",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    },
  }, runtime);
  service.projectBackend({
    method: "turn/completed",
    params: {
      threadId: "outer",
      turn: { id: "turn-1", status: "completed", items: [] },
    },
  }, runtime);

  assert.equal(runtime.turnEpochs.get("turn-1"), 7);
  assert.deepEqual(calls.started, [["outer", ownerConnection, "turn-1", 7]]);
  assert.deepEqual(calls.completed, [["outer", {
    connection: ownerConnection,
    turnId: "turn-1",
    epoch: 7,
    reason: "completed",
  }]]);
  assert.deepEqual(calls.retired, ["outer"]);
});

test("thread archival coordinates workspace, lease and execution release", () => {
  const runtime = state();
  const { service, calls, ownerConnection, thread } = projection();

  service.projectBackend({
    method: "thread/archived",
    params: { threadId: "outer" },
  }, runtime);

  assert.deepEqual(calls.archived, ["outer"]);
  assert.deepEqual(calls.workspaceArchived, [thread]);
  assert.deepEqual(calls.released, [["outer", ownerConnection]]);
  assert.deepEqual(calls.executionReleased, [["outer", "threadArchived"]]);
});
