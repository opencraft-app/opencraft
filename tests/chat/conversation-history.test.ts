import { APP_HOST_PROTOCOL_VERSION } from '@opencraft/app-host-protocol/version';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { callConversationHost, createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ConversationHistory, HistoryNotStored, InvalidHistoryCursor } from "../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport.js";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

type Value = Record<string, any>;
async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "conversation-facts-"));
  let storage = await openServerDatabase(directory);
  t.after(async () => { await storage.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get storage() { return storage; }, history: new ConversationHistory(storage.database, "local-codex"),
    async reopen() { await storage.close(); storage = await openServerDatabase(directory); return new ConversationHistory(storage.database, "local-codex"); } };
}
const metadata = (id = "thread-1") => ({ id, cwd: "/synthetic", updatedAt: 100, createdAt: 90, historyMode: "paginated", ephemeral: false, turns: [] });
const turn = (id = "turn-1", output = "x".repeat(100_000)) => ({ id, status: "completed", itemsView: "full", items: [
  { id: "user-1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
  { id: "tool-1", type: "commandExecution", status: "completed", aggregatedOutput: output },
  { id: "agent-1", type: "agentMessage", text: "answer" },
] });
function seed(history: ConversationHistory, turns = [turn()]) {
  history.importResult("initialize", {}, { capabilities: { extensions: {} }, userAgent: "synthetic" }, 0);
  history.importResult("thread/list", {}, { data: [metadata()], nextCursor: null }, history.catalogRevision());
  history.importResult("thread/read", { threadId: "thread-1", includeTurns: true }, { thread: { ...metadata(), turns } }, history.revision("thread-1"));
}
class FakeEngine implements DuplexTransport {
  status: TransportStatus = { state: "idle" };
  starts = 0; sends: Value[] = [];
  messages = new Set<(frame: string) => void>(); statuses = new Set<(status: TransportStatus) => void>();
  handle: (request: Value) => Value | null = request => request.method === "initialize" ? { capabilities: { extensions: {} }, userAgent: "synthetic" }
    : request.method === "thread/read" ? { thread: metadata(), initialTurnsPage: { data: [turn()], nextCursor: null } } : {};
  async connect() { this.starts++; this.status = { state: "open" }; }
  async send(frame: string) { const request = JSON.parse(frame); this.sends.push(request); const result = this.handle(request);
    if (request.id !== undefined && result) this.emit({ id: request.id, result, ...(request.__opencraftClient ? { __opencraftClient: request.__opencraftClient } : {}) }); }
  emit(packet: Value) { for (const listener of this.messages) listener(JSON.stringify(packet)); }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  async close() { this.status = { state: "closed" }; }
}
async function rpc(transport: DuplexTransport, id: number, method: string, params: Value = {}) {
  let response: Value | undefined;
  const remove = transport.subscribeMessage(frame => { const message = JSON.parse(frame); if (message.id === id && !message.method) response = message; });
  try { await transport.send(JSON.stringify({ id, method, params })); return response; } finally { remove(); }
}

test("stored history survives Server reopen; summary and deferred detail read independently", async t => {
  const f = await fixture(t); seed(f.history);
  const history = await f.reopen();
  const summary = history.read("thread/turns/list", { threadId: "thread-1", itemsView: "summary" });
  assert.deepEqual(summary.data[0].items.map((item: Value) => item.id), ["user-1", "agent-1"]);
  const page = history.read("thread/read", { threadId: "thread-1", includeTurns: false, initialTurnsPage: { itemsView: "presentation", limit: 1 } });
  assert.deepEqual(page.thread.turns, []);
  const tool = page.initialTurnsPage.data[0].items[1];
  assert.equal(tool.aggregatedOutput.length, 1024); assert.ok(tool.historyDetail);
  const detail = history.read("thread/turns/list", { threadId: "thread-1", cursor: tool.historyDetail.cursor, itemsView: "full", detailItemId: tool.id, limit: 1 });
  assert.equal(detail.data[0].items[0].aggregatedOutput.length, 100_000);
  const first = history.read("thread/items/list", { threadId: "thread-1", turnId: "turn-1", limit: 1 });
  assert.equal(first.data[0].item.id, "user-1");
  const second = history.read("thread/items/list", { threadId: "thread-1", turnId: "turn-1", limit: 1, cursor: first.nextCursor });
  assert.equal(second.data[0].item.id, "tool-1");
});

test("generated images keep file identities in presentation and full bytes in detail", async t => {
  const { history } = await fixture(t);
  const result = "aW1hZ2U=".repeat(250_000);
  const image = { id: "generated", type: "imageGeneration", status: "completed", result,
    savedPath: "/synthetic/generated/image.png", transparentBackground: true, revisedPrompt: "A generated layout" };
  seed(history, [{ ...turn(), items: [image] }]);
  const page = history.read("thread/turns/list", { threadId: "thread-1", itemsView: "presentation" });
  assert.equal(page.data[0].items[0].result, "");
  assert.equal(page.data[0].items[0].savedPath, image.savedPath);
  assert.equal(page.data[0].items[0].transparentBackground, true);
  assert.ok(JSON.stringify(page).length < 5000, "normal image history must not ship the base64 body");
  assert.equal(history.read("thread/turns/list", { threadId: "thread-1", itemsView: "full" }).data[0].items[0].result, result);
  const version = page.historyVersion;
  history.observe("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { ...image, id: "live-image" } });
  const update = history.changesSince("thread-1", version)!;
  const live = update.turns.flatMap(entry => entry.turn.items).find(item => item.id === "live-image") as Value;
  assert.equal(live.result, ""); assert.equal(live.savedPath, image.savedPath);
  assert.equal(live.historyDetail, undefined);
});

test("inline-only generated images remain lossless in presentation and live updates", async t => {
  const { history } = await fixture(t);
  const result = "aW1hZ2U=".repeat(1000);
  const image = { id: "inline-image", type: "imageGeneration", status: "completed", result };
  seed(history, [{ ...turn(), items: [image] }]);
  const page = history.read("thread/turns/list", { threadId: "thread-1", itemsView: "presentation" });
  assert.equal(page.data[0].items[0].result, result);
  assert.equal(page.data[0].items[0].historyDetail, undefined);
  history.observe("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { ...image, id: "live-inline" } });
  const live = history.changesSince("thread-1", page.historyVersion)!.turns.flatMap(entry => entry.turn.items)
    .find(item => item.id === "live-inline") as Value;
  assert.equal(live.result, result);
});

test("legacy truncated image previews recover on read without a database migration", async t => {
  const f = await fixture(t);
  const result = "aW1hZ2U=".repeat(1000);
  const images = [
    { id: "file-image", type: "imageGeneration", status: "completed", result, savedPath: "/synthetic/image.png" },
    { id: "inline-image", type: "imageGeneration", status: "completed", result },
  ];
  seed(f.history, [{ ...turn(), items: images }]);
  for (const image of images) f.storage.database.prepare("UPDATE conversation_events SET preview=? WHERE kind='item' AND type='imageGeneration' AND record_id=?")
    .run(JSON.stringify({ ...image, result: result.slice(0,1024), __deferred: true }), `item:${JSON.stringify(["turn-1",image.id])}`);
  const before = f.history.revision("thread-1");
  const reopened = await f.reopen();
  const page = reopened.read("thread/turns/list", { threadId: "thread-1", itemsView: "presentation" });
  assert.equal(page.data[0].items[0].result, "");
  assert.equal(page.data[0].items[0].savedPath, images[0].savedPath);
  assert.equal(page.data[0].items[1].result, result);
  assert.ok(page.data[0].items.every((item: Value) => !item.historyDetail));
  assert.equal(reopened.revision("thread-1"), before, "read repair must not mutate stored facts");
});

test("snapshot import cannot overwrite a later live event; replay is idempotent", async t => {
  const { history } = await fixture(t); seed(history);
  const fence = history.revision("thread-1");
  const event = { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "new answer" } };
  history.observe("item/completed", event);
  const committed = history.revision("thread-1");
  history.observe("item/completed", event); assert.equal(history.revision("thread-1"), committed);
  history.importResult("thread/read", { threadId: "thread-1", includeTurns: true }, { thread: { ...metadata(), turns: [turn()] } }, fence);
  const page = history.read("thread/turns/list", { threadId: "thread-1", itemsView: "full" });
  assert.equal(page.data[0].items[2].text, "new answer");
  history.observe("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
  assert.equal(history.read("thread/turns/list", { threadId: "thread-1" }).data[0].status, "completed");
});

test("partial pages preserve an unavailable older range; cursors are scoped to Host and Thread", async t => {
  const f = await fixture(t), history = f.history;
  history.importResult("thread/read", { threadId: "thread-1", includeTurns: false }, { thread: metadata(), initialTurnsPage: { data: [turn()], nextCursor: "native-older" } }, 0);
  const page = history.read("thread/turns/list", { threadId: "thread-1" });
  assert.ok(page.nextCursor);
  assert.throws(() => history.read("thread/turns/list", { threadId: "thread-1", cursor: page.nextCursor }), HistoryNotStored);
  assert.equal(history.sourceCursor("thread-1", page.nextCursor), "native-older");
  const peer = new ConversationHistory(f.storage.database, "opencraft-server"); seed(peer);
  assert.throws(() => peer.read("thread/turns/list", { threadId: "thread-1", cursor: page.nextCursor }), InvalidHistoryCursor);
  history.metadata(metadata("thread-2"));
  assert.throws(() => history.read("thread/turns/list", { threadId: "thread-2", cursor: page.nextCursor }), InvalidHistoryCursor);
});

test("ephemeral bodies are excluded; deletion revokes cursors and removes retained payloads", async t => {
  const { history, storage } = await fixture(t);
  history.importResult("thread/read", { threadId: "temporary", includeTurns: true }, { thread: { ...metadata("temporary"), ephemeral: true, turns: [turn()] } }, 0);
  assert.equal(history.thread("temporary"), null);
  seed(history); history.observe("thread/deleted", { threadId: "thread-1" });
  assert.equal(history.thread("thread-1"), null);
  assert.equal(storage.database.prepare("SELECT count(*) AS n FROM conversation_payloads").get()?.n, 0);
  assert.throws(() => history.read("thread/read", { threadId: "thread-1" }), HistoryNotStored);
});

test("header-only source pages never masquerade as complete empty detail", async t => {
  const { history } = await fixture(t);
  history.importResult("thread/read", { threadId: "thread-1" }, { thread: metadata(), initialTurnsPage: { data: [{ id: "turn-1", itemsView: "notLoaded", items: [] }], nextCursor: null } }, 0);
  assert.throws(() => history.read("thread/turns/list", { threadId: "thread-1", itemsView: "full" }), HistoryNotStored);
  assert.equal(history.read("thread/turns/list", { threadId: "thread-1", itemsView: "notLoaded" }).data[0].itemsView, "notLoaded");
});

test("stored history remains readable when fresh capability discovery fails", async t => {
  const f = await fixture(t); seed(f.history);
  const history = await f.reopen(), engine = new FakeEngine(); engine.handle = () => { throw new Error("offline"); };
  const transport = new ConversationHistoryTransport(engine, history, undefined, 100); t.after(() => transport.close());
  await transport.connect();
  assert.ok((await rpc(transport, 1, "initialize"))?.result);
  const reply = await rpc(transport, 2, "thread/read", { threadId: "thread-1", watch: true, initialTurnsPage: { limit: 1, itemsView: "presentation" } });
  assert.equal(reply?.result.initialTurnsPage.data[0].id, "turn-1");
  const discoverySends = engine.sends.length;
  assert.equal(engine.starts, 1); assert.ok(discoverySends <= 2); // cached watch may try one independent background reconciliation.
  assert.ok((await rpc(transport, 3, "thread/list"))?.result); assert.equal(engine.sends.length, discoverySends);
});

test("cold history imports through read-only native RPCs and is readable after engine loss", async t => {
  const f = await fixture(t), engine = new FakeEngine();
  const transport = new ConversationHistoryTransport(engine, f.history, undefined, 100); t.after(() => transport.close());
  await transport.connect(); await rpc(transport, 1, "initialize");
  const reply = await rpc(transport, 2, "thread/read", { threadId: "thread-1", includeTurns: false, initialTurnsPage: { limit: 1, itemsView: "presentation" } });
  assert.equal(reply?.result.initialTurnsPage.data[0].id, "turn-1");
  assert.equal(engine.sends.some(request => request.method === "thread/resume"), false);
  assert.ok(f.history.thread("thread-1"));
  engine.handle = () => { throw new Error("offline"); };
  const cached = await rpc(transport, 3, "thread/read", { threadId: "thread-1", initialTurnsPage: { limit: 1, itemsView: "presentation" } });
  assert.equal(cached?.result.initialTurnsPage.data[0].items[2].text, "answer");
});

test("keyset history cursors survive a newer live group without skipping an older group", async t => {
  const { history } = await fixture(t); seed(history,[turn("old"),turn("middle"),turn("latest")]);
  const first=history.read("thread/turns/list",{threadId:"thread-1",limit:1});
  assert.equal(first.data[0].id,"latest");
  history.observe("turn/started",{threadId:"thread-1",turn:{id:"live",status:"inProgress"}});
  const second=history.read("thread/turns/list",{threadId:"thread-1",limit:1,cursor:first.nextCursor});
  assert.equal(second.data[0].id,"middle");
  const third=history.read("thread/turns/list",{threadId:"thread-1",limit:1,cursor:second.nextCursor});
  assert.equal(third.data[0].id,"old");assert.equal(third.nextCursor,null);
});

test("stored directory pages are independent of native page sizes", async t => {
  const { history }=await fixture(t);
  history.importResult("thread/list",{}, {data:Array.from({length:27},(_,i)=>({...metadata(`t-${i}`),updatedAt:i})),nextCursor:null},0);
  const ids:string[]=[];let cursor=null;
  do {const page=history.list({limit:4,cursor});ids.push(...page.data.map((row:Value)=>row.id));cursor=page.nextCursor;} while(cursor);
  assert.equal(ids.length,27);assert.equal(new Set(ids).size,27);assert.equal(ids[0],"t-26");
});

test("a failed fact transaction leaves neither metadata, sequence nor orphan bodies", async t => {
  const { history,storage }=await fixture(t);
  storage.database.exec("CREATE TRIGGER reject_fact BEFORE INSERT ON conversation_events WHEN NEW.event_type='put' BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
  assert.throws(()=>history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[turn()]}},0),/synthetic fault/);
  assert.equal(history.thread("thread-1"),null);
  assert.equal(history.revision("thread-1"),0);
  assert.equal(storage.database.prepare("SELECT count(*) AS n FROM conversation_payloads").get()?.n,0);
});

test("a full replacement removes an obsolete item and explicitly expires old cursors", async t => {
  const { history }=await fixture(t);seed(history,[turn("old"),turn("latest")]);
  const cursor=history.read("thread/turns/list",{threadId:"thread-1",limit:1}).nextCursor;
  const changed=turn("latest");changed.items.splice(1,1);
  history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[turn("old"),changed]}},history.revision("thread-1"));
  assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1",cursor}),InvalidHistoryCursor);
  assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1",limit:1}).data[0].items.map((item:Value)=>item.id),["user-1","agent-1"]);
});

test("summary and a single deferred detail never load unrelated large tool bodies", async t => {
  const { history,storage }=await fixture(t);seed(history);
  const hashes=storage.database.prepare("SELECT hash FROM conversation_events WHERE kind='item' AND current=1 AND type='commandExecution'").all().map(row=>String(row.hash));
  const guarded=new Proxy(storage.database,{get(target,key){
    const original=Reflect.get(target,key,target);
    if(key!=="prepare")return typeof original==="function"?original.bind(target):original;
    return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes("SELECT body FROM conversation_payloads"))return statement;
      return new Proxy(statement,{get(row,name){if(name!=="get")return Reflect.get(row,name,row);return (...args:any[])=>{assert.equal(hashes.includes(String(args[1])),false,"summary must not hydrate tool output");return row.get(...args);};}});
    };
  }});
  const reader=new ConversationHistory(guarded,"local-codex");
  const summary=reader.read("thread/turns/list",{threadId:"thread-1",itemsView:"summary"});
  assert.equal(summary.data[0].items.length,2);
  const presentation=reader.read("thread/turns/list",{threadId:"thread-1",itemsView:"presentation"});
  assert.equal(presentation.data[0].items[1].aggregatedOutput.length,1024);
});

test("the real Workbench acquires stored history with an unavailable source and no Resume",{timeout:5000},async t=>{
  const { createAppServerWorkbenchRuntime }=await import("@opencraft/workbench-runtime");
  const f=await fixture(t);seed(f.history);
  const history=await f.reopen(),engine=new FakeEngine();engine.handle=()=>{throw Error("synthetic source is offline");};
  const transport=new ConversationHistoryTransport(engine,history,undefined,50);
  const runtime=createAppServerWorkbenchRuntime({hostId:"persisted-fixture",transport,autoReconnect:false,requestTimeoutMs:500,onRecoveryEvent(){}});
  t.after(()=>runtime.dispose());
  await runtime.connect();const lease=await runtime.acquireThread("thread-1");lease.setRecoveryVisibility(true);
  for(let i=0;i<50&&!lease.getSnapshot().authoritative;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(lease.getSnapshot().authoritative,true,JSON.stringify(lease.getSnapshot().error));
  assert.match(JSON.stringify(lease.getSnapshot()),/answer/);
  assert.equal(engine.sends.some(request=>request.method==="thread/resume"||request.method==="turn/start"),false);
  lease.release();
});

test("a gap between new source history and old stored history is filled before joining the ranges", async t=>{
  const {history}=await fixture(t);seed(history,[turn("old-1"),turn("old-2")]);
  history.importResult("thread/turns/list",{threadId:"thread-1",cursor:null},{data:[turn("new-4"),turn("new-3")],nextCursor:"gap"},history.revision("thread-1"));
  const first=history.read("thread/turns/list",{threadId:"thread-1",limit:10});
  assert.deepEqual(first.data.map((row:Value)=>row.id),["new-4","new-3"]);
  assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1",cursor:first.nextCursor}),HistoryNotStored);
  history.importResult("thread/turns/list",{threadId:"thread-1",cursor:"gap"},{data:[turn("new-2"),turn("new-1"),turn("old-2"),turn("old-1")],nextCursor:null},history.revision("thread-1"));
  const rest=history.read("thread/turns/list",{threadId:"thread-1",cursor:first.nextCursor,limit:10});
  assert.deepEqual(rest.data.map((row:Value)=>row.id),["new-2","new-1","old-2","old-1"]);
  assert.equal(rest.nextCursor,null); // An observed paging end is separate from coverage certainty.
  assert.equal(rest.historyCoverage.state,"partial"); // opaque cursor chain is not a stable source generation
});

test("native item pages fill a header-only group without declaring a partial prefix complete",async t=>{
  const {history}=await fixture(t);
  history.importResult("thread/read",{threadId:"thread-1"},{thread:metadata(),initialTurnsPage:{data:[{id:"large",status:"completed",itemsView:"notLoaded",items:[]}],nextCursor:null}},0);
  history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large",cursor:null},{data:[{turnId:"large",item:{id:"a",type:"agentMessage",text:"first"}}],nextCursor:"item-tail"},history.revision("thread-1"));
  assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1"}),HistoryNotStored);
  history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large",cursor:"item-tail"},{data:[{turnId:"large",item:{id:"b",type:"agentMessage",text:"second"}}],nextCursor:null},history.revision("thread-1"));
  assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1"}).data[0].items.map((item:Value)=>item.id),["a","b"]);
});

test("a client whose native initialization failed can release its read lease without contacting the source",async t=>{
 const f=await fixture(t);seed(f.history);const history=await f.reopen(),engine=new FakeEngine();engine.handle=()=>{throw Error("offline");};
 const transport=new ConversationHistoryTransport(engine,history,undefined,50);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const count=engine.sends.length;await transport.send(JSON.stringify({method:"runtime/client/disconnect",params:{}}));assert.equal(engine.sends.length,count);
});


test("an unanswered native discovery releases only its logical lane before later execution",async t=>{
 const f=await fixture(t);seed(f.history);const history=await f.reopen(),engine=new FakeEngine();
 let nativeReady=false,attempts=0;
 engine.handle=request=>{
  if(request.method==="initialize") {assert.equal(nativeReady,false);nativeReady=true;return ++attempts===1?null:{capabilities:{extensions:{}}};}
  if(request.method==="runtime/client/disconnect") {nativeReady=false;return null;}
  return {};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,30);t.after(()=>transport.close());await transport.connect();
 assert.ok((await rpc(transport,1,"initialize"))?.result);
 assert.equal(engine.sends.filter(row=>row.method==="runtime/client/disconnect").length,1);
 await rpc(transport,2,"model/list");
 assert.equal(attempts,2);
 assert.equal(engine.sends.filter(row=>row.method==="model/list").length,1);
});

test("removal with unchanged survivors advances the durable version and survives projection rebuild",async t=>{
 const {history,storage}=await fixture(t);seed(history);
 const initial=turn();initial.items.splice(1,1);
 const before=history.revision("thread-1");
 history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[initial],nextCursor:null},before);
 assert.ok(history.revision("thread-1")>before);
 const removed=storage.database.prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE event_type='remove'").get();
 assert.equal(removed?.n,1);
 const expected=history.read("thread/read",{threadId:"thread-1",includeTurns:true});
 history.rebuild("thread-1");
 assert.deepEqual(history.read("thread/read",{threadId:"thread-1",includeTurns:true}),expected);
 storage.database.prepare("UPDATE conversation_events SET current=0,position=0,preview='{}' WHERE kind IN ('group','item')").run();
 storage.database.prepare("UPDATE conversation_threads SET metadata='{}',history='{}',archived=1").run();
 history.rebuild("thread-1");
 assert.deepEqual(history.read("thread/read",{threadId:"thread-1",includeTurns:true}),expected);
});

test("a known latest group cannot hide a missing middle after live observation",async t=>{
 const {history}=await fixture(t);seed(history,[turn("a")]);
 history.observe("turn/completed",{threadId:"thread-1",turn:turn("d")});
 history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[turn("d")],nextCursor:"unknown-middle"},history.revision("thread-1"));
 const page=history.read("thread/turns/list",{threadId:"thread-1"});
 assert.deepEqual(page.data.map((row:Value)=>row.id),["d"]);
 assert.equal(page.historyCoverage.state,"partial");assert.ok(page.nextCursor);
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1"}),page);
});

test("directory continuation, query isolation and unavailable engines survive owner reopen",async t=>{
 const f=await fixture(t),history=f.history;
 history.importResult("thread/list",{archived:false},{data:[metadata()],nextCursor:"engine-tail",unavailableEngines:["pi"]},history.catalogRevision());
 history.importResult("thread/list",{archived:true},{data:[metadata("archived")],nextCursor:null},history.catalogRevision());
 history.importResult("thread/list",{archived:false,searchTerm:"subset"},{data:[],nextCursor:null},history.catalogRevision());
 const before=history.list({archived:false}),revision=history.catalogRevision(),reopened=await f.reopen();
 assert.deepEqual(reopened.list({archived:false}),before);assert.equal(reopened.catalogRevision(),revision);
 assert.equal(reopened.read("thread/list",{archived:false}).historyCoverage.hasMore,true);
 assert.deepEqual(before.historyCoverage.unavailableEngines,["pi"]);
 assert.equal(reopened.list({archived:true}).historyCoverage.state,"observed");
 assert.throws(()=>reopened.read("thread/list",{archived:true,cursor:before.nextCursor}),InvalidHistoryCursor);
});

test("deletion is a durable tombstone against new snapshots and live notifications",async t=>{
 const f=await fixture(t);seed(f.history);const old=f.history.revision("thread-1");f.history.delete("thread-1");
 const history=await f.reopen(),deleted=history.revision("thread-1");
 history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[turn()]}},old);
 history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[turn()]}},deleted);
 history.observe("thread/started",{thread:metadata()});assert.equal(history.thread("thread-1"),null);
 assert.equal(history.revision("thread-1"),deleted);assert.ok(deleted>old);
});

test("summary imports preserve absent tool members and previously complete bodies",async t=>{
 const {history}=await fixture(t);seed(history);
 history.importResult("thread/turns/list",{threadId:"thread-1",itemsView:"summary"},{data:[{id:"turn-1",itemsView:"summary",items:[{id:"agent-1",type:"agentMessage",text:"sparse"}]}],nextCursor:null},history.revision("thread-1"));
 const full=history.read("thread/turns/list",{threadId:"thread-1"}).data[0];
 assert.equal(full.items.length,3);assert.equal(full.items[1].aggregatedOutput.length,100000);assert.equal(full.items[2].text,"answer");
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1"}).data[0],full);
});

test("legacy index conversion takes a conservative baseline and replay never revives ambiguous old rows",async t=>{
 const {history,storage}=await fixture(t);seed(history);
 storage.database.prepare("UPDATE conversation_events SET current=0 WHERE kind='item' AND type='commandExecution'").run();
 storage.database.prepare("UPDATE conversation_threads SET model_version=0").run();
 const migrated=new ConversationHistory(storage.database,"local-codex");
 const page=migrated.read("thread/turns/list",{threadId:"thread-1"});
 assert.equal(page.historyCoverage.state,"unknown");assert.equal(page.data[0].items.length,2);
 migrated.rebuild("thread-1");assert.deepEqual(migrated.read("thread/turns/list",{threadId:"thread-1"}),page);
});

test("source order and backfill remain identical after full projection reconstruction",async t=>{
 const {history}=await fixture(t);seed(history,[turn("a"),turn("b")]);
 history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[turn("d"),turn("c")],nextCursor:"older"},history.revision("thread-1"));
 const cursor=history.read("thread/turns/list",{threadId:"thread-1"}).nextCursor;
 history.importResult("thread/turns/list",{threadId:"thread-1",cursor:"older"},{data:[turn("b"),turn("a")],nextCursor:null},history.revision("thread-1"));
 const expected=history.read("thread/turns/list",{threadId:"thread-1"});
 assert.deepEqual(expected.data.map((row:Value)=>row.id),["d","c","b","a"]);
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1"}),expected);
 assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1",cursor}).data.map((row:Value)=>row.id),["b","a"]);
});

test("a stored item prefix retains its native continuation instead of reporting EOF",async t=>{
 const {history}=await fixture(t);
 history.importResult("thread/read",{threadId:"thread-1"},{thread:metadata(),initialTurnsPage:{data:[{id:"large",itemsView:"notLoaded",items:[]}],nextCursor:null}},0);
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large"},{data:[{item:{id:"a",type:"agentMessage",text:"first"}}],nextCursor:"native-items"},history.revision("thread-1"));
 const first=history.read("thread/items/list",{threadId:"thread-1",turnId:"large"});
 assert.ok(first.nextCursor);
 const continuation={threadId:"thread-1",turnId:"large",cursor:first.nextCursor};
 assert.throws(()=>history.read("thread/items/list",continuation),HistoryNotStored);
 assert.equal(history.itemSourceCursor("thread-1",continuation),"native-items");
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"large"}),first);
});

test("coverage persistence faults roll back content, both versions, and membership",async t=>{
 const {history,storage}=await fixture(t);seed(history);
 const before=history.read("thread/read",{threadId:"thread-1",includeTurns:true}),revision=history.revision("thread-1"),catalog=history.catalogRevision();
 storage.database.exec("CREATE TRIGGER reject_coverage BEFORE INSERT ON conversation_events WHEN NEW.event_type='coverage' BEGIN SELECT RAISE(ABORT,'coverage fault'); END");
 assert.throws(()=>history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[turn("other")],nextCursor:"older"},revision),/coverage fault/);
 assert.equal(history.catalogRevision(),catalog);assert.equal(history.revision("thread-1"),revision);
 assert.deepEqual(history.read("thread/read",{threadId:"thread-1",includeTurns:true}),before);
});

test("corrupt retained bodies fail recovery without publishing a successful empty projection",async t=>{
 const {history,storage}=await fixture(t);seed(history);
 const row=storage.database.prepare("SELECT hash FROM conversation_events WHERE kind='item' LIMIT 1").get()!;
 storage.database.prepare("UPDATE conversation_payloads SET body='{}' WHERE hash=?").run(row.hash);
 assert.throws(()=>history.rebuild("thread-1"),/integrity/);
 assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1"}),/integrity/);
});

test("a complete native item membership replacement emits removal facts",async t=>{
 const {history}=await fixture(t);seed(history);
 const single={id:"agent-1",type:"agentMessage",text:"answer"};
 const revision=history.revision("thread-1");
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"turn-1"},{data:[{item:single}],nextCursor:null},revision);
 const expected=history.read("thread/turns/list",{threadId:"thread-1"});
 assert.ok(history.revision("thread-1")>revision);assert.deepEqual(expected.data[0].items,[single]);
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/turns/list",{threadId:"thread-1"}),expected);
});

test("background removal-only refresh publishes the committed history version",async t=>{
 const f=await fixture(t);seed(f.history);const history=await f.reopen(),engine=new FakeEngine();
 const changed=turn();changed.items.splice(1,1);
 engine.handle=request=>request.method==="initialize" ? {capabilities:{extensions:{}}} : {thread:metadata(),initialTurnsPage:{data:[changed],nextCursor:null}};
 const transport=new ConversationHistoryTransport(engine,history,undefined,100);t.after(()=>transport.close());
 const notifications:Value[]=[];transport.subscribeMessage(frame=>{const packet=JSON.parse(frame);if(packet.method==="opencraft/history/changed")notifications.push(packet);});
 await transport.connect();await rpc(transport,100,"initialize");
 const old=history.revision("thread-1");await rpc(transport,101,"thread/read",{threadId:"thread-1",watch:true});
 for(let i=0;i<50&&!notifications.length;i++) await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(notifications.length,1);assert.ok(notifications[0]!.params.historyVersion.revision>old);
 assert.equal(history.read("thread/turns/list",{threadId:"thread-1"}).data[0].items.length,2);
});

test("lifecycle and summary updates preserve an unread item continuation, including semantic rebuild",async t=>{
 const {history}=await fixture(t);
 history.importResult("thread/read",{threadId:"thread-1"},{thread:metadata(),initialTurnsPage:{data:[{id:"large",status:"inProgress",itemsView:"notLoaded",items:[]}],nextCursor:null}},0);
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large"},{data:[{item:{id:"a",type:"agentMessage",text:"first"}}],nextCursor:"unread"},history.revision("thread-1"));
 const first=history.read("thread/items/list",{threadId:"thread-1",turnId:"large"});assert.ok(first.nextCursor);
 history.observe("turn/completed",{threadId:"thread-1",turn:{id:"large",status:"completed"}});
 history.importResult("thread/turns/list",{threadId:"thread-1",itemsView:"notLoaded"},{data:[{id:"large",status:"completed",itemsView:"notLoaded",items:[]}],nextCursor:null},history.revision("thread-1"));
 history.rebuild("thread-1");
 const after=history.read("thread/items/list",{threadId:"thread-1",turnId:"large"});assert.equal(after.historyCoverage,"partial");assert.ok(after.nextCursor);
 assert.equal(history.itemSourceCursor("thread-1",{turnId:"large",cursor:after.nextCursor}),"unread");
 assert.ok(history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large",cursor:"unread"},{data:[{item:{id:"b",type:"agentMessage",text:"second"}}],nextCursor:null},history.revision("thread-1")));
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"large"}).data.map((r:Value)=>r.item.id),["a","b"]);
});

async function laneRpc(transport:ConversationHistoryTransport,lane:string,id:number,method:string,params:Value={}) {
 let result:Value|undefined;const remove=transport.subscribeMessage(frame=>{const packet=JSON.parse(frame);if(packet.id===id&&packet.__opencraftClient===lane)result=packet;});
 try{await transport.send(JSON.stringify({id,method,params,__opencraftClient:lane}));return result;}finally{remove();}
}
const eventually=async(predicate:()=>boolean)=>{for(let i=0;i<150&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};

test("live notifications are delivered before durable history work and reads wait for the write tail",async t=>{
 const f=await fixture(t);seed(f.history);const engine=new FakeEngine(),order:string[]=[];
 const original=f.history.observe.bind(f.history);
 (f.history as any).observe=(method:string,params:Value)=>{order.push("db");original(method,params);};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,100);t.after(()=>transport.close());await transport.connect();await engine.connect();
 await laneRpc(transport,"writer",1,"initialize");
 transport.subscribeMessage(frame=>{if(JSON.parse(frame).method==="item/completed")order.push("frame");});
 const revision=f.history.revision("thread-1");
 engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"agent-1",type:"agentMessage",text:"queued"}},__opencraftClient:"writer"});
 assert.deepEqual(order,["frame"]);
 assert.equal(f.history.revision("thread-1"),revision);
 await eventually(()=>order.length===2);
 assert.deepEqual(order,["frame","db"]);
 const reply=await laneRpc(transport,"writer",2,"thread/turns/list",{threadId:"thread-1",itemsView:"full"});
 assert.match(JSON.stringify(reply?.result),/queued/);
});

test("cached peers observe only committed versions, filtered by current watch authorization",async t=>{
 const {history,storage}=await fixture(t);seed(history);const engine=new FakeEngine();engine.handle=request=>{if(request.id!==undefined)throw Error("offline");return null;};
 let allowed=true;
 const transport=new ConversationHistoryTransport(engine,history,undefined,50,undefined,()=>allowed);t.after(()=>transport.close());await transport.connect();
 await laneRpc(transport,"reader",1,"initialize");await laneRpc(transport,"writer",2,"initialize");
 await laneRpc(transport,"reader",3,"thread/read",{threadId:"thread-1",watch:true});
 const notifications:Value[]=[];transport.subscribeMessage(frame=>{const p=JSON.parse(frame);if(p.method==="opencraft/history/changed")notifications.push(p);});
 const update={threadId:"thread-1",turnId:"turn-1",item:{id:"agent-1",type:"agentMessage",text:"updated"}};
 engine.emit({method:"item/completed",params:update,__opencraftClient:"writer"});
 await eventually(()=>notifications.length===1);assert.equal(notifications[0].__opencraftClient,"reader");assert.equal(notifications[0].params.historyVersion.revision,history.revision("thread-1"));
 engine.emit({method:"item/completed",params:update,__opencraftClient:"writer"});await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications.length,1);
 storage.database.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 engine.emit({method:"item/completed",params:{...update,item:{...update.item,text:"unsaved"}},__opencraftClient:"writer"});await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications.length,1);
 storage.database.exec("DROP TRIGGER fail_commit");
 allowed=false;history.observe("item/completed",{...update,item:{...update.item,text:"revoked"}});await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications.length,1);
 allowed=true;await transport.send(JSON.stringify({method:"runtime/client/disconnect",__opencraftClient:"reader"}));history.observe("item/completed",{...update,item:{...update.item,text:"after disconnect"}});assert.equal(notifications.length,1);
});

test("a live save failure is repaired through authorized read-only source pages and survives reopen",async t=>{
 const f=await fixture(t);seed(f.history);const engine=new FakeEngine(),diagnostics:string[]=[];
 const latest=turn();latest.items[2]={id:"agent-1",type:"agentMessage",text:"repaired"} as any;
 engine.handle=request=>request.method==="initialize"?{capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata()}:{data:[latest],nextCursor:null};
 const transport=new ConversationHistoryTransport(engine,f.history,event=>diagnostics.push(event),100);t.after(()=>transport.close());await transport.connect();await laneRpc(transport,"writer",1,"initialize");await engine.connect();
 const messages:Value[]=[];transport.subscribeMessage(frame=>messages.push(JSON.parse(frame)));
 f.storage.database.exec("CREATE TRIGGER fail_live BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-1",item:latest.items[2]},__opencraftClient:"writer"});
 assert.ok(messages.some(p=>p.method==="item/completed"));assert.match(JSON.stringify(f.history.read("thread/turns/list",{threadId:"thread-1"})),/answer/);
 await eventually(()=>diagnostics.includes("history-repair-unavailable"));
 f.storage.database.exec("DROP TRIGGER fail_live");
 await eventually(()=>diagnostics.includes("history-repair-completed"));
 assert.ok(engine.sends.some(r=>r.method==="thread/turns/list"));assert.ok(engine.sends.every(r=>["initialize","initialized","thread/read","thread/turns/list"].includes(r.method)));
 await transport.close();const reopened=await f.reopen();assert.match(JSON.stringify(reopened.read("thread/turns/list",{threadId:"thread-1"})),/repaired/);
});

test("revocation fences a late repair reply before import and close releases pending repair requests",async t=>{
 const f=await fixture(t);seed(f.history);const engine=new FakeEngine();let allowed=true;let waiting:Value|undefined;
 engine.handle=request=>request.method==="initialize"?{capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata()}:request.method==="thread/turns/list"?(waiting=request,null):{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,100,undefined,()=>allowed);t.after(()=>transport.close());await transport.connect();await laneRpc(transport,"writer",1,"initialize");await engine.connect();
 f.storage.database.exec("CREATE TRIGGER fail_late BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"agent-1",type:"agentMessage",text:"not committed"}},__opencraftClient:"writer"});await new Promise(resolve=>setImmediate(resolve));f.storage.database.exec("DROP TRIGGER fail_late");
 await eventually(()=>!!waiting);const before=f.history.revision("thread-1");allowed=false;
 engine.emit({id:waiting!.id,__opencraftClient:"writer",result:{data:[turn("turn-1","late private output")],nextCursor:null}});
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.history.revision("thread-1"),before);assert.doesNotMatch(JSON.stringify(f.history.read("thread/turns/list",{threadId:"thread-1"})),/late private/);
 await transport.close();assert.equal(engine.messages.size,0);
});

test("a newer failed observation fences an already running repair and retries the latest source",async t=>{
 const f=await fixture(t);seed(f.history);const engine=new FakeEngine(),held:Value[]=[];const diagnostics:string[]=[];
 engine.handle=request=>request.method==="initialize"?{capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata()}:request.method==="thread/turns/list"?(held.push(request),null):{};
 const transport=new ConversationHistoryTransport(engine,f.history,event=>diagnostics.push(event),1000);t.after(()=>transport.close());await transport.connect();await laneRpc(transport,"writer",1,"initialize");await engine.connect();
 f.storage.database.exec("CREATE TRIGGER fail_generation BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 const emit=(text:string)=>engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"agent-1",type:"agentMessage",text}},__opencraftClient:"writer"});
 emit("older unsaved");await eventually(()=>held.length===1);const revision=f.history.revision("thread-1");
 emit("newer unsaved");f.storage.database.exec("DROP TRIGGER fail_generation");
 const reply=(request:Value,text:string)=>{const group=turn();group.items[2]={id:"agent-1",type:"agentMessage",text} as any;engine.emit({id:request.id,__opencraftClient:"writer",result:{data:[group],nextCursor:null}});};
 reply(held[0],"obsolete source reply");assert.equal(f.history.revision("thread-1"),revision);
 await eventually(()=>held.length===2);reply(held[1],"latest source reply");await eventually(()=>diagnostics.includes("history-repair-completed"));
 const saved=JSON.stringify(f.history.read("thread/turns/list",{threadId:"thread-1"}));assert.match(saved,/latest source reply/);assert.doesNotMatch(saved,/obsolete source reply/);
});

for (const persisted of [false,true]) test(`native protocol continuity with persisted=${persisted}: old pages, streaming body and bounded reads`,{timeout:5000},async t=>{
 const {createAppServerWorkbenchRuntime}=await import("@opencraft/workbench-runtime");
 const f=await fixture(t),engine=new FakeEngine();
 const rows=Array.from({length:8},(_,index)=>({id:`group-${index}`,status:index===7?"inProgress":"completed",itemsView:"full",items:[{id:`agent-${index}`,type:"agentMessage",text:`answer-${index}`}]}));
 seed(f.history,rows);
 engine.handle=request=>{
  if(request.method==="initialize")return {userAgent:"synthetic",capabilities:{extensions:{"opencraft/read-history":{version:1,initialTurnsPage:true,itemDetails:true}}}};
  if(request.method==="thread/read")return {thread:metadata(),initialTurnsPage:{data:[rows[7]],nextCursor:"7"}};
  if(request.method==="thread/turns/list") {const end=Number(request.params.cursor??8),start=Math.max(0,end-(request.params.limit??5));return {data:rows.slice(start,end).reverse(),nextCursor:start?String(start):null};}
  return {};
 };
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,100):engine;
 const frames:Value[]=[];transport.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
 const runtime=createAppServerWorkbenchRuntime({hostId:`continuity-${persisted}`,transport,autoReconnect:false,requestTimeoutMs:500,onRecoveryEvent(){}});
 t.after(()=>runtime.dispose());await runtime.connect();const lease=await runtime.acquireThread("thread-1");lease.setRecoveryVisibility(true);
 await eventually(()=>lease.getSnapshot().authoritative);await lease.loadOlder();
 await eventually(()=>JSON.stringify(lease.getSnapshot().timeline).includes("answer-6"));
 const cursor=lease.getSnapshot().history.cursor,reads=engine.sends.filter(r=>r.method==="thread/read").length;
 for(let index=0;index<15;index++) {
  engine.emit({method:"item/agentMessage/delta",params:{threadId:"thread-1",turnId:"group-7",itemId:"agent-7",delta:` token-${index}`}});
  engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"group-7",item:{id:`tool-${index}`,type:"commandExecution",status:"completed",aggregatedOutput:`result-${index}`}}});
 }
 await new Promise(resolve=>setTimeout(resolve,100));
 const snapshot=JSON.stringify(lease.getSnapshot().timeline);
 assert.match(snapshot,/answer-6/);assert.match(snapshot,/answer-7 token-0 token-1/);assert.match(snapshot,/token-14/);
 assert.equal(lease.getSnapshot().history.cursor,cursor);assert.equal(lease.getSnapshot().phase,"live");
 assert.equal(engine.sends.filter(r=>r.method==="thread/read").length,reads);
 assert.equal(frames.filter(r=>r.method==="opencraft/thread-catalog/changed").length,0);
 lease.release();
});

test("committed sparse facts preserve live bodies and loaded pages, remove explicit members and ignore unmounted backfill",async()=>{
 const {applyCommittedHistory}=await import("../../packages/appserver-session/src/committed-history.js");
 const old={id:"old",items:[{id:"a",type:"agentMessage",text:"old loaded answer"}]};
 const live={id:"live",status:"inProgress",items:[{id:"b",type:"agentMessage",text:"already seen tokens"},{id:"obsolete",type:"commandExecution"}]};
 const update={turns:[{turn:{id:"backfill",items:[{id:"x"}]},completedItemIds:[],latest:false},{turn:{id:"live",status:"inProgress",items:[{id:"b",text:"stale source"},{id:"c",type:"commandExecution",status:"completed"}]},completedItemIds:["c"],latest:true}],removedTurnIds:[],removedItems:[{turnId:"live",itemId:"obsolete"}]};
 const applied=applyCommittedHistory([old,live],update,new Set([JSON.stringify(["live","b"])]));
 assert.equal(applied[0],old);assert.deepEqual(applied.map(t=>t.id),["old","live"]);
 assert.equal(applied[1].items?.[0]?.text,"already seen tokens");assert.deepEqual(applied[1].items?.map(i=>i.id),["b","c"]);
 const final=applyCommittedHistory(applied,{...update,turns:[{turn:{id:"live",items:[{id:"b",text:"final body"}]},completedItemIds:["b"],latest:true}]},new Set([JSON.stringify(["live","b"])]));
 assert.equal(final[1].items?.[0]?.text,"final body");
});

test("a metadata-only stored read never hydrates a conversation body",async t=>{
 const {history,storage}=await fixture(t);seed(history);
 storage.database.exec("UPDATE conversation_payloads SET body='{}' WHERE hash IN (SELECT hash FROM conversation_events WHERE kind='item')");
 const result=history.read("thread/read",{threadId:"thread-1",includeTurns:false});
 assert.deepEqual(result.thread.turns,[]);assert.equal(result.initialTurnsPage,undefined);
});


test("streaming protection is scoped to Turn as well as Item identity",async()=>{
 const {applyCommittedHistory}=await import("../../packages/appserver-session/src/committed-history.js");
 const current=[{id:"old",items:[{id:"same",text:"older"}]},{id:"live",items:[{id:"same",text:"live tokens"}]}];
 const update={turns:current.map(turn=>({turn:{id:turn.id,items:[{id:"same",text:"source snapshot"}]},completedItemIds:[],latest:turn.id==="live"})),removedTurnIds:[],removedItems:[]};
 const result=applyCommittedHistory(current,update,new Set([JSON.stringify(["live","same"])]));
 assert.equal(result[0].items?.[0]?.text,"source snapshot");assert.equal(result[1].items?.[0]?.text,"live tokens");
});


test("cached metadata and deletion updates preserve history and use the existing unavailable lifecycle",{timeout:5000},async t=>{
 const {createAppServerWorkbenchRuntime}=await import("@opencraft/workbench-runtime");
 const {history}=await fixture(t);seed(history,[turn("older"),turn("latest")]);
 const engine=new FakeEngine();engine.handle=()=>{throw Error("offline");};
 const transport=new ConversationHistoryTransport(engine,history,undefined,50);
 const packets:Value[]=[];transport.subscribeMessage(frame=>packets.push(JSON.parse(frame)));
 const runtime=createAppServerWorkbenchRuntime({hostId:"metadata-reader",transport,autoReconnect:false,requestTimeoutMs:500,onRecoveryEvent(){}});t.after(()=>runtime.dispose());
 await runtime.connect();const lease=await runtime.acquireThread("thread-1");lease.setRecoveryVisibility(true);
 await eventually(()=>lease.getSnapshot().authoritative);await lease.loadOlder();
 await eventually(()=>lease.getSnapshot().history.hasOlder===false);
 const before=JSON.stringify(lease.getSnapshot().timeline),count=engine.sends.length;
 history.metadata({...metadata(),name:"Renamed in another window"});
 await eventually(()=>lease.getSnapshot().title==="Renamed in another window");
 assert.equal(lease.getSnapshot().history.hasOlder,false);assert.match(JSON.stringify(lease.getSnapshot().timeline),/older/);
 assert.equal(engine.sends.length,count);assert.ok(before.includes("older"));
 history.delete("thread-1");await eventually(()=>packets.some(packet=>packet.method==="thread/deleted"));
 assert.equal(history.thread("thread-1"),null);lease.release();
});

for(const persisted of [false,true]) test(`directory continuation stays in its native connection with persisted=${persisted}`,async t=>{
 const {history}=await fixture(t),engine=new FakeEngine();
 const recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}],older={...metadata("older"),updatedAt:10};
 history.importResult("initialize",{},{userAgent:"synthetic",capabilities:{extensions:{}}},0);
 history.importResult("thread/list",{},{data:recent,nextCursor:"retired-session-cursor"},history.catalogRevision());
 const valid=new Set<string>();let cursorId=0;
 engine.handle=request=>{
  if(request.method==="initialize")return {userAgent:"synthetic",capabilities:{extensions:{}}};
  if(request.method!=="thread/list")return {};
  const cursor=request.params.cursor;
  if(!cursor) {const next=`session:${request.__opencraftClient??""}:${++cursorId}`;valid.add(next);return {data:recent,nextCursor:next};}
  if(!valid.delete(cursor))throw Object.assign(Error("Directory cursor expired; restart the list"),{code:-32080,data:{retryable:true}});
  return {data:[older],nextCursor:null};
 };
 const transport=persisted?new ConversationHistoryTransport(engine,history,undefined,100):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/list",{limit:2});assert.equal(first?.error,undefined);assert.ok(first?.result.nextCursor);
 const second=await rpc(transport,3,"thread/list",{limit:2,cursor:first!.result.nextCursor});
 assert.equal(second?.error,undefined,JSON.stringify(second?.error));assert.deepEqual(second?.result.data.map((row:Value)=>row.id),["older"]);
 assert.equal(engine.sends.some(request=>request.params?.cursor==="retired-session-cursor" || String(request.params?.cursor).startsWith("conversation-directory:")),false);
});

test("rotating source continuation alone cannot invalidate the cached directory",async t=>{
 const {history}=await fixture(t);const rows=[metadata()];
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);
 history.importResult("thread/list",{},{data:rows,nextCursor:"old-source-cursor"},0);
 const engine=new FakeEngine(),transport=new ConversationHistoryTransport(engine,history,undefined,50);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const notifications:Value[]=[];transport.subscribeMessage(frame=>{const packet=JSON.parse(frame);if(packet.method==="opencraft/thread-catalog/changed")notifications.push(packet);});
 history.importResult("thread/list",{},{data:rows,nextCursor:"new-source-cursor"},history.catalogRevision());
 assert.equal(notifications.length,0);
});

test("a cached directory continuation is never a native background refresh request",async t=>{
 const {history}=await fixture(t);history.importResult("initialize",{},{capabilities:{extensions:{}}},0);
 const rows=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}];
 history.importResult("thread/list",{},{data:rows,nextCursor:"source-next"},0);
 const engine=new FakeEngine();engine.handle=request=>request.method==="initialize"?{capabilities:{extensions:{}}}:request.method==="thread/list"?{data:rows,nextCursor:"source-next"}:{};
 const transport=new ConversationHistoryTransport(engine,history,undefined,50);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");await rpc(transport,2,"model/list");
 const first=await rpc(transport,3,"thread/list",{limit:1});await new Promise(resolve=>setTimeout(resolve,10));
 await rpc(transport,4,"thread/list",{limit:1,cursor:first!.result.nextCursor});await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(engine.sends.some(request=>String(request.params?.cursor).startsWith("conversation-directory:")),false);
});

test("an expired current native directory cursor restarts once and still returns the requested older range",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine();
 const recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}],older={...metadata("older"),updatedAt:10};
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);history.importResult("thread/list",{},{data:recent,nextCursor:"retired"},0);
 let cursorId=0;const valid=new Set<string>();
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};if(request.method!=="thread/list")return {};
  if(!request.params.cursor){const next=`current-${++cursorId}`;valid.add(next);return {data:recent,nextCursor:next};}
  if(!valid.delete(request.params.cursor))throw Object.assign(Error("Directory cursor expired; restart the list"),{code:-32080,data:{retryable:true}});
  return {data:[older],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,100);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");await rpc(transport,2,"model/list");
 const first=await rpc(transport,3,"thread/list",{limit:2});await eventually(()=>cursorId===1);await new Promise(resolve=>setTimeout(resolve,10));valid.clear();
 const page=await rpc(transport,4,"thread/list",{limit:2,cursor:first!.result.nextCursor});
 assert.equal(page?.error,undefined);assert.deepEqual(page?.result.data.map((row:Value)=>row.id),["older"]);assert.equal(cursorId,2);
 assert.equal(engine.sends.filter(request=>request.method==="thread/list"&&request.params.cursor==="current-1").length,1);
});

test("concurrent cached directory gaps share connection progress without consuming a cursor twice",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine(),recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}];
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);history.importResult("thread/list",{},{data:recent,nextCursor:"retired"},0);
 let held:Value|undefined,consumed=0;
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};if(request.method!=="thread/list")return {};
  if(!request.params.cursor){held=request;return null;}
  assert.equal(request.params.cursor,"owned-once");assert.equal(++consumed,1);
  return {data:[{...metadata("older"),updatedAt:10}],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,200);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/list",{limit:2}),params={limit:2,cursor:first!.result.nextCursor};
 const left=rpc(transport,3,"thread/list",params),right=rpc(transport,4,"thread/list",params);await eventually(()=>!!held);
 engine.emit({id:held!.id,result:{data:recent,nextCursor:"owned-once"}});
 const pages=await Promise.all([left,right]);for(const page of pages){assert.equal(page?.error,undefined);assert.deepEqual(page?.result.data.map((row:Value)=>row.id),["older"]);}
 assert.equal(consumed,1);assert.equal(engine.sends.filter(request=>request.method==="thread/list"&&!request.params.cursor).length,1);
});

test("directory pages retain newer metadata when their source snapshot is stale",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine(),recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}],older={...metadata("older"),updatedAt:10};
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);history.importResult("thread/list",{},{data:recent,nextCursor:"retired"},0);
 let held:Value|undefined,reads=0;
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};if(request.method!=="thread/list")return {};
  assert.equal(request.params.cursor,null);if(++reads===1){held=request;return null;}
  return {data:[...recent,older],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,200);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/list",{limit:2});const pending=rpc(transport,3,"thread/list",{limit:2,cursor:first!.result.nextCursor});await eventually(()=>!!held);
 const stale=structuredClone(recent);Object.assign(recent[0],{name:"newer metadata"});history.metadata(recent[0]);
 engine.emit({id:held!.id,result:{data:[...stale,older],nextCursor:null}});
 const reply=await pending;assert.equal(reply?.error,undefined);assert.deepEqual(reply?.result.data.map((row:Value)=>row.id),["older"]);assert.equal(history.thread("newest")?.name,"newer metadata");assert.equal(reads,1);
});

test("directory import is independent of unrelated live body commits",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine(),recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}],older={...metadata("older"),updatedAt:10};
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);history.importResult("thread/list",{},{data:recent,nextCursor:"retired"},0);
 let held:Value|undefined,reads=0;
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};if(request.method!=="thread/list")return {};
  if(++reads===1){held=request;return null;}return {data:[...recent,older],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,200);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/list",{limit:2});const pending=rpc(transport,3,"thread/list",{limit:2,cursor:first!.result.nextCursor});await eventually(()=>!!held);
 history.observe("item/completed",{threadId:"newest",turnId:"live",item:{id:"tool",type:"commandExecution",status:"completed"}});
 engine.emit({id:held!.id,result:{data:[...recent,older],nextCursor:null}});
 const reply=await pending;assert.equal(reply?.error,undefined);assert.deepEqual(reply?.result.data.map((row:Value)=>row.id),["older"]);assert.equal(reads,1);
});

test("directory continuation retains the scan's original metadata fence across pages",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine();
 const recent=[{...metadata("newest"),updatedAt:30},{...metadata("middle"),updatedAt:20}],older={...metadata("older"),updatedAt:10,name:"old name"};
 history.importResult("initialize",{},{capabilities:{extensions:{}}},0);history.importResult("thread/list",{},{data:[...recent,older],nextCursor:"retired"},0);
 let firstReads=0;
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};if(request.method!=="thread/list")return {};
  if(!request.params.cursor){firstReads++;return {data:recent,nextCursor:"scan-next"};}
  assert.equal(request.params.cursor,"scan-next");return {data:[older,{...metadata("deepest"),updatedAt:0}],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,history,undefined,100);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");await rpc(transport,2,"model/list");
 const first=await rpc(transport,3,"thread/list",{limit:3});await eventually(()=>firstReads===1);await new Promise(resolve=>setTimeout(resolve,10));
 history.metadata({...older,name:"newer local name"});history.observe("thread/archived",{threadId:"older"});
 const page=await rpc(transport,4,"thread/list",{limit:3,cursor:first!.result.nextCursor});
 assert.equal(page?.error,undefined);assert.deepEqual(page?.result.data.map((row:Value)=>row.id),["deepest"]);
 assert.equal(history.thread("older")?.name,"newer local name");assert.ok(history.list({archived:true}).data.some((row:Value)=>row.id==="older"));assert.equal(firstReads,1);
});

test("full snapshots that insert items preserve existing group, item and detail cursors", async t => {
 const {history}=await fixture(t);seed(history,[turn("old"),turn("latest")]);
 const page=history.read("thread/turns/list",{threadId:"thread-1",limit:1,itemsView:"presentation"});
 const detail=page.data[0].items[1].historyDetail.cursor;
 const items=history.read("thread/items/list",{threadId:"thread-1",turnId:"latest",limit:1});
 const updated=turn("latest");
 updated.items.unshift({id:"prefix",type:"agentMessage",text:"backfilled"});
 updated.items.splice(3,0,{id:"inserted",type:"agentMessage",text:"inserted"});
 updated.items.push({id:"tail",type:"agentMessage",text:"new"});
 history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[turn("old"),updated]}},history.revision("thread-1"));
 assert.equal(history.read("thread/turns/list",{threadId:"thread-1",cursor:page.nextCursor,limit:1}).data[0].id,"old");
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"latest",cursor:items.nextCursor}).data.map((r:Value)=>r.item.id),["tool-1","inserted","agent-1","tail"]);
 assert.equal(history.read("thread/turns/list",{threadId:"thread-1",cursor:detail,detailItemId:"tool-1",itemsView:"full"}).data[0].items[0].aggregatedOutput.length,100000);
 history.rebuild("thread-1");
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"latest",cursor:items.nextCursor}).data.map((r:Value)=>r.item.id),["tool-1","inserted","agent-1","tail"]);
});

test("full snapshots that reorder surviving items still revoke old cursors", async t => {
 const {history}=await fixture(t);seed(history);
 const page=history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",limit:1});
 const updated=turn();updated.items.reverse();
 history.importResult("thread/read",{threadId:"thread-1",includeTurns:true},{thread:{...metadata(),turns:[updated]}},history.revision("thread-1"));
 assert.throws(()=>history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",cursor:page.nextCursor}),InvalidHistoryCursor);
});

test("a retained item detail stays available offline while its group has an unread source tail", async t => {
 const f=await fixture(t);seed(f.history);
 const page=f.history.read("thread/turns/list",{threadId:"thread-1",itemsView:"presentation"});
 const cursor=page.data[0].items[1].historyDetail.cursor;
 f.history.importResult("thread/items/list",{threadId:"thread-1",turnId:"turn-1"},{data:turn().items.map(item=>({item})),nextCursor:"unread-tail"},f.history.revision("thread-1"));
 const history=await f.reopen();
 assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1",itemsView:"full"}),HistoryNotStored);
 const engine=new FakeEngine();engine.handle=()=>{throw Error("offline");};
 const transport=new ConversationHistoryTransport(engine,history,undefined,100);t.after(()=>transport.close());await transport.connect();
 await rpc(transport,901,"initialize");const before=engine.sends.length;
 const result=await rpc(transport,902,"thread/turns/list",{threadId:"thread-1",cursor,detailItemId:"tool-1",itemsView:"full",limit:1});
 assert.ok(result?.result,JSON.stringify(result));
 assert.equal(result.result.data[0].items.length,1);assert.equal(result.result.data[0].items[0].aggregatedOutput.length,100000);
 assert.equal(engine.sends.length,before);
 assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1",cursor,detailItemId:"missing",itemsView:"full"}),HistoryNotStored);
});

test("full lifecycle backfill keeps stable item cursors while real reorder revokes them",async t=>{
 const {history}=await fixture(t);seed(history);
 const first=history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",limit:1});
 const updated=turn();updated.items.unshift({id:"backfill",type:"agentMessage",text:"old missing item"});
 history.observe("turn/completed",{threadId:"thread-1",turn:updated});
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",cursor:first.nextCursor}).data.map((r:Value)=>r.item.id),["tool-1","agent-1"]);
 const latest=history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",limit:1});
 updated.items.reverse();history.observe("turn/completed",{threadId:"thread-1",turn:updated});
 assert.throws(()=>history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",cursor:latest.nextCursor}),InvalidHistoryCursor);
});

for(const direction of ["asc","desc"]) test(`partial ${direction} item refresh preserves overlapping stored order and cursors`,async t=>{
 const {history}=await fixture(t);seed(history);
 const before=history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",limit:1});
 const source=direction==="asc"?turn().items:[...turn().items].reverse();
 for(let index=0;index<source.length;index++) {
  assert.ok(history.importResult("thread/items/list",{threadId:"thread-1",turnId:"turn-1",sortDirection:direction,cursor:index?`part-${index}`:null},{data:[{item:source[index]}],nextCursor:index===source.length-1?null:`part-${index+1}`},history.revision("thread-1")));
  assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1"}).data.map((r:Value)=>r.item.id),["user-1","tool-1","agent-1"]);
 }
 assert.equal(history.read("thread/items/list",{threadId:"thread-1",turnId:"turn-1",cursor:before.nextCursor}).data[0].item.id,"tool-1");
});

for(const direction of ["asc","desc"]) test(`partial ${direction} item backfill precedes later live observations at its scan frontier`,async t=>{
 const {history}=await fixture(t);
 history.importResult("thread/read",{threadId:"thread-1"},{thread:metadata(),initialTurnsPage:{data:[{id:"large",itemsView:"notLoaded",items:[]}],nextCursor:null}},0);
 const item=(id:string)=>({id,type:"agentMessage",text:id});
 history.observe("item/completed",{threadId:"thread-1",turnId:"large",item:item(direction==="asc"?"z":"a")});
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large",sortDirection:direction},{data:[{item:item(direction==="asc"?"a":"z")}],nextCursor:"rest"},history.revision("thread-1"));
 const first=history.read("thread/items/list",{threadId:"thread-1",turnId:"large",limit:1});
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"large",sortDirection:direction,cursor:"rest"},{data:[{item:item("m")}],nextCursor:null},history.revision("thread-1"));
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"large"}).data.map((r:Value)=>r.item.id),["a","m","z"]);
 assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"large",cursor:first.nextCursor}).data.map((r:Value)=>r.item.id),["m","z"]);
 history.rebuild("thread-1");assert.deepEqual(history.read("thread/items/list",{threadId:"thread-1",turnId:"large"}).data.map((r:Value)=>r.item.id),["a","m","z"]);
});

for(const persisted of [false,true]) test(`native/persisted protocol comparison keeps an item continuation through full lifecycle backfill: ${persisted}`,async t=>{
 const f=await fixture(t);seed(f.history);
 const engine=new FakeEngine();let rows=turn().items;
 engine.handle=request=>{
  if(request.method==="initialize")return {capabilities:{extensions:{}}};
  if(request.method==="thread/items/list") {
   const start=request.params.cursor?rows.findIndex(item=>`native:${item.id}`===request.params.cursor)+1:0;
   const page=rows.slice(start,start+(request.params.limit??10));
   return {data:page.map(item=>({turnId:"turn-1",item})),nextCursor:start+page.length<rows.length?`native:${page.at(-1)!.id}`:null};
  }
  return {};
 };
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,100):engine;
 t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");await engine.connect();
 const first=await rpc(transport,2,"thread/items/list",{threadId:"thread-1",turnId:"turn-1",limit:1});
 assert.ok(first?.result.nextCursor);
 rows=[{id:"prefix",type:"agentMessage",text:"backfilled"},...rows];
 engine.emit({method:"turn/completed",params:{threadId:"thread-1",turn:{...turn(),items:rows}}});
 const next=await rpc(transport,3,"thread/items/list",{threadId:"thread-1",turnId:"turn-1",cursor:first.result.nextCursor});
 assert.ok(next?.result,JSON.stringify(next));assert.deepEqual(next.result.data.map((r:Value)=>r.item.id),["tool-1","agent-1"]);
});

for (const persisted of [false, true]) test(`pagination reaches native EOF while coverage stays honest; persisted=${persisted}`, async t => {
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:25},(_,i)=>turn(`turn-${i}`,"small"));
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}
  :request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:all.slice(-2).reverse(),nextCursor:"native-2"}}
  :request.method==="thread/turns/list"?(()=>{const start=Number(String(request.params.cursor??"native-0").slice(7)),size=request.params.limit??10;return{data:all.slice(Math.max(0,25-start-size),25-start).reverse(),nextCursor:start+size>=25?null:`native-${start+size}`};})():{};
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:2,itemsView:"presentation"}});
 let cursor=first!.result.initialTurnsPage.nextCursor;const seen=first!.result.initialTurnsPage.data.map((row:Value)=>row.id);
 for(let i=0;i<3&&cursor;i++){const page=await rpc(transport,3+i,"thread/turns/list",{threadId:"thread-1",cursor,limit:10,itemsView:"presentation",sortDirection:"desc"});assert.equal(page?.error,undefined,JSON.stringify(page?.error));seen.push(...page!.result.data.map((row:Value)=>row.id));cursor=page!.result.nextCursor;}
 assert.deepEqual(seen,all.slice().reverse().map(row=>row.id));assert.equal(cursor,null,"native EOF must end paging even without a stable coverage proof");
 if(persisted){const page=f.history.read("thread/turns/list",{threadId:"thread-1",limit:100});assert.equal(page.historyCoverage.state,"partial");assert.equal(page.nextCursor,null);}
});

for (const persisted of [false, true]) test(`older page still advances after another client refreshes the source head; persisted=${persisted}`, async t=>{
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:45},(_,i)=>turn(`turn-${i}`,"small"));
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}
  :request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:all.slice(-(request.params.initialTurnsPage?.limit??2)).reverse(),nextCursor:`native-${request.params.initialTurnsPage?.limit??2}`}}
  :request.method==="thread/turns/list"?(()=>{const start=Number(String(request.params.cursor??"native-0").slice(7)),size=request.params.limit??10;return{data:all.slice(Math.max(0,45-start-size),45-start).reverse(),nextCursor:start+size>=45?null:`native-${start+size}`};})():{};
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:2,itemsView:"presentation"}});
 let cursor=first!.result.initialTurnsPage.nextCursor;
 for(let i=0;i<2;i++){const page=await rpc(transport,3+i,"thread/turns/list",{threadId:"thread-1",cursor,limit:10,itemsView:"presentation",sortDirection:"desc"});assert.equal(page?.error,undefined);cursor=page!.result.nextCursor;}
 // A separate authorized watch imports its newest-only source segment.
 if(persisted)f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:1}},{thread:metadata(),initialTurnsPage:{data:[all.at(-1)],nextCursor:"native-1"}},f.history.revision("thread-1"));
 const page=await rpc(transport,5,"thread/turns/list",{threadId:"thread-1",cursor,limit:10,itemsView:"presentation",sortDirection:"desc"});assert.equal(page?.error,undefined,JSON.stringify(page?.error));
 assert.deepEqual(page!.result.data.map((row:Value)=>row.id),all.slice(13,23).reverse().map(row=>row.id),"paging must reach the requested older anchor instead of replaying recent rows");
 if(persisted)assert.ok(page!.result.nextCursor.startsWith("conversation:"),"platform paging must retain a platform cursor");
});

test("bounded older-range recovery retains source progress for the next attempt",async t=>{
 const f=await fixture(t),all=Array.from({length:100},(_,i)=>turn(`turn-${i}`,"small"));
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[11],all[10]],nextCursor:"old-source"}},0);
 const cursor=f.history.read("thread/turns/list",{threadId:"thread-1"}).nextCursor;
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[99]],nextCursor:"foreign-source"}},f.history.revision("thread-1"));
 const engine=new FakeEngine();engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:request.method==="thread/turns/list"?(()=>{
  const start=request.params.cursor==null?0:Number(String(request.params.cursor).slice(7));assert.ok(Number.isFinite(start),"a foreign native cursor must not be replayed");
  return{data:all.slice(Math.max(0,100-start-10),100-start).reverse(),nextCursor:start+10>=100?null:`native-${start+10}`};})():{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const request={threadId:"thread-1",cursor,limit:10,itemsView:"presentation"};const first=await rpc(transport,2,"thread/turns/list",request);assert.equal(first?.error?.code,-32074);
 const reads=()=>engine.sends.filter(request=>request.method==="thread/turns/list");assert.equal(reads().length,8);
 const second=await rpc(transport,3,"thread/turns/list",request);assert.equal(second?.error,undefined,JSON.stringify(second?.error));assert.deepEqual(second!.result.data.map((row:Value)=>row.id),all.slice(0,10).reverse().map(row=>row.id));
 assert.equal(reads()[8].params.cursor,"native-80");assert.equal(second!.result.nextCursor,null);
});

test("older-range recovery keeps native header-only Item hydration available",async t=>{
 const f=await fixture(t),engine=new FakeEngine();
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:[turn("recent","small")],nextCursor:"native-1"}}
  :request.method==="thread/turns/list"?{data:[{id:"older",status:"completed",itemsView:"notLoaded",items:[]}],nextCursor:null}
  :request.method==="thread/items/list"?{data:[{turnId:"older",item:{id:"older-answer",type:"agentMessage",text:"Full older answer"}}],nextCursor:null}:{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const head=await rpc(transport,2,"thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:1}});
 const older=await rpc(transport,3,"thread/turns/list",{threadId:"thread-1",cursor:head!.result.initialTurnsPage.nextCursor,itemsView:"presentation"});assert.equal(older?.error,undefined);assert.equal(older!.result.data[0].itemsView,"notLoaded");
 const items=await rpc(transport,4,"thread/items/list",{threadId:"thread-1",turnId:"older"});assert.equal(items?.error,undefined);assert.equal(items!.result.data[0].item.text,"Full older answer");
});

test("a stale platform end cursor settles locally after an observed EOF and reopen",async t=>{
 const f=await fixture(t),h=f.history;
 h.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[turn("new","small")],nextCursor:"older"}},0);
 const first=h.read("thread/turns/list",{threadId:"thread-1",limit:1});
 h.importResult("thread/turns/list",{threadId:"thread-1",cursor:"older"},{data:[],nextCursor:null},h.revision("thread-1"));
 const history=await f.reopen(),end=history.read("thread/turns/list",{threadId:"thread-1",cursor:first.nextCursor});assert.deepEqual(end.data,[]);assert.equal(end.nextCursor,null);assert.equal(end.historyCoverage.state,"partial");
});

test("concurrent older-range reads share scan progress and never replay recent rows",async t=>{
 const f=await fixture(t),all=Array.from({length:45},(_,i)=>turn(`turn-${i}`,"small"));
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[23]],nextCursor:"old"}},0);
 const cursor=f.history.read("thread/turns/list",{threadId:"thread-1"}).nextCursor;
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[44]],nextCursor:"foreign"}},f.history.revision("thread-1"));
 const engine=new FakeEngine();engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:request.method==="thread/turns/list"?(()=>{const n=request.params.cursor==null?0:Number(String(request.params.cursor).slice(7));return{data:all.slice(Math.max(0,45-n-10),45-n).reverse(),nextCursor:n+10>=45?null:`native-${n+10}`};})():{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const params={threadId:"thread-1",cursor,limit:10,itemsView:"presentation"};
 const replies=await Promise.all([rpc(transport,2,"thread/turns/list",params),rpc(transport,3,"thread/turns/list",params)]);
 for(const reply of replies){assert.equal(reply?.error,undefined);assert.deepEqual(reply!.result.data.map((row:Value)=>row.id),all.slice(13,23).reverse().map(row=>row.id));}
 assert.equal(engine.sends.filter(row=>row.method==="thread/turns/list"&&row.params.cursor==null).length,1);
});

test("an expired older-range source cursor restarts once without changing the platform anchor",async t=>{
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:25},(_,i)=>turn(`turn-${i}`,"small"));let expired=false;
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:all.slice(-2).reverse(),nextCursor:"native-2"}}:request.method==="thread/turns/list"?(()=>{
  if(request.params.cursor==="native-2"&&!expired){expired=true;throw Object.assign(Error("Source cursor expired"),{code:-32080,data:{retryable:true}});}
  const n=request.params.cursor==null?0:Number(String(request.params.cursor).slice(7));return{data:all.slice(Math.max(0,25-n-10),25-n).reverse(),nextCursor:n+10>=25?null:`native-${n+10}`};})():{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:2}});
 const next=await rpc(transport,3,"thread/turns/list",{threadId:"thread-1",cursor:first!.result.initialTurnsPage.nextCursor,limit:10,itemsView:"presentation"});assert.equal(next?.error,undefined,JSON.stringify(next?.error));
 assert.deepEqual(next!.result.data.map((row:Value)=>row.id),all.slice(13,23).reverse().map(row=>row.id));assert.equal(expired,true);
});

test("revocation during an older-range scan prevents further source reads and imports",async t=>{
 const f=await fixture(t),engine=new FakeEngine();let allowed=true;
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[turn("anchor","small")],nextCursor:"old"}},0);
 const cursor=f.history.read("thread/turns/list",{threadId:"thread-1"}).nextCursor;
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[turn("new","small")],nextCursor:"foreign"}},f.history.revision("thread-1"));
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:null;
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000,undefined,()=>allowed);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const pending=rpc(transport,2,"thread/turns/list",{threadId:"thread-1",cursor,limit:10});
 for(let i=0;i<100&&!engine.sends.some(row=>row.method==="thread/turns/list");i++)await new Promise(resolve=>setImmediate(resolve));
 const request=engine.sends.find(row=>row.method==="thread/turns/list")!;assert.ok(request);allowed=false;
 engine.emit({id:request.id,result:{data:[turn("forbidden","small")],nextCursor:"another"}});
 const result=await pending;assert.equal(result?.result,undefined);assert.ok(result?.error);assert.equal(engine.sends.filter(row=>row.method==="thread/turns/list").length,1);
 assert.equal(f.storage.database.prepare("SELECT count(*) AS n FROM conversation_events WHERE thread_id='thread-1' AND record_id='group:forbidden'").get()?.n,0);
});

for(const persisted of [false,true])test(`a failed older page stops loading and a retry reaches EOF without replacing history; persisted=${persisted}`,async t=>{
 const {createAppServerWorkbenchRuntime}=await import("@opencraft/workbench-runtime");const f=await fixture(t),engine=new FakeEngine();let fail=true;
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{"opencraft/read-history":{version:1,initialTurnsPage:true,itemDetails:true}}}}:request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:[turn("recent","small")],nextCursor:"native-1"}}:request.method==="thread/turns/list"?(()=>{
  return{data:[turn("older","small")],nextCursor:null};})():{};
 const send=engine.send.bind(engine);engine.send=async frame=>{const request=JSON.parse(frame);
  if(fail&&request.method==="thread/turns/list"){engine.sends.push(request);engine.emit({id:request.id,error:{code:-32074,message:"Synthetic older page unavailable"},...(request.__opencraftClient?{__opencraftClient:request.__opencraftClient}:{})});return;}
  await send(frame);
 };
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,1000):engine;
 const runtime=createAppServerWorkbenchRuntime({hostId:"local-codex",transport,autoReconnect:false,requestTimeoutMs:1500,onRecoveryEvent(){}});t.after(()=>runtime.dispose());await runtime.connect();
 const lease=await runtime.acquireThread("thread-1");lease.setRecoveryVisibility(true);
 for(let i=0;i<100&&!lease.getSnapshot().authoritative;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(lease.getSnapshot().authoritative,true);
 await assert.rejects(lease.loadOlder(),/unavailable/);assert.equal(lease.getSnapshot().history.loading,false);assert.ok(lease.getSnapshot().history.error);assert.match(JSON.stringify(lease.getSnapshot().timeline),/recent/);
 fail=false;await lease.loadOlder();assert.equal(lease.getSnapshot().history.loading,false);assert.equal(lease.getSnapshot().history.error,null);assert.equal(lease.getSnapshot().history.hasOlder,false);assert.match(JSON.stringify(lease.getSnapshot().timeline),/older/);assert.match(JSON.stringify(lease.getSnapshot().timeline),/recent/);
 assert.equal(engine.sends.some(row=>["thread/resume","turn/start"].includes(row.method)),false);lease.release();
});

test("reinitialized logical clients rebuild a gap without reusing the previous native continuation",async t=>{
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:25},(_,i)=>turn(`turn-${i}`,"small"));
 engine.handle=request=>request.method==="initialize"?{userAgent:"paging",capabilities:{extensions:{}}}:request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:all.slice(-2).reverse(),nextCursor:"prior-owner-cursor"}}:request.method==="thread/turns/list"?(()=>{
  assert.notEqual(request.params.cursor,"prior-owner-cursor","native continuation cannot outlive its logical owner");
  const n=request.params.cursor==null?0:Number(String(request.params.cursor).slice(7));return{data:all.slice(Math.max(0,25-n-10),25-n).reverse(),nextCursor:n+10>=25?null:`native-${n+10}`};})():{};
 const transport=new ConversationHistoryTransport(engine,f.history,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const first=await rpc(transport,2,"thread/read",{threadId:"thread-1",includeTurns:false,initialTurnsPage:{limit:2}});
 await transport.send(JSON.stringify({method:"runtime/client/disconnect",params:{}}));await rpc(transport,3,"initialize");
 const next=await rpc(transport,4,"thread/turns/list",{threadId:"thread-1",cursor:first!.result.initialTurnsPage.nextCursor,limit:10,itemsView:"presentation"});assert.equal(next?.error,undefined,JSON.stringify(next?.error));assert.deepEqual(next!.result.data.map((row:Value)=>row.id),all.slice(13,23).reverse().map(row=>row.id));
});

for (const persisted of [false, true]) test(`correcting a live Item keeps older history reachable from an open Workbench; persisted=${persisted}`, async t => {
 const {createAppServerWorkbenchRuntime}=await import("@opencraft/workbench-runtime");
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:37},(_,i)=>turn(`history-${i}`,"small"));
 all[36].items.push({id:"transient-reasoning",type:"reasoning",summary:["temporary"]} as any);
 seed(f.history,all);
 engine.handle=request=>request.method==="initialize"?{userAgent:"live-paging",capabilities:{extensions:{"opencraft/read-history":{version:1,initialTurnsPage:true,itemDetails:true}}}}:
  request.method==="thread/read"?{thread:metadata(),initialTurnsPage:{data:[all[36]],nextCursor:"native:35"}}:
  request.method==="thread/turns/list"?(()=>{const offset=request.params.cursor==null?36:Number(request.params.cursor.split(":")[1]),start=Math.max(0,offset-9);return {data:all.slice(start,offset+1).reverse(),nextCursor:start?`native:${start-1}`:null};})():{};
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,1000):engine;
 const runtime=createAppServerWorkbenchRuntime({hostId:"local-codex",transport,autoReconnect:false,requestTimeoutMs:1500,onRecoveryEvent(){}});t.after(()=>runtime.dispose());await runtime.connect();
 const lease=await runtime.acquireThread("thread-1");lease.setRecoveryVisibility(true);
 for(let i=0;i<100&&!lease.getSnapshot().authoritative;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(lease.getSnapshot().authoritative,true);
 await lease.loadOlder();
 const before=lease.getSnapshot().history.cursor;assert.ok(before);
 // A full completion corrects a temporary reasoning Item. The group anchor
 // still exists, but the platform epoch revokes every previously issued cursor.
 const corrected={...all[36],items:all[36].items.filter(item=>item.id!=="transient-reasoning")};all[36]=corrected;
 f.history.observe("turn/completed",{threadId:"thread-1",turn:corrected});
 if(persisted)assert.throws(()=>f.history.read("thread/turns/list",{threadId:"thread-1",cursor:before}),InvalidHistoryCursor);
 await lease.loadOlder();
 assert.equal(lease.getSnapshot().history.loading,false);assert.equal(lease.getSnapshot().history.error,null);
 assert.match(JSON.stringify(lease.getSnapshot().timeline),/history-16/);
 assert.match(JSON.stringify(lease.getSnapshot().timeline),/history-36/);
 assert.equal(engine.sends.some(request=>["thread/resume","turn/start"].includes(request.method)),false);
 lease.release();
});

test("expired group cursors provide a current position only for the same surviving anchor",async t=>{
 const f=await fixture(t);seed(f.history,[turn("old","small"),turn("middle","small"),turn("latest","small")]);
 const page=f.history.read("thread/turns/list",{threadId:"thread-1",limit:1});
 const itemPage=f.history.read("thread/items/list",{threadId:"thread-1",turnId:"latest",limit:1});
 const revised=turn("latest","small");revised.items.splice(1,1);
 f.history.observe("turn/completed",{threadId:"thread-1",turn:revised});
 let replacement:string|undefined;
 assert.throws(()=>f.history.read("thread/turns/list",{threadId:"thread-1",cursor:page.nextCursor}),error=>{
  assert.ok(error instanceof InvalidHistoryCursor);assert.equal(error.data?.code,"HISTORY_CURSOR_EXPIRED");replacement=error.data?.replacementCursor;return true;
 });
 assert.ok(replacement);assert.notEqual(replacement,page.nextCursor);
 assert.equal(f.history.read("thread/turns/list",{threadId:"thread-1",cursor:replacement,limit:1}).data[0].id,"middle");
 // The same expired token remains invalid; recovery is a new authorized read.
 assert.throws(()=>f.history.read("thread/turns/list",{threadId:"thread-1",cursor:page.nextCursor}),InvalidHistoryCursor);
 seed(f.history,[turn("other","small")]);
 for(const cursor of [page.nextCursor,itemPage.nextCursor,"conversation:broken"])
  assert.throws(()=>f.history.read("thread/turns/list",{threadId:"thread-1",cursor}),error=>error instanceof InvalidHistoryCursor && error.data===undefined);
 f.history.importResult("thread/read",{threadId:"other-thread",includeTurns:true},{thread:{...metadata("other-thread"),turns:[turn("peer","small")]}},0);
 assert.throws(()=>f.history.read("thread/turns/list",{threadId:"other-thread",cursor:replacement}),error=>error instanceof InvalidHistoryCursor && error.data===undefined);
});

for(const persisted of [false,true])test(`older range progresses while every source reply overlaps a live Item commit; persisted=${persisted}`,async t=>{
 const f=await fixture(t),engine=new FakeEngine(),all=Array.from({length:30},(_,i)=>turn(`turn-${i}`,"small"));let live=0;
 all[29].status="inProgress";
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[14]],nextCursor:"former"}},0);
 const old=f.history.read("thread/turns/list",{threadId:"thread-1",limit:1}).nextCursor;
 f.history.importResult("thread/read",{threadId:"thread-1",includeTurns:false},{thread:metadata(),initialTurnsPage:{data:[all[29]],nextCursor:"foreign"}},f.history.revision("thread-1"));
 engine.handle=request=>{
  if(request.method==="initialize")return{userAgent:"live-paging",capabilities:{extensions:{}}};
  if(request.method!=="thread/turns/list")return{};
  live++;engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-29",item:{id:"agent-1",type:"agentMessage",text:`live-${live}`}},__opencraftClient:request.__opencraftClient});
  engine.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn-29",item:{id:`live-tool-${live}`,type:"commandExecution",status:"completed",aggregatedOutput:`new output ${live}`}},__opencraftClient:request.__opencraftClient});
  const offset=request.params.cursor==null?0:Number(String(request.params.cursor).split(":")[1]);
  return{data:all.slice(Math.max(0,30-offset-10),30-offset).reverse(),nextCursor:offset+10>=30?null:`native:${offset+10}`};
 };
 const transport=persisted?new ConversationHistoryTransport(engine,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,"initialize");
 const response=await rpc(transport,2,"thread/turns/list",{threadId:"thread-1",cursor:persisted?old:"native:16",limit:10,itemsView:"presentation"});
 assert.equal(response?.error,undefined,JSON.stringify(response?.error));assert.deepEqual(response!.result.data.map((row:Value)=>row.id),all.slice(4,14).reverse().map(row=>row.id));
 if(persisted){
  const head=f.history.read("thread/turns/list",{threadId:"thread-1",limit:1,itemsView:"full"}).data[0];
  assert.equal(head.items.find((item:Value)=>item.id==="agent-1").text,`live-${live}`);
  for(let i=1;i<=live;i++)assert.ok(head.items.some((item:Value)=>item.id===`live-tool-${i}`),"backfill cannot remove a concurrent live member");
  assert.equal(engine.sends.filter(row=>row.method==="thread/turns/list").length,3,"the scan must advance rather than restarting the newest page");
  const expected=f.history.read("thread/read",{threadId:"thread-1",includeTurns:true});
  f.history.rebuild("thread-1");assert.deepEqual(f.history.read("thread/read",{threadId:"thread-1",includeTurns:true}),expected);
  assert.equal(f.history.reindex("thread-1",500).complete,true);
  assert.equal(f.history.read("thread/search",{searchTerm:`live-${live}`}).data.length,1);
 }
 assert.equal(engine.sends.some(row=>["thread/resume","turn/start"].includes(row.method)),false);
});

for(const conflict of ["metadata","group","removal","order","coverage","archive","delete"])test(`range import still rejects a concurrent ${conflict} change`,async t=>{
 const {history}=await fixture(t);seed(history,[turn("old","small"),turn("latest","small")]);
 const fence=history.revision("thread-1");
 if(conflict==="metadata")history.observe("thread/name/updated",{threadId:"thread-1",name:"new name"});
 if(conflict==="group")history.observe("turn/completed",{threadId:"thread-1",turn:{id:"latest",error:{message:"new error"}}});
 if(conflict==="removal" || conflict==="order") {
  const changed=turn("latest","small");
  if(conflict==="removal")changed.items.splice(1,1);else changed.items.reverse();
  history.observe("turn/completed",{threadId:"thread-1",turn:changed});
 }
 if(conflict==="coverage")history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[turn("latest","small")],nextCursor:"changed-source"},fence);
 if(conflict==="archive")history.observe("thread/archived",{threadId:"thread-1"});
 if(conflict==="delete")history.observe("thread/deleted",{threadId:"thread-1"});
 const revision=history.revision("thread-1");assert.ok(revision>fence);
 assert.equal(history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[turn("latest","stale")],nextCursor:"older"},fence,undefined,true),false);
 assert.equal(history.revision("thread-1"),revision,"rejected import must not commit partial content");
});

test("live Item merge is internal, preserves incomplete coverage, and cannot delete a touched group",async t=>{
 const {history}=await fixture(t);
 history.importResult("thread/read",{threadId:"thread-1"},{thread:metadata(),initialTurnsPage:{data:[{id:"latest",status:"inProgress",itemsView:"notLoaded",items:[]}],nextCursor:"older"}},0);
 history.importResult("thread/items/list",{threadId:"thread-1",turnId:"latest"},{data:[],nextCursor:"unread-items"},history.revision("thread-1"));
 const fence=history.revision("thread-1");
 history.observe("item/completed",{threadId:"thread-1",turnId:"latest",item:{id:"new",type:"agentMessage",text:"retained"}});
 const revision=history.revision("thread-1"),page={data:[turn("latest","stale")],nextCursor:"older"};
 // A wire parameter cannot opt an ordinary import into relaxed fencing.
 assert.equal(history.importResult("thread/turns/list",{threadId:"thread-1",allowLiveItemProgress:true},page,fence),false);
 assert.equal(history.importResult("thread/read",{threadId:"thread-1"},{thread:{...metadata(),turns:[turn("latest","stale")]}},fence,undefined,true),false);
 assert.equal(history.importResult("thread/turns/list",{threadId:"thread-1"},{...page,thread:metadata()},fence,undefined,true),false);
 assert.equal(history.importResult("thread/turns/list",{threadId:"thread-1"},{data:[],nextCursor:null},fence,undefined,true),false);
 assert.equal(history.revision("thread-1"),revision);
 assert.equal(history.importResult("thread/turns/list",{threadId:"thread-1"},page,fence,undefined,true),true);
 assert.throws(()=>history.read("thread/turns/list",{threadId:"thread-1",itemsView:"full"}),HistoryNotStored);
 const items=history.read("thread/items/list",{threadId:"thread-1",turnId:"latest"});
 assert.equal(items.historyCoverage,"partial");assert.ok(items.nextCursor);
 assert.deepEqual(items.data.map((entry:Value)=>entry.item.id),["new"]);
 assert.equal(history.itemSourceCursor("thread-1",{turnId:"latest",cursor:items.nextCursor}),"unread-items");
});

test("owner status survives stored-directory reads and fans out to authorized directory-only clients", async t => {
 const { history } = await fixture(t); seed(history);
 const engine = new FakeEngine();
 engine.handle = request => request.method === "initialize" ? { capabilities: { extensions: {} } }
   : request.method === "thread/list" ? { data: [{ ...metadata(), status: { type: "idle" } }], nextCursor: null } : {};
 let allowed = true;
 const transport = new ConversationHistoryTransport(engine, history, undefined, 100, undefined, () => allowed);
 t.after(() => transport.close()); await transport.connect();
 await laneRpc(transport, "writer", 1, "initialize"); await laneRpc(transport, "reader", 1, "initialize"); await engine.connect();
 const packets: Value[] = []; const stop = transport.subscribeMessage(frame => packets.push(JSON.parse(frame))); t.after(stop);
 const active = { type: "active", activeFlags: [] };
 engine.emit({ method: "thread/status/changed", params: { threadId: "thread-1", status: active }, __opencraftClient: "writer" });
 const read = await laneRpc(transport, "reader", 2, "thread/list");
 assert.deepEqual(read.result.data[0].status, active, "stored notLoaded metadata cannot hide an active execution");
 assert.deepEqual(history.list({}).data[0].status, { type: "notLoaded" }, "execution status remains outside durable history");
 assert.ok(packets.some(packet => packet.__opencraftClient === "reader" && packet.params?.change?.status?.type === "active"));
 const waiting = { type: "active", activeFlags: ["waitingOnUserInput"] };
 engine.emit({ method: "thread/status/changed", params: { threadId: "thread-1", status: waiting }, __opencraftClient: "writer" });
 assert.deepEqual((await laneRpc(transport, "reader", 3, "thread/list")).result.data[0].status, waiting);
 engine.emit({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "idle" } }, __opencraftClient: "writer" });
 assert.equal((await laneRpc(transport, "reader", 4, "thread/list")).result.data[0].status.type, "idle");
 assert.equal(engine.sends.some(request => ["thread/resume", "turn/start"].includes(request.method)), false);
 allowed = false; packets.length = 0;
 engine.emit({ method: "thread/status/changed", params: { threadId: "thread-1", status: active }, __opencraftClient: "writer" });
 assert.equal(packets.some(packet => packet.__opencraftClient === "reader"), false, "revoked directory readers receive no status facts");
});

test("cached cold directory discovers owner status in background without waiting for execution", async t => {
 const { history } = await fixture(t); seed(history);
 const engine = new FakeEngine();
 engine.handle = request => request.method === "initialize" ? { capabilities: { extensions: {} } }
   : request.method === "thread/list" ? { data: [{ ...metadata(), status: { type: "active", activeFlags: [] } }], nextCursor: null } : {};
 const transport = new ConversationHistoryTransport(engine, history, undefined, 100); t.after(() => transport.close());
 await transport.connect(); await laneRpc(transport, "reader", 1, "initialize");
 const first = await laneRpc(transport, "reader", 2, "thread/list");
 assert.equal(first.result.data[0].id, "thread-1");
 await eventually(() => engine.sends.some(request => request.method === "thread/list"));
 await new Promise(resolve => setTimeout(resolve, 10));
 assert.equal((await laneRpc(transport, "reader", 3, "thread/list")).result.data[0].status.type, "active");
 assert.equal(engine.sends.some(request => ["thread/resume", "turn/start"].includes(request.method)), false);
});

test('negotiated source pages ignore stale display snapshots, keep bounds and recheck ACL',async t=>{
 const {history}=await fixture(t);seed(history);
 history.initialization({capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}});
 const engine=new FakeEngine();let current=true,version=1;
 engine.handle=request=>request.method==='initialize'?{capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}}
   :request.method==='thread/items/list'?{data:[{turnId:'turn-1',item:{id:'a',type:'agentMessage',text:'LIVE-'+version}}],nextCursor:null}
   :{thread:metadata()};
 const transport=new ConversationHistoryTransport(engine,history,()=>{},8000,undefined,()=>current);t.after(()=>transport.close());
 await transport.connect();const initialized=await rpc(transport,1,'initialize',{});
 assert.equal(initialized?.result.capabilities.extensions['opencraft/read-history'].sourceRead,true);
 const params={threadId:'thread-1',turnId:'turn-1',cursor:null,limit:30,sortDirection:'desc',sourceRead:true};
 const first=await rpc(transport,2,'thread/items/list',params);assert.equal(first?.result.data[0].item.text,'LIVE-1');
 version++;const second=await rpc(transport,3,'thread/items/list',params);assert.equal(second?.result.data[0].item.text,'LIVE-2');
 assert.equal(engine.sends.filter(v=>v.method==='thread/items/list').some(v=>'sourceRead' in v.params),false);
 for(const bad of [{...params,cursor:'old'},{...params,limit:1000},{...params,sortDirection:'asc'}]){
   const denied=await rpc(transport,4,'thread/items/list',bad);assert.equal(denied?.error.code,-32602);
 }
 current=false;const denied=await rpc(transport,5,'thread/items/list',params);assert.ok(denied?.error);
});

test('read-only CLI discovery controls avoid blocked history imports and strict settings never use cached metadata',async t=>{
 const {history}=await fixture(t);seed(history);history.initialization({capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}});
 const engine=new FakeEngine();engine.handle=request=>request.method==='initialize'?{capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}}
   :request.method==='thread/read'?{thread:{...metadata(),model:'native-model',reasoningEffort:'medium'}}
   :{discovery:'live'};
 const transport=new ConversationHistoryTransport(engine,history);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,'initialize',{});
 const actual=await rpc(transport,2,'thread/read',{threadId:'thread-1',includeTurns:false,sourceRead:true});
 assert.equal(actual.result.thread.model,'native-model');assert.equal(history.read('thread/read',{threadId:'thread-1',includeTurns:false})?.thread?.model,undefined);
 let release:()=>void=()=>{};const blocked=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const importResult=history.importResult.bind(history);(history as any).importResult=async(...args:any[])=>{await blocked;return importResult(...args as Parameters<typeof importResult>);};
 engine.emit({method:'thread/started',params:{thread:metadata('another')}});
 for(const action of ['projects','models','options']) {
  const response=await rpc(transport,'discovery-'+action,'opencraft/collaboration',{action});assert.equal(response.result.discovery,'live');
 }
 release();assert.equal(engine.sends.some(request=>request.method==='turn/start'),false);
});

test('exact stop/cancel outer and internal controls remain responsive while durable history imports are blocked',async t=>{
 const {history}=await fixture(t);seed(history);const engine=new FakeEngine();
 engine.handle=request=>request.method==='initialize'?{capabilities:{extensions:{}}}:{controlReply:true};
 const transport=new ConversationHistoryTransport(engine,history);await transport.connect();await rpc(transport,1,'initialize',{});
 const warm=await rpc(transport,2,'opencraft/conversation/stop-observe',{threadId:'thread-1',expectedTurnId:'turn-1'});assert.equal(warm.result.controlReply,true);
 let entered=false,release=()=>{};const held=new Promise<void>(resolve=>release=resolve);const observe=history.observe.bind(history),revision=history.revision.bind(history);
 t.after(async()=>{history.revision=revision;release();await transport.close();});
 (history as any).observe=async(...args:any[])=>{entered=true;await held;return observe(...args as Parameters<typeof observe>);};
 history.revision=()=>{throw Error('exact controls must not read history SQL revisions');};
 engine.emit({method:'thread/started',params:{thread:metadata('blocked-history')}});await eventually(()=>entered);
 let sequence=2;
 for(const [method,params] of [
  ['opencraft/thread-defaults/update',{threadId:'thread-1',scope:'subsequent-native-turns-including-already-accepted'}],
  ['opencraft/thread-defaults/read',{threadId:'thread-1'}],
  ['opencraft/conversation/stop',{threadId:'thread-1',expectedTurnId:'turn-1'}],
  ['opencraft/conversation/stop-observe',{threadId:'thread-1',expectedTurnId:'turn-1'}],
  ...['threadDefaults','threadDefaultsObserve','stop','stopObserve','queueCancel'].map(action=>['opencraft/collaboration',{action,reference:{serverId:'server',threadId:'thread-1'}}]),
 ] as const){const result=await rpc(transport,++sequence,method,params);assert.equal(result.result.controlReply,true);}
 history.revision=revision;release();assert.equal(engine.sends.some(request=>request.method==='turn/start'),false);
});


test('nested Hub cancel receipt/delete cross real AppHost history lanes while history writes are blocked',async t=>{
 const {history}=await fixture(t);seed(history);const engine=new FakeEngine();let deleted=0;
 engine.handle=request=>request.method==='initialize'?{capabilities:{extensions:{'opencraft/queue-cancel':{version:1,finalAdmission:true}}}}
  :request.method==='thread/queue/collaborationReceipt'?{receipt:{id:'q',state:'queued'}}
  :request.method==='thread/queue/delete'?(deleted++,{deleted:true}):{};
 const wrapped=new ConversationHistoryTransport(engine,history);
 const host=new AppHostServer({logicalClientRouting:true,hostDefinitions:[{hostId:'local-codex',label:'synthetic'}],createTransport:()=>wrapped});
 const execution=createRoutedConversationExecution(()=>host,{machineId:'synthetic',engines:[],getInputs:async()=>null});
 const binding={serverId:'server:synthetic:codex',hostId:'local-codex',threadId:'thread-1',mode:'queue'};
 const originalSend=engine.send.bind(engine);
 engine.send=async frame=>{const request=JSON.parse(frame);if(request.method!=='opencraft/collaboration')return originalSend(frame);
  engine.sends.push(request);const receipt=await execution.receipt(binding,'r');assert.equal(receipt.state,'queued');
  const cancelled=await execution.cancel(binding,'r',receipt.id,()=>{});
  engine.emit({id:request.id,result:{cancelled},...(request.__opencraftClient?{__opencraftClient:request.__opencraftClient}:{})});};
 // Keep the physical Host leased while short-lived internal logical clients close.
 let ingress:any,ready=()=>{};const leased=new Promise<void>(resolve=>ready=resolve);
 const keeper=host.accept({subscribe(fn:any){ingress=fn;return()=>{};},start(){},close(){},postMessage(message:any){if(message.type==='ready')ingress({type:'host/connect',requestId:'keep',hostId:'local-codex',leaseId:'keep'});if(message.type==='response'&&message.requestId==='keep'){assert.equal(message.ok,true);ready();}}},'history-keeper');
 ingress({type:'hello',protocolVersion:APP_HOST_PROTOCOL_VERSION,rendererId:'history-keeper'});await leased;t.after(()=>keeper.close());
 await execution.receipt(binding,'warm');
 let entered=false,release=()=>{};const held=new Promise<void>(resolve=>release=resolve),observe=history.observe.bind(history),revision=history.revision.bind(history);
 t.after(async()=>{history.revision=revision;release();await host.close();});
 (history as any).observe=async(...args:any[])=>{entered=true;await held;return observe(...args as Parameters<typeof observe>);};
 history.revision=()=>{throw Error('nested cancel must not read history SQL');};
 engine.emit({method:'thread/started',params:{thread:metadata('blocked-nested')}});await eventually(()=>entered);
 const result=await callConversationHost(host,binding,'outer','opencraft/collaboration',{action:'queueCancel'},undefined,1500);
 assert.equal(result.cancelled,true,JSON.stringify({result,methods:engine.sends.map(r=>r.method)}));assert.equal(deleted,1);assert.ok(engine.sends.some(request=>request.method==='thread/queue/collaborationReceipt'));assert.ok(engine.sends.some(request=>request.method==='thread/queue/delete'));
});


test("native reply separates status calculation and notification delivery without adding access checks",async t=>{
 const {history}=await fixture(t),engine=new FakeEngine(),events:Value[]=[],notifications:Value[]=[];let checks=0;
 const rows=Array.from({length:3},(_,i)=>({...metadata(`synthetic-private-${i}`),status:{type:"idle"}}));
 engine.handle=request=>request.method==="initialize"?{capabilities:{extensions:{}}}:{data:rows,nextCursor:null};
 const transport=new ConversationHistoryTransport(engine,history,undefined,1000,undefined,()=>{
  checks++;const until=performance.now()+4;while(performance.now()<until){}return true;
 },e=>events.push(e));await transport.connect();t.after(()=>transport.close());
 transport.subscribeMessage(frame=>{const p=JSON.parse(frame);if(p.method==="opencraft/thread-catalog/changed"&&p.__opencraftNotification?.notificationSource==="execution-status")notifications.push(p);});
 await rpc(transport,1,"initialize");const reply=await rpc(transport,2,"thread/list",{limit:3});assert.equal(reply?.error,undefined);
 const native=events.find(e=>e.traceRole==="native-rpc"&&e.method==="thread/list");assert(native);
 assert.equal(native.nativeStatusChanges,3);assert.equal(native.nativeStatusPublishAttempts,3);assert.equal(notifications.length,3);
 assert.equal(checks,9,"three publications retain admission plus both recipient guards; diagnostics cannot add checks");
 assert(native.nativeStatusPublishMs>=8,JSON.stringify(native));assert(native.nativeStatusSnapshotMs>=0);assert(native.nativeReplyYieldMs>=0);
 assert(native.nativeReplyProcessingMs>=native.nativeStatusPublishMs);assert(!JSON.stringify(events).includes("synthetic-private"));
 const {sanitizeEvent}=await import("../../packages/observability-contract/index.mjs");assert(sanitizeEvent({schemaVersion:1,component:"gateway",eventId:"fixture",producerId:"fixture",at:Date.now(),...native}));
});


test("directory EOF observations survive changed head refreshes without permanent completeness",async t=>{
 const f=await fixture(t),h=f.history;
 const rows=Array.from({length:700},(_,i)=>({...metadata(`cached-${i}`),updatedAt:1000-i}));
 h.importResult("thread/list",{}, {data:rows,nextCursor:"old-native-tail"},h.catalogRevision());
 let cursor:any=null;for(let page=0;page<14;page++)cursor=h.list({cursor,limit:50}).nextCursor;
 assert(cursor);
 h.importResult("thread/list",{cursor:"old-native-tail"},{data:[],nextCursor:null},h.catalogRevision());
 const epoch=h.directoryEpoch({});
 for(let round=0;round<2;round++) {
  h.importResult("thread/list",{}, {data:[{...metadata(`new-${round}`),updatedAt:2000+round},...rows.slice(0,100)],nextCursor:"new-native-head"},h.catalogRevision());
  const tail=h.list({cursor,limit:50});assert.equal(tail.nextCursor,null);assert.equal(tail.data.length,0);
  assert.equal(tail.historyCoverage.state,"observed");assert.equal(h.directoryEpoch({}),epoch);
 }
 const reopened=await f.reopen();assert.equal(reopened.directoryEpoch({}),epoch);assert.equal(reopened.list({cursor}).nextCursor,null);
 const encoded=String(f.storage.database.prepare("SELECT sync_state FROM conversation_catalogs WHERE scope=?").get(h.scope)!.sync_state);
 assert(!encoded.includes("native-"),"native continuations are not durable progress");
 reopened.observe("opencraft/thread-catalog/changed",{version:1,source:"source-one",revision:1,change:{type:"invalidate"}});
 const invalidated=reopened.directoryEpoch({});assert.notEqual(invalidated,epoch);
 assert.throws(()=>reopened.list({cursor}),HistoryNotStored);
 reopened.observe("opencraft/thread-catalog/changed",{version:1,source:"source-one",revision:1,change:{type:"invalidate"}});
 assert.equal(reopened.directoryEpoch({}),invalidated,"duplicate delivery does not invalidate twice");
});

test("directory epochs reject old imports before merging facts and retain query isolation",async t=>{
 const {history:h}=await fixture(t);h.metadata(metadata());
 const epoch=h.directoryEpoch({}),archived=h.directoryEpoch({archived:true}),fence=h.directoryFence();
 h.invalidateDirectory({});
 assert.notEqual(h.directoryEpoch({}),epoch);assert.equal(h.directoryEpoch({archived:true}),archived);
 assert.equal(h.importResult("thread/list",{}, {data:[metadata("late-old-epoch")],nextCursor:null},h.catalogRevision(),fence,false,undefined,{epoch,fromHead:true}),false);
 assert.equal(h.thread("late-old-epoch"),null);
 const current=h.directoryEpoch({});
 assert.equal(h.importResult("thread/list",{}, {data:[metadata()],nextCursor:null},h.catalogRevision(),fence,false,undefined,{epoch:current,fromHead:true}),true);
 assert.equal(h.list({}).historyCoverage.state,"observed");
});

test("head revalidation cannot rewind a bounded directory scan or recapture its fence per page",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();
 const rows=Array.from({length:12},(_,i)=>({...metadata(`known-${i}`),updatedAt:100-i}));
 h.importResult("thread/list",{}, {data:rows,nextCursor:"retired"},h.catalogRevision());
 const cursor=h.list({limit:12}).nextCursor;assert(cursor);
 const calls=t.mock.method(h,"directoryFence");
 engine.handle=req=>{
  if(req.method==="initialize")return {capabilities:{extensions:{}}};if(req.method!=="thread/list")return {};
  const page=req.params.cursor==null?0:Number(String(req.params.cursor).slice(5));
  return {data:page<12?[rows[page]]:[{...metadata("new-older"),updatedAt:0}],nextCursor:page<12?`scan-${page+1}`:null};
 };
 const transport=new ConversationHistoryTransport(engine,h,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,8000,"initialize");
 const bounded=await rpc(transport,8001,"thread/list",{cursor,limit:12});assert(bounded?.error);
 assert.equal(engine.sends.filter(r=>r.method==="thread/list").length,8);
 await rpc(transport,8002,"thread/list",{limit:1});
 await eventually(()=>engine.sends.filter(r=>r.method==="thread/list").length===9);
 const result=await rpc(transport,8003,"thread/list",{cursor,limit:12});assert.equal(result?.error,undefined);
 assert.deepEqual(result?.result.data.map((row:Value)=>row.id),["new-older"]);
 const requests=engine.sends.filter(r=>r.method==="thread/list");
 assert.deepEqual(requests.map(r=>r.params.cursor),[null,"scan-1","scan-2","scan-3","scan-4","scan-5","scan-6","scan-7",null,"scan-8","scan-9","scan-10","scan-11","scan-12"]);
 assert.equal(calls.mock.callCount(),2,"one snapshot for the scan and one independent head revalidation");
});


test("an untracked native continuation cannot certify the whole directory",async t=>{
 const {history:h}=await fixture(t);h.metadata(metadata());
 const epoch=h.directoryEpoch({});
 h.importResult("thread/list",{cursor:"external-native-tail"},{data:[],nextCursor:null},h.catalogRevision(),h.directoryFence(),false,undefined,{epoch,fromHead:false});
 const page=h.list({limit:1});assert.equal(page.historyCoverage.state,"partial");assert(page.nextCursor);
 assert.throws(()=>h.list({cursor:page.nextCursor}),HistoryNotStored);
});

test("source availability transitions retire the previous observation epoch",async t=>{
 const {history:h}=await fixture(t);
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:null},h.catalogRevision());
 const epoch=h.directoryEpoch({});
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:"new-page",unavailableEngines:["pi"]},h.catalogRevision());
 assert.notEqual(h.directoryEpoch({}),epoch);assert.equal(h.list({}).historyCoverage.state,"partial");
 const unavailable=h.directoryEpoch({});
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:"available-page"},h.catalogRevision());
 assert.notEqual(h.directoryEpoch({}),unavailable);assert.equal(h.list({}).historyCoverage.hasMore,true);
});

test("a native reply from an invalidated epoch cannot restore metadata or finish its scan",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();
 h.importResult("initialize",{}, {capabilities:{extensions:{}}},0);
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:"retired"},h.catalogRevision());
 const cursor=h.list({limit:1}).nextCursor;let held:Value|undefined,reads=0;
 engine.handle=req=>{
  if(req.method==="initialize")return {capabilities:{extensions:{}}};if(req.method!=="thread/list")return {};
  if(++reads===1){held=req;return null;}
  assert.equal(req.params.cursor,null);return {data:[metadata()],nextCursor:null};
 };
 const transport=new ConversationHistoryTransport(engine,h,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,8100,"initialize");
 const pending=rpc(transport,8101,"thread/list",{cursor,limit:1});await eventually(()=>!!held);
 engine.emit({method:"opencraft/thread-catalog/changed",params:{version:1,source:"native-owner",revision:1,change:{type:"invalidate"}}});
 engine.emit({id:held!.id,result:{data:[metadata("late-epoch-row")],nextCursor:null}});
 const result=await pending;assert.equal(result?.error,undefined);assert.equal(result?.result.nextCursor,null);
 assert.equal(h.thread("late-epoch-row"),null);assert.equal(reads,2);
});


test("a retired physical source resets observation coverage even when it reconnects in place",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();
 h.importResult("initialize",{}, {capabilities:{extensions:{}}},0);
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:"old-connection-cursor"},h.catalogRevision());
 const cursor=h.list({limit:1}).nextCursor;
 h.importResult("thread/list",{cursor:"old-connection-cursor"},{data:[],nextCursor:null},h.catalogRevision());
 const epoch=h.directoryEpoch({});
 engine.handle=req=>req.method==="initialize"?{capabilities:{extensions:{}}}:req.method==="thread/list"?{data:[metadata(),{...metadata("after-reconnect"),updatedAt:0}],nextCursor:null}:{};
 const transport=new ConversationHistoryTransport(engine,h,undefined,1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,8200,"initialize");
 engine.status={state:"failed"};for(const listener of engine.statuses)listener(engine.status);
 const result=await rpc(transport,8201,"thread/list",{cursor,limit:1});
 assert.notEqual(h.directoryEpoch({}),epoch);assert.equal(result?.error,undefined);
 assert.deepEqual(result?.result.data.map((row:Value)=>row.id),["after-reconnect"]);
 assert(engine.sends.filter(r=>r.method==="thread/list").every(r=>r.params.cursor==null));
});


test("aged directory observations reconcile once across readers, yield batches and discover unnotified older rows",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();
 const rows=Array.from({length:12},(_,i)=>({...metadata(`reconcile-${i}`),updatedAt:100-i}));
 h.importResult("thread/list",{}, {data:rows.slice(0,11),nextCursor:null},h.catalogRevision());
 const before=h.directoryState({});const clock=Date.now()+3_600_001;t.mock.method(Date,"now",()=>clock);
 let held:Value|undefined,sourceReads=0;
 engine.handle=req=>{
  if(req.method==="initialize")return {capabilities:{extensions:{}}};if(req.method!=="thread/list")return {};
  sourceReads++;
  if(sourceReads===1){held=req;return null;}
  const page=req.params.cursor==null?0:Number(String(req.params.cursor).slice(8));
  return {data:[rows[page]],nextCursor:page<11?`advance-${page+1}`:null};
 };
 const calls=t.mock.method(h,"directoryFence"),transport=new ConversationHistoryTransport(engine,h,undefined,1000);t.after(()=>transport.close());await transport.connect();
 async function laneRpc(lane:string,id:number,method:string,params:Value={}) {
  let response:Value|undefined;const off=transport.subscribeMessage(frame=>{const p=JSON.parse(frame);if(p.id===id)response=p;});
  try{await transport.send(JSON.stringify({id,method,params,__opencraftClient:lane}));return response;}finally{off();}
 }
 await laneRpc("one",8300,"initialize");await laneRpc("two",8301,"initialize");
 const first=await laneRpc("one",8302,"thread/list",{limit:1});assert.equal(first?.error,undefined);assert.equal(first?.result.data.length,1);
 await eventually(()=>!!held);
 const other=await laneRpc("two",8303,"thread/list",{limit:1});assert.equal(other?.error,undefined);assert.equal(other?.result.data.length,1);
 assert.equal(sourceReads,1,"cached reads do not wait on a second reconciliation");
 engine.emit({id:held!.id,__opencraftClient:held!.__opencraftClient,result:{data:[rows[0]],nextCursor:"advance-1"}});
 await eventually(()=>h.directoryState({}).observedAt===clock);
 const after=h.directoryState({});assert.equal(after.reconciling,false);assert.notEqual(after.epoch,before.epoch);
 assert.equal(sourceReads,12,"one shared scan crosses the eight-page batch boundary");assert.equal(calls.mock.callCount(),1);
 assert(h.list({limit:20}).data.some((row:Value)=>row.id==="reconcile-11"));
});

test("a failed periodic reconciliation preserves data and remains eligible for the next revalidation",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();
 h.importResult("thread/list",{}, {data:[metadata()],nextCursor:null},h.catalogRevision());
 const before=h.directoryState({});const clock=Date.now()+3_600_001;t.mock.method(Date,"now",()=>clock);
 let reads=0;
 engine.handle=req=>{
  if(req.method==="initialize")return {capabilities:{extensions:{}}};if(req.method!=="thread/list")return {};
  if(++reads===1)throw Object.assign(Error("source unavailable"),{code:-32001});
  return {data:[metadata(),{...metadata("out-of-band"),updatedAt:0}],nextCursor:null};
 };
 const diagnostics:string[]=[],transport=new ConversationHistoryTransport(engine,h,event=>diagnostics.push(event),1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,8400,"initialize");
 const first=await rpc(transport,8401,"thread/list",{limit:1});assert.equal(first?.result.data.length,1);
 await eventually(()=>diagnostics.includes("history-refresh-unavailable"));
 assert(h.thread("thread-1"));assert.equal(h.directoryState({}).observedAt,before.observedAt);assert.equal(h.directoryState({}).reconciling,true);
 await rpc(transport,8402,"thread/list",{limit:1});await eventually(()=>h.directoryState({}).observedAt===clock);
 assert(h.thread("out-of-band"));assert.equal(h.directoryState({}).reconciling,false);assert.equal(reads,2);
});

test("background history refreshes are globally bounded across recovered clients",async t=>{
 const {history:h}=await fixture(t),engine=new FakeEngine();seed(h);
 let active=0,maximum=0,started=0;const held:Value[]=[];
 engine.handle=req=>{
  if(req.method==="initialize")return {capabilities:{extensions:{}}};
  if(req.method==="thread/list") { active++;started++;maximum=Math.max(maximum,active);held.push(req);return null; }
  return {};
 };
 const transport=new ConversationHistoryTransport(engine,h,undefined,1000);t.after(()=>transport.close());await transport.connect();
 async function laneRpc(lane:string,id:number,method:string,params:Value={}) {
  let response:Value|undefined;const off=transport.subscribeMessage(frame=>{const packet=JSON.parse(frame);if(packet.id===id)response=packet;});
  try{await transport.send(JSON.stringify({id,method,params,__opencraftClient:lane}));return response;}finally{off();}
 }
 for(let lane=0;lane<5;lane++)await laneRpc(`refresh-${lane}`,8500+lane,"initialize");
 for(let lane=0;lane<5;lane++) {
  const response=await laneRpc(`refresh-${lane}`,8510+lane,"thread/list",{limit:20});
  assert.equal(response?.error,undefined);
 }
 await eventually(()=>held.length===2);assert.equal(maximum,2);
 while(started<5) {
  const request=held.shift()!;active--;engine.emit({id:request.id,__opencraftClient:request.__opencraftClient,result:{data:[metadata()],nextCursor:null}});
  await eventually(()=>held.length>0);
 }
 while(held.length) {const request=held.shift()!;active--;engine.emit({id:request.id,__opencraftClient:request.__opencraftClient,result:{data:[metadata()],nextCursor:null}});}
 await eventually(()=>active===0);assert.equal(maximum,2);
});

test("versioned local directory retains one SQL snapshot across pages and replaces it on recovery", async t => {
 const {history:h}=await fixture(t);
 const rows=Array.from({length:130},(_,i)=>({...metadata(`s-${String(i).padStart(3,'0')}`),updatedAt:1000-i,name:`name-${i}`}));
 h.importResult('thread/list',{}, {data:rows,nextCursor:null},h.catalogRevision());
 let page=h.list({cursor:'opencraft-catalog-snapshot-v1:start',limit:50});
 assert.equal(page.catalog.coverage,'complete');const id=page.catalogSnapshot.id;const collected=[...page.data];
 h.observe('thread/name/updated',{threadId:'s-100',name:'changed'});h.delete('s-110');
 while(page.nextCursor){page=h.list({cursor:page.nextCursor,limit:50});assert.equal(page.catalogSnapshot.id,id);collected.push(...page.data);}
 assert.equal(collected.length,130);assert.equal(collected.find(x=>x.id==='s-100').name,'name-100');assert.ok(collected.some(x=>x.id==='s-110'));
 const fresh=h.list({cursor:'opencraft-catalog-snapshot-v1:start',limit:200});
 assert.equal(fresh.data.find((x:Value)=>x.id==='s-100').name,'changed');assert.equal(fresh.data.some((x:Value)=>x.id==='s-110'),false);
 assert.ok(fresh.catalogSnapshot.checkpoints[0].revision>page.catalogSnapshot.checkpoints[0].revision);
});

test("metadata-only storage never certifies a complete directory",async t=>{
 const {history}=await fixture(t);history.metadata(metadata('only-known'));
 const page=history.list({cursor:'opencraft-catalog-snapshot-v1:start'});
 assert.equal(page.catalog.state,'warming');assert.equal(page.catalog.coverage,'partial');
});

test("a snapshot reader receives an authorized metadata batch rather than a full invalidation",async t=>{
 const {history}=await fixture(t);seed(history);
 const engine=new FakeEngine(),transport=new ConversationHistoryTransport(engine,history,undefined,1000);t.after(()=>transport.close());
 await transport.connect();const init=await rpc(transport,9000,'initialize');
 assert.equal(init?.result.capabilities.extensions['opencraft/thread-directory-snapshots'].version,1);
 const head=await rpc(transport,9001,'thread/list',{cursor:'opencraft-catalog-snapshot-v1:start'});
 assert.ok(head?.result.catalogSnapshot);
 const packets:Value[]=[];const stop=transport.subscribeMessage(frame=>packets.push(JSON.parse(frame)));t.after(stop);
 history.observe('thread/name/updated',{threadId:'thread-1',name:'new-title'});
 const packet=packets.find(p=>p.method==='opencraft/thread-catalog/changed'&&p.params.change.type==='batch');
 assert.ok(packet);assert.equal(packet.params.authority,'directory');assert.equal(packet.params.change.changes[0].thread.name,'new-title');
 const newer=history.list({cursor:'opencraft-catalog-snapshot-v1:start'});
 assert.ok(newer.catalogSnapshot.checkpoints[0].revision>=packet.params.revision);
});


test("Merkle equality refreshes newly active execution-owner rows absent from the old active set", async t => {
  const { reconcileThreadCatalog } = await import("../../apps/workbench-web/src/runtime/thread-catalog-recovery");
  const { THREAD_DIRECTORY_SNAPSHOT_START } = await import("@opencraft/appserver-protocol");
  const f = await fixture(t), engine = new FakeEngine();
  const data = Array.from({ length: 100 }, (_, i) => ({ ...metadata(`active-${i}`), name: `Synthetic ${i}`, preview: "", status: { type: "idle" } }));
  f.history.importResult("thread/list", {}, { data, nextCursor: null }, f.history.catalogRevision());
  engine.handle = request => request.method === "initialize" ? { capabilities: { extensions: {} } }
    : request.method === "thread/list" ? { data, nextCursor: null } : {};
  const transport = new ConversationHistoryTransport(engine, f.history);
  try {
    await transport.connect(); await rpc(transport, 501, "initialize", { clientInfo: { name: "synthetic", version: "1" } });
    const previous = (await rpc(transport, 502, "thread/list", { cursor: THREAD_DIRECTORY_SNAPSHOT_START, limit: 1000 }))!.result;
    assert.notEqual(previous.data.find((r: Value) => r.id === "active-50").status.type, "active");
    engine.emit({ method: "thread/status/changed", params: { threadId: "active-50", status: { type: "active", activeFlags: [] } } });
    let nextId = 503;
    const restored = await reconcileThreadCatalog(previous, async cursor => (await rpc(transport, nextId++, "thread/list", { cursor, limit: 50 }))!.result);
    assert.ok(restored); assert.equal(restored.data.find(r => r.id === "active-50")!.status.type, "active");
  } finally { await transport.close(); }
});


test("partial Codex generation pages retain cached slow-source rows while importing fresh metadata", async t => {
  const f = await fixture(t), history = f.history;
  history.importResult("thread/list", {}, { data: [metadata("slow-retained")], nextCursor: null }, history.catalogRevision());
  history.importResult("thread/list", {}, { data: [{ ...metadata("fresh-active"), updatedAt: 200 }], nextCursor: null,
    catalog: { state: "error", coverage: "partial" } }, history.catalogRevision());
  const page = history.list({});
  assert.deepEqual(page.data.map((row: Value) => row.id), ["fresh-active", "slow-retained"]);
  assert.deepEqual(page.catalog, { state: "error", coverage: "partial" });
  assert.notEqual(page.historyCoverage.state, "observed");
  assert.equal(history.read("thread/read", { threadId: "slow-retained", includeTurns: false }).thread.id, "slow-retained");
});


for (const sourceFallback of [false, true]) for (const retire of ["unsubscribe", "abort", "reinitialize", "disconnect"] as const)
  test(`late asynchronous history cannot restore a retired watch (${sourceFallback ? "source-fallback" : "cache-hit"}, ${retire})`, async t => {
    const { history } = await fixture(t); seed(history);
    let release!: () => void, started!: () => void, reads = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Proxy(history, { get(target, key) {
      if (key === "read") return async (method: string, ...args: any[]) => {
        if (method === "thread/read") {
          if (sourceFallback && ++reads === 1) throw new HistoryNotStored("synthetic cache miss");
          started(); await held;
        }
        return (target.read as any)(method, ...args);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    let current: (() => boolean) | undefined;
    class ReaderEngine extends FakeEngine {
      watchConversation(_threadId: string, _clientId: string, check: () => boolean) {
        current = check; return () => { if (current === check) current = undefined; };
      }
      async send(frame: string) {
        const request = JSON.parse(frame);
        if (request.method === "opencraft/interactions/read") {
          this.emit({ id: request.id, ...(current?.() ? { result: { requests: [] } } : { error: { code: 403 } }) }); return;
        }
        await super.send(frame);
      }
    }
    const engine = new ReaderEngine(), transport = new ConversationHistoryTransport(engine, delayed);
    t.after(() => transport.close()); await transport.connect(); await rpc(transport, 1, "initialize");
    const controller = new AbortController(), responses: Value[] = [];
    transport.subscribeMessage(raw => responses.push(JSON.parse(raw)));
    const pending = transport.send(JSON.stringify({ id: 2, method: "thread/read", params: { threadId: "thread-1", watch: true } }), controller.signal);
    await reading;
    if (retire === "abort") controller.abort();
    else if (retire === "unsubscribe") await rpc(transport, 3, "thread/unsubscribe", { threadId: "thread-1" });
    else if (retire === "reinitialize") await rpc(transport, 3, "initialize");
    else {
      await transport.send(JSON.stringify({ method: "runtime/client/disconnect" }));
      await rpc(transport, 3, "initialize");
    }
    release(); await pending.catch(() => undefined);
    assert.equal(responses.some(response => response.id === 2 && response.result), false, "retired read cannot report successful watch admission");
    const snapshot = await rpc(transport, 4, "opencraft/interactions/read", { threadId: "thread-1" });
    assert.equal(snapshot?.error?.code, 403, "late cache or source reply cannot restore interaction access");
  });
