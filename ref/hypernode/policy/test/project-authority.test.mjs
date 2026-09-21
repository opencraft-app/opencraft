import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectCatalogService,
  authoritativeProjectId,
  inferAuthoritativeProjectRoot,
} from "../src/services/project-catalog.js";
import {
  LEGACY_PROJECT_HYDRATION_GRACE_MS,
  ProjectProjectionService,
} from "../src/services/project-projection.js";
import { ThreadProjectBindingService } from "../src/services/thread-project-binding.ts";

function projectCatalog() {
  const catalog = Object.create(ProjectCatalogService.prototype);
  catalog.projects = new Map();
  catalog.idempotency = new Map();
  catalog.projectListeners = new Set();
  catalog.catalogRevision = 0;
  catalog.catalogCache = null;
  catalog.persistCount = 0;
  catalog.persist = () => {
    catalog.persistCount += 1;
    catalog.catalogRevision += 1;
    catalog.catalogCache = null;
  };
  return catalog;
}

function threadManager(active, archived = []) {
  const threads = new Map([...active, ...archived].map((thread) => [thread.id, thread]));
  return {
    persistCount: 0,
    get: (threadId) => threads.get(threadId),
    list: ({ archived: wantsArchived }) => wantsArchived ? archived : active,
    persist() { this.persistCount += 1; },
    setProject(threadId, projectId, options = {}) {
      const thread = threads.get(threadId);
      if ((thread.projectId ?? null) === (projectId ?? null)) return thread;
      thread.projectId = projectId ?? null;
      if (options.touch !== false) thread.updatedAt = 999;
      if (options.persist !== false) this.persist();
      return thread;
    },
  };
}

function binding(catalog, manager) {
  const service = Object.create(ThreadProjectBindingService.prototype);
  service.ctx = { projectCatalog: catalog, threadManager: manager };
  service.listeners = new Set();
  return service;
}

test("workspace project roots and ids are stable across main and fork views", () => {
  assert.equal(inferAuthoritativeProjectRoot("/workspace/projects/mono2"), "/workspace/projects/mono2");
  assert.equal(inferAuthoritativeProjectRoot("/workspace/projects/mono2/apps/web"), "/workspace/projects/mono2");
  assert.equal(
    inferAuthoritativeProjectRoot("/workspace/@fork-thread-1/projects/mono2/apps/web"),
    "/workspace/projects/mono2",
  );
  assert.equal(inferAuthoritativeProjectRoot("/workspace/projects"), null);
  assert.equal(inferAuthoritativeProjectRoot("/localhost/polaris"), null);
  assert.equal(
    authoritativeProjectId("/workspace/projects/mono2"),
    authoritativeProjectId("/workspace/projects/mono2/"),
  );
});

test("startup migration assigns one authoritative project without changing recency", () => {
  const active = [
    { id: "main", cwd: "/workspace/projects/mono2", projectId: null, updatedAt: 10 },
    { id: "system", cwd: "/workspace/projects", projectId: null, updatedAt: 20 },
  ];
  const archived = [
    { id: "fork", cwd: "/workspace/@fork-fork/projects/mono2/pkg", projectId: null, updatedAt: 30 },
  ];
  const catalog = projectCatalog();
  const manager = threadManager(active, archived);
  const service = binding(catalog, manager);

  service.migrate();

  assert.equal(catalog.projects.size, 1);
  const project = [...catalog.projects.values()][0];
  assert.equal(project.name, "mono2");
  assert.equal(project.roots[0].path, "/workspace/projects/mono2");
  assert.equal(active[0].projectId, project.id);
  assert.equal(archived[0].projectId, project.id);
  assert.equal(active[1].projectId, null);
  assert.equal(active[0].updatedAt, 10);
  assert.equal(archived[0].updatedAt, 30);
  assert.equal(catalog.persistCount, 1);
  assert.equal(manager.persistCount, 1);
});

test("new transparent starts infer authority even when Desktop sends projectId null", () => {
  const thread = { id: "thread", cwd: "/workspace/projects/mono2", projectId: null, updatedAt: 1 };
  const catalog = projectCatalog();
  const manager = threadManager([thread]);
  const service = binding(catalog, manager);
  const changes = [];
  service.listeners.add((change) => changes.push(change));

  service.capture(thread, { projectId: null, cwd: thread.cwd }, { id: "desktop" }, { inferWhenNull: true });

  assert.match(thread.projectId, /^project-hypernode-/);
  assert.deepEqual(changes.map(({ type, threadId, projectId }) => ({ type, threadId, projectId })), [{
    type: "binding",
    threadId: "thread",
    projectId: thread.projectId,
  }]);
});

function projectionHarness() {
  const notifications = [];
  const audits = [];
  const connection = { id: "desktop" };
  const service = Object.create(ProjectProjectionService.prototype);
  const threads = [
    { id: "older", projectId: "project-1", recencyAt: 1 },
    { id: "newer", projectId: "project-1", recencyAt: 2 },
    { id: "unassigned", projectId: null, recencyAt: 3 },
  ];
  service.ctx = {
    appServer: {
      notifyAfter: (_connection, method, params) => notifications.push({ method, params }),
      notifyAllAfter: (_connection, method, params) => notifications.push({ method, params }),
      broadcastNotification: (method, params) => notifications.push({ method, params }),
      audit: (_connection, type, payload) => audits.push({ type, payload }),
      connections: [connection],
    },
    projectCatalog: {
      list: () => ({ data: [{ id: "project-1", roots: [{ path: "/workspace/projects/mono2" }] }] }),
      exactRoot: (root) => root === "/workspace/projects/mono2" ? { id: "project-1" } : null,
    },
    threadManager: {
      list: () => threads,
      find: (threadId) => threads.find((thread) => thread.id === threadId) ?? null,
    },
  };

  service.initialize(connection);
  return { audits, connection, notifications, service, threads };
}

test("cold legacy clients receive project-bound threads without a dangling project id", () => {
  const { connection, service, threads } = projectionHarness();
  const wire = service.projectMessage({ id: "list", result: { data: threads } }, connection);

  assert.equal(wire.result.data[0].projectId, null);
  assert.equal(wire.result.data[1].projectId, null);
  assert.equal(wire.result.data[2].projectId, null);
  assert.equal(threads[0].projectId, "project-1", "canonical catalog ownership is unchanged");
});

test("cold clients never receive physical workspace view paths", () => {
  const { connection, service } = projectionHarness();
  const thread = {
    id: "legacy-path",
    cwd: "/workspace/@main/projects/mono2/apps/web",
    projectId: null,
  };

  const wire = service.projectMessage({ result: { thread } }, connection);

  assert.equal(wire.result.thread.cwd, "/workspace/projects/mono2/apps/web");
  assert.equal(thread.cwd, "/workspace/@main/projects/mono2/apps/web", "stored state is not mutated");
});

test("a project created by this connection is immediately safe to reference", () => {
  const { connection, notifications, service, threads } = projectionHarness();

  service.onProject({
    type: "project",
    connection,
    projectId: "project-1",
    changeType: "created",
  });

  assert.equal(connection.projectBootstrap.mode, "project-mutation");
  assert.equal(
    service.projectMessage({ result: { thread: threads[0] } }, connection).result.thread.projectId,
    "project-1",
  );
  assert.deepEqual(notifications.map((message) => message.method), [
    "project/changed",
    "thread/project/updated",
    "thread/project/updated",
  ]);
});

test("cold connection hydrates authoritative project catalog before bindings", () => {
  const { connection, notifications, service } = projectionHarness();

  assert.deepEqual(notifications, []);
  service.afterResponse(connection, { method: "thread/list", params: {} }, { data: [] }, 1000);
  assert.deepEqual(notifications, [
    { method: "project/changed", params: { projectId: "project-1", changeType: "created" } },
  ]);

  service.afterResponse(connection, { method: "project/list", params: {} }, {
    data: [{ id: "project-1" }],
    nextCursor: null,
  }, 1001);

  assert.deepEqual(notifications, [
    { method: "project/changed", params: { projectId: "project-1", changeType: "created" } },
    { method: "thread/project/updated", params: { threadId: "newer", projectId: "project-1" } },
    { method: "thread/project/updated", params: { threadId: "older", projectId: "project-1" } },
  ]);
  assert.equal(connection.projectBootstrap.mode, "authoritative-project-list");
});

test("paged project catalogs do not release bindings before their final page", () => {
  const { connection, notifications, service } = projectionHarness();

  service.afterResponse(connection, { method: "project/list", params: { limit: 1 } }, {
    data: [{ id: "project-1" }],
    nextCursor: "1",
  }, 1000);
  assert.deepEqual(notifications, []);
  assert.equal(connection.projectBootstrap.phase, "awaiting-catalog");

  service.afterResponse(connection, { method: "project/list", params: { limit: 1, cursor: "1" } }, {
    data: [],
    nextCursor: null,
  }, 1001);
  assert.deepEqual(notifications.map((message) => message.method), [
    "thread/project/updated",
    "thread/project/updated",
  ]);
  assert.equal(connection.projectBootstrap.mode, "authoritative-project-list");
});

test("legacy clients hydrate from the authoritative catalog without local project state", () => {
  const { audits, connection, notifications, service, threads } = projectionHarness();

  service.afterResponse(connection, { method: "thread/list", params: {} }, { data: [] }, 1000);
  assert.equal(service.poll(connection, 1000 + LEGACY_PROJECT_HYDRATION_GRACE_MS - 1), false);
  assert.deepEqual(notifications.map((message) => message.method), ["project/changed"]);

  assert.equal(service.poll(connection, 1000 + LEGACY_PROJECT_HYDRATION_GRACE_MS), true);
  assert.deepEqual(notifications.map((message) => message.method), [
    "project/changed",
    "thread/project/updated",
    "thread/project/updated",
  ]);
  assert.equal(connection.projectBootstrap.mode, "legacy-catalog-bootstrap");
  assert.equal(audits.at(-1).type, "project_bootstrap.compatible");
  assert.equal(
    service.projectMessage({ result: { data: threads } }, connection).result.data[0].projectId,
    "project-1",
  );

  assert.equal(service.observeRequest(connection, {
    method: "process/spawn",
    params: { cwd: "/workspace/@main/projects/mono2", command: ["git", "status"] },
  }), false);
  assert.deepEqual(notifications.map((message) => message.method), [
    "project/changed",
    "thread/project/updated",
    "thread/project/updated",
  ]);
  assert.equal(connection.projectBootstrap.mode, "legacy-catalog-bootstrap");
  assert.equal(
    service.projectMessage({ result: { data: threads } }, connection).result.data[0].projectId,
    "project-1",
  );
});

test("an observed project root cannot be downgraded by the later legacy timer", () => {
  const { audits, connection, service } = projectionHarness();

  assert.equal(service.observeRequest(connection, {
    method: "process/spawn",
    params: { cwd: "/workspace/projects/mono2" },
  }), true);
  service.afterResponse(connection, { method: "thread/list", params: {} }, { data: [] }, 1000);

  assert.equal(connection.projectBootstrap.mode, "observed-project-root");
  assert.equal(connection.projectBootstrap.phase, "ready");
  assert.equal(service.poll(connection, 1000 + LEGACY_PROJECT_HYDRATION_GRACE_MS), false);
  assert.equal(audits.some(({ type }) => type === "project_bootstrap.degraded"), false);
});
