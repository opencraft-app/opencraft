import assert from "node:assert/strict";
import test from "node:test";
import { codexProjectGroups } from "../../apps/local-agent-host/src/codex-project-groups.js";
import { parseNativeConversationProject, threadCatalogEntry, createCatalogMerkle } from "@opencraft/appserver-protocol";
import { projectAppServerThread } from "../../packages/workbench-runtime/src/thread-catalog.js";
import { groupThreadsByNativeProject } from "../../apps/workbench-web/src/sidebar-activity.js";
import { cacheThreadCatalog, threadCatalogResource, restoreThreadCatalog } from "../../apps/workbench-web/src/runtime/thread-catalog-cache.js";

test("Codex project identity/order and explicit assignments win over working directories", () => {
  const state = { "local-projects": {
    a: { id: "a", name: "Same name", rootPaths: ["/a"] }, b: { id: "b", name: "Same name", rootPaths: ["/b"] },
    nested: { id: "nested", name: "Nested", rootPaths: ["/a/nested"] },
  }, "project-order": ["b", "a", "nested"], "thread-project-assignments": {
    moved: { projectKind: "local", projectId: "b" }, remote: { projectKind: "remote", projectId: "missing" },
  }, "projectless-thread-ids": ["none"] };
  const before = JSON.stringify(state);
  const result = codexProjectGroups(state, [
    { id: "moved", cwd: "/a" }, { id: "cwd", cwd: "/a/nested/sub" }, { id: "none", cwd: "/a" },
    { id: "remote", cwd: "/a" }, { id: "prefix", cwd: "/another" },
  ]);
  assert.deepEqual(result.moved, { source: "codex", id: "b", name: "Same name", position: 0 });
  assert.equal(result.cwd?.id, "nested"); assert.equal(result.none, null); assert.equal(result.remote, null); assert.equal(result.prefix, null);
  assert.equal(JSON.stringify(state), before);
});

test("native project metadata survives catalog notifications, Merkle changes and offline display", () => {
  const nativeProject = { source: "codex" as const, id: "original-a", name: "Original project", position: 2 };
  const row = threadCatalogEntry({ id: "thread", cwd: "/a", createdAt: 1, updatedAt: 2, nativeProject, name: "A conversation" })!;
  assert.deepEqual((row as any).nativeProject, nativeProject);
  const projected = projectAppServerThread(row); assert.deepEqual(projected.nativeProject, nativeProject); assert.equal(projected.project, nativeProject.name);
  const saved = threadCatalogResource.parse(cacheThreadCatalog([projected], true));
  assert.deepEqual(restoreThreadCatalog(saved)[0]?.nativeProject, nativeProject);
  assert.equal(parseNativeConversationProject({ ...nativeProject, position: -1 }), null);
  const merkle = createCatalogMerkle();
  assert.notDeepEqual(merkle.metadata(row), merkle.metadata({ ...row, nativeProject: { ...nativeProject, name: "Renamed" } } as any));
});

test("sidebar keeps same-named projects and distinct Hosts separate, preserving native project order", () => {
  const row = (host: string, id: string, projectId: string, position: number) => ({ id, connectionHostId: host,
    serverOrigin: { serverId: host, label: host }, project: "Same name", updatedAt: 1,
    nativeProject: { source: "codex" as const, id: projectId, name: "Same name", position } });
  const groups = groupThreadsByNativeProject([row("host-a", "one", "a", 2), row("host-a", "two", "b", 1), row("host-b", "three", "a", 2)]);
  assert.equal(groups.length, 3); assert.equal(groups[0]?.threads[0]?.id, "two");
});
