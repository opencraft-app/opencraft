import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, InfiniteQueryObserver } from "@tanstack/react-query";
import { setImmediate as tick } from "node:timers/promises";
import { ThreadCatalogUpdates, threadCatalogUpdates } from "../../apps/workbench-web/src/runtime/thread-catalog-updates";
import { bindThreadCatalogNotifications } from "../../apps/workbench-web/src/runtime/thread-catalog-notifications";
import { ThreadCatalogPublisher } from "@opencraft/app-host-server/thread-catalog";
import { parseThreadCatalogChange, type ThreadCatalogChange } from "@opencraft/appserver-protocol";
import type { Thread, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
const row = (id: string, updatedAt = 2) => ({ id, cwd: "/synthetic", createdAt: 1, updatedAt, status: { type: "idle" }, name: null, preview: "", ephemeral: false, turns: [] }) as unknown as Thread;
const page = (...rows: Thread[]) => ({ data: rows, nextCursor: null }) as ThreadListResponse;
const change = (revision: number, mutation: ThreadCatalogChange["change"]): ThreadCatalogChange => ({ version: 1, source: "server-incarnation", revision, change: mutation });

test("committed facts paint before a slow existing multi-page refresh completes", async () => {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const key = ["appserver", "host", "threads", "sidebar-pages", "updated_at", "desc", false, 1, 1, 0];
  const updates = threadCatalogUpdates(q, key, "host"); updates.enabled = true;
  q.setQueryData(key, { pages: [{ ...page(row("old-1")), nextCursor: "two" }, page(row("old-2"))], pageParams: [null, "two"] });
  let release!: () => void, receive!: (notification: any) => void;
  const observer = new InfiniteQueryObserver(q, { queryKey: key, initialPageParam: null as string | null, staleTime: Infinity,
    getNextPageParam: (last: ThreadListResponse) => last.nextCursor,
    queryFn: async ({ pageParam }) => { if (pageParam) await new Promise<void>(resolve => { release = resolve; });
      return pageParam ? page(row("old-2")) : { ...page(row("old-1")), nextCursor: "two" }; } });
  const stop = observer.subscribe(() => {});
  const unbind = bindThreadCatalogNotifications({ subscribeNotification(fn) { receive = fn; return () => {}; } }, "host", q);
  try {
    const read = observer.refetch(); await tick();
    receive({ method: "opencraft/thread-catalog/changed", params: change(1, { type: "upsert", thread: row("new", 3) }) });
    const current = () => updates.project(page(...q.getQueryData<any>(key).pages.flatMap((p: ThreadListResponse) => p.data)))!;
    assert.equal(current().data[0]?.id, "new", "new row is visible while the second page is blocked");
    release(); await read;
    assert.equal(current().data[0]?.id, "new", "an old in-flight snapshot cannot erase the new row");
    updates.acknowledge(updates.markRead(page(row("new", 3)), updates.getSnapshot()));
    assert.deepEqual(updates.project(page(row("new", 3)))?.data.map(r => r.id), ["new"]);
  } finally { unbind(); stop(); q.clear(); }
});

test("cold snapshots, duplicate delivery, patches, removals and snapshot watermarks", () => {
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true;
  const cold = updates.getSnapshot();
  updates.receive(change(1, { type: "upsert", thread: row("new") }));
  const revision = updates.getSnapshot();
  updates.receive(change(1, { type: "upsert", thread: row("duplicate") }));
  assert.equal(updates.getSnapshot(), revision);
  assert.equal(updates.project(undefined)?.data[0]?.id, "new");
  updates.acknowledge(updates.markRead(page(), cold));
  assert.equal(updates.project(page())?.data[0]?.id, "new", "older read does not acknowledge a later creation");
  updates.receive(change(2, { type: "patch", threadId: "new", name: "Named" }));
  assert.equal(updates.project(page())?.data[0]?.name, "Named");
  updates.receive(change(3, { type: "remove", threadId: "new" }));
  assert.deepEqual(updates.project(page(row("new")))?.data, []);
  updates.receive(change(4, { type: "patch", threadId: "new", status: { type: "idle" } }));
  assert.deepEqual(updates.project(page(row("new")))?.data, [], "status cannot resurrect a deleted row");
  const start = updates.getSnapshot();
  updates.acknowledge(updates.markRead(page(), start));
  assert.equal(updates.project(page(row("server-newer")))?.data[0]?.id, "server-newer");
});

test("unknown status never invents a row and retired authorization scopes reject facts", () => {
  const q = new QueryClient();
  const old = threadCatalogUpdates(q, ["host", "old-account"], "host"); old.enabled = false;
  old.receive(change(1, { type: "upsert", thread: row("private") }));
  assert.equal(old.project(undefined), undefined);
  const current = threadCatalogUpdates(q, ["host", "new-account"], "host"); current.enabled = true;
  current.receive(change(1, { type: "patch", threadId: "unknown", status: { type: "active", activeFlags: [] } }));
  assert.equal(current.project(undefined), undefined);
  q.clear();
});

test("Server commits first-Turn creations, excludes temporary helpers and strips history", () => {
  const events: ThreadCatalogChange[] = [];
  const publisher = new ThreadCatalogPublisher((_method, params) => events.push(params), true);
  publisher.observeResult("thread/start", {}, { thread: { ...row("new"), turns: [{ privateBody: "never directory data" }] } });
  assert.equal(events.length, 0);
  publisher.observeResult("turn/start", { threadId: "new" }, { turn: { id: "accepted" } });
  assert.equal(events.length, 1); assert.equal(JSON.stringify(events).includes("privateBody"), false);
  assert.deepEqual(parseThreadCatalogChange(events[0])?.change, events[0]?.change);
  publisher.observeResult("thread/start", { ephemeral: true }, { thread: row("helper") });
  publisher.observeResult("turn/start", { threadId: "helper" }, { turn: { id: "helper-turn" } });
  assert.equal(events.length, 1);
});

test("leaving a View does not erase a pending durable creation; observer failure cannot fail the native receipt", () => {
  const events: ThreadCatalogChange[] = [];
  const publisher = new ThreadCatalogPublisher((_method, event) => events.push(event), true);
  publisher.observeResult("thread/start", {}, { thread: row("accepted-after-detach") });
  publisher.observeResult("thread/unsubscribe", { threadId: "accepted-after-detach" }, { status: "unsubscribed" });
  publisher.observeResult("turn/start", { threadId: "accepted-after-detach" }, { turn: { id: "committed" } });
  assert.equal(events[0]?.change.type, "upsert");
  const broken = new ThreadCatalogPublisher(() => { throw new Error("Closed observer"); });
  assert.doesNotThrow(() => broken.observeResult("thread/start", {}, { thread: row("committed") }));
});

test("Server directory retains committed rows until the native index observes them", () => {
  const publisher = new ThreadCatalogPublisher(() => {}, true);
  publisher.observeResult("thread/start", {}, { thread: row("new") });
  publisher.observeResult("turn/start", { threadId: "new" }, { turn: { id: "committed" } });
  const native = { ...page(...Array.from({ length: 200 }, (_, i) => row("indexed-" + i, 1))), nextCursor: "next" };
  const original = [...native.data];
  for (let attempt = 0; attempt < 2; attempt++) {
    publisher.observeResult("thread/list", { cursor: null, limit: 200 }, native);
    const view = publisher.projectList({ cursor: null, limit: 200 }, native) as ThreadListResponse;
    assert.deepEqual(native.data, original);
    assert.equal(native.nextCursor, "next");
    assert.deepEqual(view.data.map(thread => thread.id), ["new", ...original.map(thread => thread.id)]);
    assert.equal(view.nextCursor, native.nextCursor);
  }
  const cached = page(row("new"));
  assert.equal(publisher.projectList({}, cached), cached, "a cached copy is displayed once");
  assert.deepEqual((publisher.projectList({}, page()) as ThreadListResponse).data.map(thread => thread.id), ["new"]);
  for (const params of [{ cursor: "next" }, { archived: true }, { searchTerm: "other" }]) {
    assert.equal(publisher.projectList(params, native), native);
  }
  publisher.observeResult("thread/list", { cursor: "next" }, cached);
  assert.equal(publisher.projectList({}, native), native, "native discovery retires the provisional row");
});


test("existing thread turn start publishes a running fact without depending on status notification",()=>{
 const events:ThreadCatalogChange[]=[];const publisher=new ThreadCatalogPublisher((_method,event)=>events.push(event),true);
 publisher.observeNotification("turn/started",{threadId:"existing",turn:{id:"live"}});
 assert.deepEqual(events.at(-1)?.change,{type:"patch",threadId:"existing",status:{type:"active",activeFlags:[]}});
 publisher.observeResult("thread/start",{ephemeral:true},{thread:row("helper")});
 const count=events.length;publisher.observeNotification("turn/started",{threadId:"helper",turn:{id:"temporary"}});assert.equal(events.length,count);
});

test("native value confirmation survives Query structural sharing; a lagging or projected read is not confirmation", () => {
  const q = new QueryClient();
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true;
  updates.receive(change(1, { type: "patch", threadId: "A", name: "committed" }));
  const before = updates.getSnapshot();
  const old = updates.markRead(page({ ...row("A"), name: "old" }), before);
  q.setQueryData(["catalog"], old);
  updates.acknowledge(q.getQueryData<ThreadListResponse>(["catalog"]));
  assert.equal(updates.hasPending, true);
  updates.acknowledge(updates.markRead(updates.project(old)!, before));
  assert.equal(updates.hasPending, true, "a projected value cannot acknowledge itself");
  const matching = updates.markRead(page({ ...row("A"), name: "committed" }), before);
  q.setQueryData(["catalog"], matching);
  updates.acknowledge(q.getQueryData<ThreadListResponse>(["catalog"]));
  assert.equal(updates.hasPending, false, "only native field-value evidence confirms the write");
  q.clear();
});

test("materialized cache cannot self-acknowledge, and repeated folding is referentially stable", () => {
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true;
  const q = new QueryClient();
  const native = updates.markRead(page(row("A")), updates.getSnapshot());
  const data = { pages: [native], pageParams: [null] };
  q.setQueryData(["catalog"], data);
  updates.receive(change(1, { type: "patch", threadId: "A", name: "committed" }));
  q.setQueryData(["catalog"], updates.materialize(q.getQueryData(["catalog"])));
  const cached = q.getQueryData<typeof data>(["catalog"])!;
  updates.acknowledge(cached);
  assert.equal(updates.hasPending, true);
  assert.equal(updates.materialize(cached), cached, "no render/update loop after structural sharing");
  q.clear();
});

test("incomplete directory absence cannot retire removal; complete native pages can", () => {
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true;
  updates.receive(change(1, { type: "remove", threadId: "A" }));
  const cut = updates.getSnapshot();
  updates.acknowledge(updates.markRead({ ...page(), catalog: { state: "warming", coverage: "partial" } } as ThreadListResponse, cut));
  assert.equal(updates.hasPending, true);
  const first = updates.markRead({ ...page(row("B")), nextCursor: "tail" }, cut);
  updates.acknowledge(first); assert.equal(updates.hasPending, true);
  const tail = updates.markRead(page(row("C")), cut);
  updates.acknowledge({ pages: [first, tail], pageParams: [null, "tail"] });
  assert.equal(updates.hasPending, false);
});


test("a matching tail duplicate cannot acknowledge a fact hidden by the authoritative first row", () => {
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true;
  updates.receive(change(1, { type: "patch", threadId: "A", name: "committed" }));
  const at = updates.getSnapshot();
  const first = updates.markRead({ ...page({ ...row("A"), name: "lagging-first" }), nextCursor: "tail" }, at);
  const tail = updates.markRead(page({ ...row("A"), name: "committed" }), at);
  updates.acknowledge({ pages: [first, tail], pageParams: [null, "tail"] });
  assert.equal(updates.hasPending, true, "confirmation uses the same first-occurrence law as display");
  assert.equal(updates.project(first)?.data[0]?.name, "committed");
});
