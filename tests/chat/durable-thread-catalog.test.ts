import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS, OPENCRAFT_HOST_STATE_BASELINE, OPENCRAFT_HOST_BOT_STATE, OPENCRAFT_HOST_IOA_CREATORS, OPENCRAFT_HOST_SENDER_ORIGINS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database";
import { DurableThreadCatalog } from "../../apps/opencraft-daemon/src/durable-thread-catalog";

const row = (id: string, updatedAt: number, name = id) => ({ id, cwd: "/fixture", updatedAt, createdAt: 1, recencyAt: null, name,
  preview: "fixture preview", status: { type: "idle" }, ephemeral: false, turns: [{ items: [{ text: "private history MUST NOT persist" }] }], extra: { secret: "not metadata" } });
const query = { sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "oc-durable-catalog-"));
  const owner = new OpenCraftHostStateDatabase(root);
  t.after(async () => { owner.close(); await rm(root, { recursive: true, force: true }); });
  return { root, owner };
}

test("v4 to v5 migration preserves every existing row and checksum history; tampering refuses without moving data", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-catalog-upgrade-")), path = join(root, "codex-host-queue.sqlite");
  try {
    const { database: old } = openManagedDatabase({ path, migrations: [
      {version: 1, name: "codex-host-state", sql: OPENCRAFT_HOST_STATE_BASELINE},
      {version: 2, name: "codex-bot-state", sql: OPENCRAFT_HOST_BOT_STATE},
      {version: 3, name: "ioa-thread-creators", sql: OPENCRAFT_HOST_IOA_CREATORS},
      {version: 4, name: "message-sender-origins", sql: OPENCRAFT_HOST_SENDER_ORIGINS},
    ] });
    old.exec(`INSERT INTO message_senders VALUES('t','m','{"kind":"employee","loginName":"alice"}',1);
      INSERT INTO ioa_thread_creators VALUES('t','alice'); INSERT INTO ioa_message_presence VALUES('t','m','alice');
      INSERT INTO ioa_participant_state VALUES('t',7); INSERT INTO message_sender_origins VALUES('t','m','parent');
      INSERT INTO codex_host_queue VALUES('q','t','client','[]',1,1,1,'queued',NULL,NULL);`);
    const oldTables = ["message_senders", "ioa_thread_creators", "ioa_message_presence", "ioa_participant_state", "message_sender_origins", "codex_host_queue"];
    const tables = oldTables.map(table => table === "codex_host_queue" ? "opencraft_host_queue" : table);
    const before = oldTables.map(table => old.prepare(`SELECT * FROM ${table}`).all());
    const history = old.prepare("SELECT * FROM schema_migrations ORDER BY version").all(); old.close();
    let owner = new OpenCraftHostStateDatabase(root);
    assert.equal(owner.outcome.status, "migrated"); assert.ok(owner.outcome.backupPath); assert.deepEqual(owner.outcome.movedAsidePaths, []);
    assert.deepEqual(tables.map(table => owner.database.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.deepEqual(owner.database.prepare("SELECT * FROM schema_migrations WHERE version<=4 ORDER BY version").all(), history);
    assert.equal(owner.database.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()?.n, OPENCRAFT_HOST_STATE_MIGRATIONS.at(-1)!.version);
    owner.close(); owner = new OpenCraftHostStateDatabase(root); assert.equal(owner.outcome.status, "up-to-date"); owner.close();
    const tamper = new DatabaseSync(path); tamper.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=4"); tamper.close();
    assert.throws(() => new OpenCraftHostStateDatabase(root), e => e instanceof SqliteLifecycleError && e.kind === "history-mismatch");
    const read = new DatabaseSync(path, {readOnly: true}); assert.deepEqual(tables.map(table => read.prepare(`SELECT * FROM ${table}`).all()), before); read.close();
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("server catalog persists only metadata; deterministic local pagination and warm restart do not wait for remote reads", async t => {
  const {owner} = await fixture(t); let calls = 0;
  const catalog = new DurableThreadCatalog(owner.database, { list: async p => {
    calls++; return {data: p.archived ? [row("archived", 9)] : p.cursor ? [row("c", 2)] : [row("b", 3), row("a", 3)], nextCursor: !p.archived && !p.cursor ? "native-page-2" : null};
  }, changed: () => {} }); t.after(() => catalog.close());
  await catalog.refresh(); assert.equal(calls, 3);
  const first = await catalog.list({...query, limit: 1}); assert.deepEqual(first.data.map(t=>t.id),["a"]);
  const second = await catalog.list({...query, limit: 1, cursor: first.nextCursor}); assert.deepEqual(second.data.map(t=>t.id),["b"]);
  assert.deepEqual((await catalog.list({...query,cursor:second.nextCursor})).data.map(t=>t.id),["c"]);
  assert.deepEqual((await catalog.list({...query,archived:true})).data.map(t=>t.id),["archived"]);
  const stored = owner.database.prepare("SELECT metadata_json FROM opencraft_thread_catalog").all().map(r=>String(r.metadata_json)).join();
  assert.ok(!stored.includes("MUST NOT persist") && !stored.includes("not metadata")); assert.deepEqual(first.data[0]!.turns,[]);
  catalog.close();
  const restarted = new DurableThreadCatalog(owner.database, {list: () => new Promise(()=>{}),changed:()=>{}}); t.after(()=>restarted.close());
  assert.deepEqual((await restarted.list(query)).data.map(t=>t.id),["a","b","c"]);
  assert.equal(restarted.supports({sortKey:"created_at"}),false);
  assert.equal(restarted.supports({...query,searchTerm:"a"}),false,"advanced queries preserve native behavior");
  await assert.rejects(restarted.list({...query,cursor:"opencraft-catalog-v1:bad"}), /cursor/);
});

test("partial pages and failed refresh keep the last successful directory and completion timestamp", async t => {
  const {owner} = await fixture(t); let fail = false, at = 100;
  const catalog = new DurableThreadCatalog(owner.database,{list:async p=>{
    if(fail && p.cursor) throw Error("offline");
    return {data: p.archived?[]:fail?[row("new",9)]:[row("old",1)],nextCursor: fail&&!p.archived?"next":null};
  },changed:()=>{}},()=>at);t.after(()=>catalog.close());
  await catalog.refresh(); fail=true;at+=3_600_001;
  await assert.rejects(catalog.refresh());
  const result=await catalog.list(query);assert.deepEqual(result.data.map(t=>t.id),["old"]);
  assert.equal(result.catalog.lastSuccessAt,100);assert.equal(result.catalog.state,"error");
});

test("newer events and tombstones fence old in-flight pages, including deletion of an unseen row", async t => {
  const {owner}=await fixture(t);let release:(v:unknown)=>void=()=>{};
  const catalog=new DurableThreadCatalog(owner.database,{list:p=>p.archived?Promise.resolve({data:[],nextCursor:null}):new Promise(resolve=>{release=resolve}),changed:()=>{}});t.after(()=>catalog.close());
  const job=catalog.refresh();
  catalog.observe("thread/started",{thread:row("a",10,"new title")});
  catalog.observe("thread/deleted",{threadId:"b"});
  release({data:[row("a",1,"old title"),row("b",2)],nextCursor:null});await job;
  catalog.observe("thread/read",{threadId:"a"},{thread:row("a",1,"late read")});
  const result=await catalog.list(query);
  assert.deepEqual(result.data.map(t=>[t.id,t.name]),[["a","new title"]]);
});

test("closing synchronization revokes late results before the owner closes its DB", async t => {
  const {owner}=await fixture(t);let release:(v:unknown)=>void=()=>{};
  const catalog=new DurableThreadCatalog(owner.database,{list:()=>new Promise(resolve=>{release=resolve}),changed:()=>assert.fail("closed service cannot publish")});
  const job=catalog.refresh();catalog.close();release({data:[row("late",1)],nextCursor:null});await job;
  assert.equal(owner.database.prepare("SELECT COUNT(*) AS n FROM opencraft_thread_catalog").get()?.n,0);
});

test("real remote adapter serves its server-owned catalog and keeps advanced native queries separate", async t => {
  const { MemoryTransport } = await import("@opencraft/appserver-transport-memory");
  const { CodexEngineAdapter } = await import("../../apps/opencraft-daemon/src/codex-engine-adapter");
  const { stampLogicalClientFrame } = await import("@opencraft/app-host-protocol");
  const root = await mkdtemp(join(tmpdir(),"oc-catalog-adapter-"));
  let nativeLists = 0;
  const transport = new MemoryTransport({receive(frame,peer){
    const request = JSON.parse(frame); if(request.id===undefined)return;
    if(request.method==="thread/list")nativeLists++;
    const result=request.method==="initialize"?{userAgent:"fixture",platform:"linux",codexHome:"/remote"}
      :request.method==="thread/list"?{data:request.params.archived?[]:[row("remote",10)],nextCursor:null}
      :{data:[],nextCursor:null};
    peer.send(JSON.stringify({id:request.id,result}));
  }});
  const adapter = new CodexEngineAdapter({kind:"remote",transport,attachmentHistoryDirectory:root,logDiagnostic:()=>{}});
  t.after(async()=>{await adapter.close();await rm(root,{recursive:true,force:true});});
  const frames:any[]=[];adapter.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
  let sequence=0;
  const rpc=async(method:string,params={})=>{
    const id=++sequence;await adapter.send(stampLogicalClientFrame(JSON.stringify({id,method,params}),"catalog-reader"));
    const deadline=Date.now()+2000;
    while(!frames.some(frame=>frame.id===id)){assert.ok(Date.now()<deadline,"adapter reply timed out");await new Promise(r=>setTimeout(r,1));}
    return frames.find(frame=>frame.id===id);
  };
  await adapter.connect();
  assert.equal((await rpc("thread/list",query)).error.code,-32600,"cache cannot bypass initialized reader admission");
  await rpc("initialize");
  const first=await rpc("thread/list",query);
  assert.deepEqual(first.result.data.map((t:any)=>t.id),["remote"]);assert.deepEqual(first.result.data[0].turns,[]);
  assert.equal(first.result.catalog.state,"ready");assert.equal(nativeLists,2,"one server-owned active/archive synchronization");
  await rpc("thread/list",query);assert.equal(nativeLists,2,"another reader list does not rescan the remote directory");
  await rpc("thread/list",{...query,searchTerm:"native"});assert.equal(nativeLists,3,"advanced filters retain native admission and semantics");
});
