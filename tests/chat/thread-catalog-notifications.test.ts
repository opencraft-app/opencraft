import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver, InfiniteQueryObserver } from "@tanstack/react-query";
import type { AppServerClient } from "@opencraft/appserver-client";
import { bindThreadCatalogNotifications } from "../../apps/workbench-web/src/runtime/thread-catalog-notifications";
import { threadCatalogUpdates } from "../../apps/workbench-web/src/runtime/thread-catalog-updates";
import { projectAppServerThread } from "@opencraft/workbench-runtime";
import { groupThreadsByTaskFlow } from "../../apps/workbench-web/src/sidebar-activity";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(incremental = false) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let receive!: Parameters<AppServerClient["subscribeNotification"]>[0];
  const stop = bindThreadCatalogNotifications({ initializeResult: incremental ? { capabilities: { extensions: { "opencraft/thread-directory-updates": { version: 1 } } } } as any : null,
    subscribeNotification(fn) { receive = fn; return () => {}; } }, "local", query);
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
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: [] } }); await tick();
    for (const data of [f.query.getQueryData<any>(key), f.query.getQueryData<any>(infinite).pages[0]]) {
      assert.equal(data.data[0].status.type, "active"); assert.equal(data.data[0].pinned, true);
    }
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "idle" } }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
    f.emit("turn/started", { threadId: "unknown" }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data.length, 1);
    assert.equal(f.query.getQueryData<any>(other).data[0].status.type, "idle");
    f.stop(); f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: [] } }); await tick();
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
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: [] } }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "active");
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "idle" } }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
    assert.equal(f.query.getQueryData(archivedKey), archived);
    assert.equal(f.query.getQueryData(otherKey), metadata);
    assert.equal(f.query.getQueryState(archivedKey)?.isInvalidated, true);
  } finally { f.stop(); f.query.clear(); }
});

test("turn activity cannot manufacture status or erase an execution-owner wait flag", async () => {
  const f = fixture(); f.query.setQueryData(key, page("idle"));
  try {
    f.emit("turn/started", { threadId: "pinned" }); await tick();
    assert.equal(f.query.getQueryData<any>(key).data[0].status.type, "idle");
    const status = { type: "active", activeFlags: ["waitingOnApproval"] };
    f.emit("thread/status/changed", { threadId: "pinned", status }); await tick();
    f.emit("turn/started", { threadId: "pinned" }); await tick();
    assert.deepEqual(f.query.getQueryData<any>(key).data[0].status, status);
  } finally { f.stop(); f.query.clear(); }
});


test("canonical and raw status facts update a 17-page reader without refetching its pages", async () => {
  const f = fixture();
  const managedKey = ["appserver", "local", "threads", "sidebar-pages"];
  const updates = threadCatalogUpdates(f.query, managedKey, "local"); updates.enabled = true;
  const pages = Array.from({ length: 17 }, (_, i) => ({ ...page("idle"),
    data: [{ ...page("idle").data[0], id: `row-${i}` }], nextCursor: i === 16 ? null : String(i + 1) }));
  f.query.setQueryData(managedKey, { pages, pageParams: pages.map((_, i) => i === 0 ? null : String(i)) });
  let reads = 0;
  const observer = new InfiniteQueryObserver(f.query, { queryKey: managedKey, initialPageParam: null as string | null,
    staleTime: Infinity, getNextPageParam: (last: typeof pages[number]) => last.nextCursor,
    queryFn: async ({ pageParam }) => { reads++; return pages[Number(pageParam ?? 0)]!; } });
  const unsubscribe = observer.subscribe(() => {});
  try {
    for (let i = 1; i <= 10; i++) {
      const status = { type: "active", activeFlags: ["waitingOnApproval"] };
      f.emit("opencraft/thread-catalog/changed", { version: 1, source: "current-execution", revision: i,
        change: { type: "patch", threadId: "row-16", status } });
      f.emit("thread/status/changed", { threadId: "row-16", status });
      await tick();
    }
    assert.equal(reads, 0, "status changes do not start any directory RPC");
    const raw = f.query.getQueryData<any>(managedKey).pages;
    assert.equal(raw[16].data[0].status.type, "idle", "raw snapshots cannot acknowledge a local overlay");
    assert.equal(updates.project({ data: raw.flatMap((p: any) => p.data), nextCursor: null } as any)?.data.find(row => row.id === "row-16")?.status.type, "active");
    f.emit("opencraft/thread-catalog/changed", { version: 1, source: "current-execution", revision: 11, change: { type: "invalidate" } });
    await tick(); await tick();
    assert.equal(reads, 17, "unknown directory changes still reconcile all cached pages");
  } finally { unsubscribe(); updates.enabled = false; f.stop(); f.query.clear(); }
});

test("raw status from an older Host is retained while the initial paged read is pending", async () => {
  const f = fixture(); const managedKey = ["appserver", "local", "threads", "sidebar-pages"];
  const updates = threadCatalogUpdates(f.query, managedKey, "local"); updates.enabled = true;
  let release!: (value: any) => void, reads = 0;
  const observer = new InfiniteQueryObserver(f.query, { queryKey: managedKey, initialPageParam: null as string | null,
    getNextPageParam: () => null, queryFn: () => { reads++; return new Promise<any>(resolve => { release = resolve; }); } });
  const unsubscribe = observer.subscribe(() => {});
  try {
    f.emit("thread/status/changed", { threadId: "pinned", status: { type: "active", activeFlags: [] } }); await tick();
    assert.equal(reads, 1, "the initial read is not cancelled or restarted");
    release(page("idle")); await tick(); await tick();
    assert.equal(updates.project(f.query.getQueryData<any>(managedKey).pages[0])?.data[0]?.status.type, "active");
  } finally { unsubscribe(); updates.enabled = false; f.stop(); f.query.clear(); }
});


test("negotiated directory increments keep 17 cached pages across turn bursts and update tail preview/recency", async () => {
  const f = fixture(true); let reads = 0;
  const updates = threadCatalogUpdates(f.query, key, "local"); updates.enabled = true;
  const observer = new InfiniteQueryObserver(f.query, { queryKey: key, initialPageParam: 0,
    queryFn: async ({ pageParam }) => { reads++; return { data: [{ id: `t${pageParam}`, cwd: "/fixture", createdAt: 1, updatedAt: 1, preview: "old", name: "name", ephemeral: false, turns: [], status: { type: "idle" } }], nextCursor: pageParam < 16 ? pageParam + 1 : null }; },
    getNextPageParam: page => page.nextCursor });
  const stop = observer.subscribe(() => {});
  try {
    await observer.refetch(); for (let n = 1; n < 17; n++) await observer.fetchNextPage();
    assert.equal(reads, 17);
    for (let n = 0; n < 10; n++) { f.emit("turn/started", { threadId: "t16" }); f.emit("turn/completed", { threadId: "t16" }); }
    await tick(); await tick(); assert.equal(reads, 17);
    f.emit("opencraft/thread-catalog/changed", { version: 1, source: "directory", revision: 1,
      change: { type: "upsert", thread: { id: "t16", cwd: "/fixture", createdAt: 1, updatedAt: 2, recencyAt: 20, name: "name", preview: "latest preview", status: { type: "idle" }, ephemeral: false, turns: [] } } });
    await tick();
    const snapshot: any = f.query.getQueryData(key);
    const value = updates.project({ data: snapshot.pages.flatMap((page: any) => page.data), nextCursor: null });
    assert.equal(value!.data[0]!.id, "t16"); assert.equal(value!.data[0]!.preview, "latest preview");
    assert.equal(reads, 17);
  } finally { stop(); f.stop(); f.query.clear(); }
});

test("notification method, producer and decision follow the exact refetch without payload or later overwrite",async()=>{
 const {createNotificationObservation,createRequestTrace}=await import("@opencraft/appserver-protocol");
 const {observeCatalogQueries,catalogPageTrace}=await import("../../apps/workbench-web/src/runtime/catalog-request-observation");
 const query=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}}),key=["appserver","fixture","threads"];
 observeCatalogQueries(query);const traces:any[]=[];let receive!:Parameters<AppServerClient["subscribeNotification"]>[0];
 const stop=bindThreadCatalogNotifications({subscribeNotification(fn){receive=fn;return()=>{};}},"fixture",query);
 const observer=new InfiniteQueryObserver(query,{queryKey:key,meta:{requestCaller:"thread-catalog"},initialPageParam:null as string|null,
  queryFn:async({pageParam})=>{traces.push(catalogPageTrace(query,key,pageParam));return page("idle");},getNextPageParam:()=>null});
 const remove=observer.subscribe(()=>{});
 try {
  await tick();const producer=createRequestTrace("client","direct-request");
  const upsert={version:1,source:"private-publisher",revision:9,change:{type:"upsert",thread:{...page("idle").data[0],createdAt:1}}};
  const stamp=createNotificationObservation("opencraft/thread-catalog/changed",upsert,"upstream-catalog",producer)!;
  receive({method:"opencraft/thread-catalog/changed",params:upsert,__opencraftNotification:stamp});await tick();await tick();
  assert.equal(traces[1].notificationId,stamp.notificationId);assert.equal(traces[1].notificationMethod,"opencraft/thread-catalog/changed");
  assert.equal(traces[1].notificationSource,"upstream-catalog");assert.equal(traces[1].notificationDecision,"refresh-other-projections");assert.equal(traces[1].notificationCauseTraceId,producer.traceId);
  receive({method:"thread/status/changed",params:{threadId:"pinned",status:{type:"idle"}}});await tick();await tick();
  assert.equal(traces[2].notificationMethod,"thread/status/changed");assert.equal(traces[2].notificationSource,"unknown");assert.equal(traces[2].notificationDecision,"cancel-and-refetch");
  assert.equal(traces[1].notificationId,stamp.notificationId);assert(!JSON.stringify(traces).includes("private-publisher"));
 } finally {remove();stop();observer.destroy();query.clear();}
});
