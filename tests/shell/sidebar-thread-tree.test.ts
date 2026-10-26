import assert from "node:assert/strict";
import test from "node:test";
import { sidebarThreadIdentity, sidebarThreadTree, type SidebarTreeThread, type SidebarThreadTreeNode } from "../../apps/workbench-web/src/sidebar-thread-tree";
import { groupThreadsByTaskFlow } from "../../apps/workbench-web/src/sidebar-activity";
import { cacheThreadCatalog, restoreThreadCatalog, threadCatalogResource } from "../../apps/workbench-web/src/runtime/thread-catalog-cache";
import { projectAppServerThread, threadServerOrigin } from "@opencraft/workbench-runtime";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
import { ClientResources, type ClientResourceRecord, type ClientResourcePersistence } from "@opencraft/document-storage/client-resources";

function thread(id: string, parentThreadId: string | null = null, overrides: Partial<SidebarTreeThread> = {}) {
  return {
    id, connectionHostId: "host-a", parentThreadId, visibility: "visible" as const,
    updatedAt: 100, status: "ready", project: "project",
    serverOrigin: threadServerOrigin({ serverId: "server-a", label: "Server" }), ...overrides,
  };
}
function paths<T extends SidebarTreeThread>(nodes: readonly SidebarThreadTreeNode<T>[], parent: string[] = []): string[][] {
  return nodes.flatMap(node => {
    const path = [...parent, node.thread.id];
    return [path, ...paths(node.children, path)];
  });
}

test("children stay under their Host's parent regardless of status and root pagination", () => {
  const rows = [thread("child", "root", { updatedAt: 200 }), thread("other"), thread("root")];
  Object.assign(rows[0]!, { status: "running", pinned: true });
  const tree = sidebarThreadTree(rows);
  const flow = groupThreadsByTaskFlow(tree.roots.map(node => node.thread));
  assert.equal(flow.pinned.length, 0, "a pinned child does not split its root's tree");
  assert.equal(flow.recent.length, 2, "pagination counts root conversations");
  const root = flow.recent.find(row => row.id === "root")!;
  assert.deepEqual(paths([tree.nodes.get(sidebarThreadIdentity(root))!]), [["root"], ["root", "child"]]);
  assert.equal(tree.rootByIdentity.get(sidebarThreadIdentity(rows[0]!)), sidebarThreadIdentity(root));
  assert.deepEqual(rows.map(row => row.id), ["child", "other", "root"], "projection never mutates the catalog");
});

test("hidden rows never appear; filtered or absent parents promote children without changing catalog membership", () => {
  const rows = [thread("hidden-root", null, { visibility: "hidden" }), thread("child", "hidden-root"),
    thread("root"), thread("hidden-child", "root", { visibility: "hidden" }), thread("orphan", "not-loaded")];
  const tree = sidebarThreadTree(rows);
  assert.deepEqual(new Set(paths(tree.roots).flat()), new Set(["child", "root", "orphan"]));
  assert.equal(tree.nodes.has(sidebarThreadIdentity(rows[3]!)), false);
  assert.equal(rows.find(row => row.id === "hidden-child")?.parentThreadId, "root", "parent navigation retains its hidden target");
  assert.deepEqual(paths(sidebarThreadTree([thread("child", "filtered-parent")]).roots), [["child"]]);
});

test("duplicate thread IDs cannot form cross-Host parents and cycles break consistently after reconnect", () => {
  const rows = [thread("root"), thread("child", "root", { connectionHostId: "host-b" }),
    thread("a", "b"), thread("b", "a"), thread("self", "self")];
  const before = paths(sidebarThreadTree(rows).roots);
  const after = paths(sidebarThreadTree([...rows].reverse()).roots);
  assert.deepEqual(after, before);
  assert.ok(before.some(path => path.length === 1 && path[0] === "child"));
  assert.equal(before.length, rows.length, "each row appears exactly once even with malformed topology");
});

test("persisted backend topology survives refresh including hidden navigation targets", () => {
  const protocol = (id: string, parentThreadId: string | null, visibility: "visible" | "hidden") => projectAppServerThread({
    id, parentThreadId, visibility, forkedFromId: null, name: id, cwd: "/project", updatedAt: 100,
    createdAt: 1, preview: "", status: { type: "idle" },
  } as Thread & { visibility: "visible" | "hidden" });
  const fresh = [protocol("root", null, "visible"), protocol("child", "root", "visible"), protocol("secret", "root", "hidden")];
  const cached = threadCatalogResource.parse(JSON.parse(JSON.stringify(cacheThreadCatalog(fresh, true))));
  const restored = restoreThreadCatalog(cached);
  assert.deepEqual(restored.map(row => [row.id, row.parentThreadId, row.visibility]), fresh.map(row => [row.id, row.parentThreadId, row.visibility]));
  const tree = (rows: typeof restored) => sidebarThreadTree(rows.map(row => ({ ...row, connectionHostId: "host-a" })));
  assert.deepEqual(paths(tree(restored).roots), paths(tree(fresh).roots));
  assert.deepEqual(paths(tree(restored).roots), [["root"], ["root", "child"]]);
  assert.equal(restored.some(row => row.id === "secret"), true, "hidden targets remain cached for direct navigation");
  assert.throws(() => threadCatalogResource.parse({ rows: [{ ...cached.rows[0]!, visibility: "invalid" }], complete: true }), /identity/);
});

test("a pre-topology cache cannot paint unknown hidden rows and a fresh schema reload replaces it", async () => {
  let stored: ClientResourceRecord | null = { revision: 1, version: 1, savedAt: 1, value: {
    complete: true, rows: [{ id: "old-hidden-target", title: "Old", project: "project", lineage: "subagent", updatedAt: 1, createdAt: 1, pinned: false }],
  } };
  const storage: ClientResourcePersistence = {
    read: async () => stored,
    compareAndSet: async (_key, revision, record) => {
      if ((stored?.revision ?? 0) !== revision) return false;
      stored = { ...record, revision: revision + 1 }; return true;
    },
    clearRemoteNamespace: async () => { stored = null; }, close() {},
  };
  const resources = new ClientResources(Promise.resolve(storage), "synthetic-account");
  try {
    const catalog = resources.remote(threadCatalogResource, "host-a");
    await catalog.ready;
    assert.equal(catalog.getSnapshot().value, null);
    stored = { revision: 2, version: threadCatalogResource.version, savedAt: 2, value: cacheThreadCatalog([], true) };
    await catalog.reload();
    assert.deepEqual(catalog.getSnapshot().value?.rows, []);
    assert.equal(catalog.getSnapshot().error, null);
  } finally { await resources.close(); }
});
