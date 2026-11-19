import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceSessions, workspaceLocationResource } from "../../apps/workbench-web/src/panels/workspace-sessions";
import { parseWorkspaceResource } from "../../apps/workbench-web/src/panels/workspace-resource-model";
import { startWorkspaceSearch } from "../../apps/workbench-web/src/panels/workspace-search";
import type { AppServerFileSystemResourcePort } from "@opencraft/workbench-runtime";
import { workspaceTreeWindow } from "../../apps/workbench-web/src/panels/workspace-file-tree-model";
function fixture() {
  const store = new WorkspaceSessions();
  const a = store.browser("owner", "host", "a", "/repo/a.ts");
  const b = store.browser("owner", "host", "b", "/repo/a.ts");
  store.observe("owner", "host", "/repo/a.ts", "base");
  return { store, a, b, doc: () => store.document("owner", "host", "/repo/a.ts")! };
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
test("two browser views share a document but keep independent navigation and query", () => {
  const { store, a, b, doc } = fixture();
  a.query = "first";
  a.treeOpen = true;
  store.edit("owner", "host", "/repo/a.ts", "draft");
  assert.equal(doc().draft?.text, "draft");
  assert.equal(b.query, "");
  assert.equal(b.treeOpen, false);
  assert.deepEqual(store.dirtyPaths("owner", "host", "b"), ["/repo/a.ts"]);
  store.releaseTab("owner", "a");
  assert.equal(doc().draft?.text, "draft");
  assert.equal(store.document("other", "host", "/repo/a.ts"), undefined);
  assert.equal(store.document("owner", "other-host", "/repo/a.ts"), undefined);
});
test("external refresh never replaces draft and preflight refuses changed disk content", async () => {
  const { store, doc } = fixture();
  store.edit("owner", "host", "/repo/a.ts", "draft");
  store.observe("owner", "host", "/repo/a.ts", "external");
  let writes = 0;
  await assert.rejects(
    store.save(
      "owner",
      "host",
      "/repo/a.ts",
      async () => "external",
      async () => {
        writes++;
      },
    ),
  );
  assert.equal(writes, 0);
  assert.equal(doc().draft?.text, "draft");
  assert.equal(doc().error, "conflict");
});
test("save acknowledges captured text, retaining later input and fencing concurrent saves", async () => {
  const { store, doc } = fixture();
  store.edit("owner", "host", "/repo/a.ts", "submitted");
  const write = held<void>();
  let writes = 0;
  const saving = store.save(
    "owner",
    "host",
    "/repo/a.ts",
    async () => "base",
    async () => {
      writes++;
      await write.promise;
    },
  );
  await Promise.resolve();
  store.edit("owner", "host", "/repo/a.ts", "newer");
  await store.save(
    "owner",
    "host",
    "/repo/a.ts",
    async () => "base",
    async () => {
      writes++;
    },
  );
  write.resolve();
  await saving;
  assert.equal(writes, 1);
  assert.deepEqual(doc().draft, { baseText: "submitted", text: "newer" });
  assert.equal(doc().saving, false);
});
test("undoing to baseline while saving remains a draft against the saved content", async () => {
  const { store, doc } = fixture();
  store.edit("owner", "host", "/repo/a.ts", "submitted");
  const write = held<void>();
  const saving = store.save(
    "owner",
    "host",
    "/repo/a.ts",
    async () => "base",
    () => write.promise,
  );
  await Promise.resolve();
  store.edit("owner", "host", "/repo/a.ts", "base");
  write.resolve();
  await saving;
  assert.deepEqual(doc().draft, { baseText: "submitted", text: "base" });
});
test("failed writes keep draft; owner release revokes a pending preflight before writing", async () => {
  const { store, doc } = fixture();
  store.edit("owner", "host", "/repo/a.ts", "draft");
  await assert.rejects(
    store.save(
      "owner",
      "host",
      "/repo/a.ts",
      async () => "base",
      async () => {
        throw Error("offline");
      },
    ),
  );
  assert.equal(doc().draft?.text, "draft");
  assert.equal(doc().saving, false);
  const read = held<string>();
  let writes = 0;
  const saving = store.save(
    "owner",
    "host",
    "/repo/a.ts",
    () => read.promise,
    async () => {
      writes++;
    },
  );
  store.releaseTab("owner", "a");
  store.releaseTab("owner", "b");
  read.resolve("base");
  await saving;
  assert.equal(writes, 0);
  assert.equal(store.document("owner", "host", "/repo/a.ts"), undefined);
});
test("literal file name characters and Windows paths survive navigation receipts", () => {
  for (const path of ["/repo/a#b %.ts", "C:/repo/你好.ts"]) {
    const location = { path, line: 42, column: 3 };
    assert.deepEqual(parseWorkspaceResource(workspaceLocationResource(location)), location);
  }
});
test("touch geometry uses the same height for viewport projection and offsets", () => {
  const range = workspaceTreeWindow(1000, 440, 440, 44);
  assert.equal(range.height, 44000);
  assert.equal(range.start, 2);
  assert.equal(range.end, 28);
});
test("search disposes late-created sessions, rejects old intent callbacks and mismatched queries", async () => {
  type Options = Parameters<AppServerFileSystemResourcePort["createFuzzyFileSearchSession"]>[0];
  const callbacks: Options[] = [];
  const first = held<any>();
  let stops = 0,
    updates = 0;
  const fs = {
    createFuzzyFileSearchSession: async (options: Options) => {
      callbacks.push(options);
      return callbacks.length === 1
        ? first.promise
        : {
            update: async () => {
              updates++;
            },
            stop: async () => {
              stops++;
            },
          };
    },
  } as AppServerFileSystemResourcePort;
  const states: any[] = [];
  const stopFirst = startWorkspaceSearch(fs, ["/repo"], "a", (state) => states.push(state));
  stopFirst();
  const stopSecond = startWorkspaceSearch(fs, ["/repo"], "b", (state) => states.push(state));
  await Promise.resolve();
  callbacks[0]!.onUpdated?.({ query: "a", files: [] });
  callbacks[1]!.onUpdated?.({ query: "wrong", files: [] });
  assert.equal(states.length, 0);
  callbacks[1]!.onUpdated?.({ query: "b", files: [] });
  assert.equal(states.length, 1);
  first.resolve({
    update: async () => {
      updates++;
    },
    stop: async () => {
      stops++;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stopSecond();
  assert.equal(updates, 1);
  assert.equal(stops, 2);
});

test("watch invalidation excludes other Hosts, generations and unrelated directories", async () => {
  const { workspaceQueryAffected } = await import("../../apps/workbench-web/src/panels/workspace-resource-access");
  const affected = (kind: string, path: string, scope = "generation-2", host = "host") =>
    workspaceQueryAffected(["appserver-fs", host, kind, path, scope], "host", "generation-2", ["/repo/a.ts"]);
  assert.equal(affected("resource", "/repo/a.ts"), true);
  assert.equal(affected("directory", "/repo"), true);
  assert.equal(affected("directory", "/other"), false);
  assert.equal(affected("resource", "/repo/b.ts"), false);
  assert.equal(affected("resource", "/repo/a.ts", "generation-1"), false);
  assert.equal(affected("resource", "/repo/a.ts", "generation-2", "other"), false);
});
test("panels share one watch and late acquisition is released after final consumer exits", async () => {
  const { WorkspaceWatchPool } = await import("../../apps/workbench-web/src/panels/workspace-resource-access");
  const pool = new WorkspaceWatchPool(),
    lease = held<any>();
  let acquired = 0,
    disposed = 0;
  const fs = {
    watch: async () => {
      acquired++;
      return lease.promise;
    },
  } as unknown as AppServerFileSystemResourcePort;
  const first = pool.acquire(fs, "scope", "/repo", () => {}),
    second = pool.acquire(fs, "scope", "/repo", () => {});
  first();
  assert.equal(acquired, 1);
  assert.equal(disposed, 0);
  second();
  second();
  lease.resolve({
    dispose: async () => {
      disposed++;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(disposed, 1);
});

test("breadcrumbs preserve absolute Unix and drive-root identities", async () => {
  const { workspaceBreadcrumbs } = await import("../../apps/workbench-web/src/panels/workspace-resource-model");
  assert.deepEqual(
    workspaceBreadcrumbs("/repo/src/a.ts").map((part) => part.path),
    ["/", "/repo", "/repo/src", "/repo/src/a.ts"],
  );
  assert.deepEqual(
    workspaceBreadcrumbs("C:/repo/a.ts").map((part) => part.path),
    ["C:/", "C:/repo", "C:/repo/a.ts"],
  );
});
