import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AppServerClient } from "@opencraft/appserver-client";
import { bindThreadCatalogNotifications } from "../../apps/workbench-web/src/runtime/thread-catalog-notifications";
import { projectAppServerThread } from "@opencraft/workbench-runtime";
import { groupThreadsByTaskFlow } from "../../apps/workbench-web/src/sidebar-activity";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let receive!: Parameters<AppServerClient["subscribeNotification"]>[0];
  const stop = bindThreadCatalogNotifications({ subscribeNotification(fn) { receive = fn; return () => {}; } }, "local", query);
  return { query, stop, emit: (method: string, params: unknown) => receive({ method, params }) };
}
const key = ["appserver", "local", "threads", "sidebar"];
const page = (type: string) => ({ data: [{ id: "pinned", name: "Pinned", preview: "", cwd: "/work/opencraft", updatedAt: 1,
  parentThreadId: null, forkedFromId: null, pinned: true, status: { type, ...(type === "active" ? { activeFlags: [] } : {}) } }], nextCursor: null });

test("status event cancels an idle first read and refetches instead of reusing it", async () => {
  const f = fixture();
  let reads = 0;
  let old!: (value: unknown) => void;
  const observer = new QueryObserver(f.query, { queryKey: key, queryFn: () => ++reads === 1
    ? new Promise(resolve => { old = resolve; }) : Promise.resolve(page("active")) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: [] } });
    await tick(); await tick();
    assert.equal(reads, 2);
    old(page("idle")); await tick();
    const result = f.query.getQueryData<any>(key);
    assert.equal(result.data[0].status.type, "active");
    const rows = result.data.map((row: any) => ({ ...projectAppServerThread(row), serverOrigin: { serverId: "local", label: "Local" } }));
    const flow = groupThreadsByTaskFlow(rows);
    assert.equal(flow.pinned.length, 1); assert.equal(flow.pinned[0]?.status, "running");
  } finally { unsubscribe(); f.stop(); f.query.clear(); }
});

test("live status updates page and infinite caches, preserves scope/pins, and does not invent rows", async () => {
  const f = fixture();
  const infinite = [...key, "paged"];
  const other = ["appserver", "other", "threads"];
  f.query.setQueryData(key, page("idle"));
  f.query.setQueryData(infinite, { pages: [page("idle")], pageParams: [null] });
  f.query.setQueryData(other, page("idle"));
  try {
    f.emit("turn/started", { threadId: "pinned" }); await tick();
    for (const data of [f.query.getQueryData<any>(key), f.query.getQueryData<any>(infinite).pages[0]]) {
      assert.equal(data.data[0].status.type, "active"); assert.equal(data.data[0].pinned, true);
    }
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "idle" } }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
    f.emit("turn/started", { threadId: "unknown" }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data.length, 1);
    assert.equal(f.query.getQueryData<any>(other).data[0].status.type, "idle");
    f.stop(); f.emit("turn/started", { threadId: "pinned" }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
  } finally { f.stop(); f.query.clear(); }
});

test("archived arrays and other projections cannot poison later catalog notifications", async () => {
  const f = fixture();
  const archivedKey = ["appserver", "local", "threads", "archived", "management"];
  const archived = [{ id: "archived", name: "Keep archive projection" }];
  const otherKey = [...key, "metadata"], metadata = { total: 7 };
  f.query.setQueryData(key, page("idle"));
  f.query.setQueryData(archivedKey, archived); f.query.setQueryData(otherKey, metadata);
  try {
    f.emit("turn/started", { threadId: "pinned" }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "active");
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "idle" } }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
    assert.equal(f.query.getQueryData(archivedKey), archived);
    assert.equal(f.query.getQueryData(otherKey), metadata);
    assert.equal(f.query.getQueryState(archivedKey)?.isInvalidated, true);
  } finally { f.stop(); f.query.clear(); }
});
