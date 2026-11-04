import assert from "node:assert/strict";
import test from "node:test";
import { DirectorySnapshotIndex, DirectorySnapshotPages, SNAPSHOT_START } from "../../packages/app-host-server/src/thread-directory/snapshots.js";
import { ThreadCatalog } from "../../apps/local-agent-host/src/thread-catalog.js";
import { ThreadCatalogUpdates } from "../../apps/workbench-web/src/runtime/thread-catalog-updates.js";
import { parseThreadCatalogSnapshot } from "@opencraft/appserver-protocol";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
const row = (id: string, at = 1, name = id): Thread => ({ id, cwd: "/synthetic", createdAt: 1, updatedAt: at, name, preview: "", status: { type: "idle" }, ephemeral: false, turns: [] } as Thread);
const ready = { state: "ready", coverage: "complete" };
const stamp = (source: string, revision: number) => ({ version: 1, id: "snapshot", checkpoints: [{ source, revision }] });

test("immutable pages retain the initial ordering and content through moves, edits and deletes", () => {
  const index = new DirectorySnapshotIndex(), pager = new DirectorySnapshotPages();
  for (let i = 0; i < 220; i++) index.set(row(String(i).padStart(3, "0"), 500 - i), false);
  const capture = () => ({ parts: [{ root: index.capture(false), checkpoint: { source: "directory:one", revision: 220 } }], catalog: ready });
  let page = pager.list(SNAPSHOT_START, false, 50, capture);
  const firstId = page.catalogSnapshot.id, collected = [...page.data];
  index.set(row("210", 1000, "moved"), false); index.delete("150"); index.set(row("new", 2000), false);
  while (page.nextCursor) {
    page = pager.list(page.nextCursor, false, 50, () => { throw Error("continuation cannot recapture"); });
    assert.equal(page.catalogSnapshot.id, firstId); collected.push(...page.data);
  }
  assert.equal(collected.length, 220); assert.equal(new Set(collected.map(x => x.id)).size, 220);
  assert.equal(collected.find(x => x.id === "210")!.name, "210"); assert.ok(collected.some(x => x.id === "150"));
  const fresh = pager.list(SNAPSHOT_START, false, 50, capture);
  assert.equal(fresh.data[0]!.id, "new");
});

test("balanced index matches a reference model through deterministic updates and removals", () => {
  const index = new DirectorySnapshotIndex(), reference = new Map<string, Thread>();
  let random = 17;
  for (let n = 0; n < 2000; n++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const id = String(random % 173);
    if (random % 5 === 0) { index.delete(id); reference.delete(id); }
    else { const item = row(id, random % 37); index.set(item, false); reference.set(id, item); }
    if (n % 31 === 0) {
      const pager = new DirectorySnapshotPages();
      const page = pager.list(SNAPSHOT_START, false, 1000, () => ({ parts: [{ root: index.capture(false), checkpoint: { source: "s", revision: n } }], catalog: ready }));
      const expected = [...reference.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      assert.deepEqual(page.data, expected);
    }
  }
});

test("expired, foreign-owner and wrong-partition cursors require a fresh snapshot", () => {
  let now = 0;
  const index = new DirectorySnapshotIndex(), pager = new DirectorySnapshotPages(() => now, 10);
  index.set(row("a", 2), false); index.set(row("b"), false);
  const capture = () => ({ parts: [{ root: index.capture(false), checkpoint: { source: "s", revision: 2 } }], catalog: ready });
  const page = pager.list(SNAPSHOT_START, false, 1, capture);
  assert.throws(() => pager.list(page.nextCursor!, true, 1, capture), /expired/);
  assert.throws(() => new DirectorySnapshotPages().list(page.nextCursor!, false, 1, capture), /expired/);
  now = 11; assert.throws(() => pager.list(page.nextCursor!, false, 1, capture), /expired/);
});

test("real directory snapshot checkpoints retire old titles and deleted creations, preserving later events", async t => {
  const store = new ThreadCatalog(); t.after(() => store.close());
  const events: any[] = [];
  const directory = store.createProjection({ list: async () => ({ data: [], nextCursor: null }), changed: event => { if (event) events.push(event); } });
  await directory.refresh();
  directory.observe("thread/started", { thread: row("a", 1, "earlier") });
  const updates = new ThreadCatalogUpdates("host"); updates.enabled = true; updates.receive(events.at(-1));
  directory.observe("thread/name/updated", { threadId: "a", name: "later" });
  let snapshot = await directory.list({ sortKey: "updated_at", cursor: SNAPSHOT_START });
  assert.ok(parseThreadCatalogSnapshot(snapshot));
  updates.acknowledge(updates.markRead(snapshot, updates.getSnapshot()), true);
  assert.equal(updates.project(snapshot)!.data[0]!.name, "later"); assert.equal(updates.hasPending, false);
  directory.observe("thread/started", { thread: row("b") }); updates.receive(events.at(-1));
  directory.observe("thread/deleted", { threadId: "b" }); // deletion notification missed during disconnect
  snapshot = await directory.list({ sortKey: "updated_at", cursor: SNAPSHOT_START });
  const boundary = updates.getSnapshot();
  directory.observe("thread/name/updated", { threadId: "a", name: "after-snapshot" }); updates.receive(events.at(-1));
  updates.acknowledge(updates.markRead(snapshot, boundary), true);
  assert.deepEqual(updates.project(snapshot)!.data.map(x => x.id), ["a"]);
  assert.equal(updates.project(snapshot)!.data[0]!.name, "after-snapshot");
});

test("complete certified reads replace facts from retired publishers; partial absence cannot", () => {
  const u = new ThreadCatalogUpdates("host"); u.enabled = true;
  u.receive({ version: 1, source: "directory:old", revision: 99, change: { type: "upsert", thread: row("deleted") } });
  const partial = { data: [], nextCursor: null, catalog: { state: "warming", coverage: "unknown" }, catalogSnapshot: stamp("directory:new", 0) };
  u.acknowledge(u.markRead(partial, u.getSnapshot()), true); assert.equal(u.hasPending, true);
  const fresh = { ...partial, catalog: ready };
  u.acknowledge(u.markRead(fresh, u.getSnapshot()), true); assert.equal(u.hasPending, false);
  u.receive({ version: 1, source: "legacy-status:one", revision: 1, change: { type: "upsert", thread: row("stale") } });
  assert.equal(u.hasPending, false);
});

test("batch delivery applies all rows once and snapshot checkpoints reject late old notifications", () => {
  const u=new ThreadCatalogUpdates('host');u.enabled=true;
  u.receive({version:1,authority:'directory',source:'s',revision:7,change:{type:'batch',changes:[
    {type:'upsert',thread:row('a')},{type:'upsert',thread:row('b')},
  ]}});
  assert.equal(u.project(undefined)!.data.length,2);
  const fresh={data:[row('a',1,'newer')],nextCursor:null,catalog:ready,catalogSnapshot:stamp('s',9)};
  u.acknowledge(u.markRead(fresh,u.getSnapshot()),true);
  assert.equal(u.hasPending,false);
  u.receive({version:1,authority:'directory',source:'s',revision:8,change:{type:'patch',threadId:'a',name:'late-old'}});
  assert.equal(u.project(fresh)!.data[0]!.name,'newer');
});

test('file-backed snapshot SQL stays in its reader worker and its revision matches canonical notifications',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'directory-snapshot-worker-'));
 const store=new ThreadCatalog(join(folder,'catalog.sqlite'));t.after(()=>{store.close();rmSync(folder,{recursive:true,force:true});});
 const source=Array.from({length:120},(_,i)=>row(`file-${i}`,1000-i));const events:any[]=[];
 const directory=store.createProjection({list:async p=>({data:p.archived?[]:source,nextCursor:null}),changed:e=>{if(e)events.push(e);}});
 await directory.refresh();
 const db=(store as any).database,prepare=db.prepare.bind(db),exec=db.exec.bind(db);let guarded=true;
 db.prepare=(...args:any[])=>{if(guarded)throw Error('main-thread SQL forbidden');return prepare(...args);};
 db.exec=(...args:any[])=>{if(guarded)throw Error('main-thread SQL forbidden');return exec(...args);};
 t.after(()=>{guarded=false;});
 let page=await directory.list({sortKey:'updated_at',cursor:SNAPSHOT_START,limit:50});
 const snapshot=parseThreadCatalogSnapshot(page)!;assert.equal(snapshot.checkpoints[0]!.revision,events.at(-1).revision);
 guarded=false;directory.observe('thread/name/updated',{threadId:'file-100',name:'new-worker-name'});guarded=true;
 const names=page.data;
 while(page.nextCursor){page=await directory.list({sortKey:'updated_at',cursor:page.nextCursor,limit:50});assert.equal(parseThreadCatalogSnapshot(page)!.id,snapshot.id);names.push(...page.data);}
 assert.equal(names.length,120);assert.equal(names.find(x=>x.id==='file-100')!.name,'file-100');
 const fresh=await directory.list({sortKey:'updated_at',cursor:SNAPSHOT_START,limit:200});
 assert.equal(fresh.data.find(x=>x.id==='file-100')!.name,'new-worker-name');assert.equal(parseThreadCatalogSnapshot(fresh)!.checkpoints[0]!.revision,events.at(-1).revision);
 guarded=false;
});
