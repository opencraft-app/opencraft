import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ConversationHistoryWorker, type HistoryWorkTiming } from "../../packages/app-host-server/src/conversation-history-worker.js";
import { ConversationHistory, HistoryNotStored, InvalidHistoryCursor } from "../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport.js";

async function fixture(t: test.TestContext, onSlowWork?: (timing: HistoryWorkTiming)=>void) {
  const directory=mkdtempSync(join(tmpdir(),"history-worker-"));
  const storage=await openServerDatabase(directory);
  const worker=new ConversationHistoryWorker(join(directory,"opencraft-server.sqlite"),onSlowWork);
  t.after(async()=>{await worker.close();await storage.close();rmSync(directory,{recursive:true,force:true});});
  await worker.start();
  const history=worker.create("local-codex");
  await history.observe("thread/started",{thread:{id:"thread",name:"Worker",cwd:"/synthetic",createdAt:1,updatedAt:2}});
  return {directory,storage,worker,history};
}

test("worker commits ordered history, propagates notifications and drains before reopen",async t=>{
  const {storage,worker,history}=await fixture(t);
  const changes:number[]=[];history.subscribeCommitted((_ids,revision)=>changes.push(revision));
  const writes=[];
  for(let i=0;i<20;i++)writes.push(history.observe("thread/name/updated",{threadId:"thread",threadName:`name-${i}`}));
  await Promise.all(writes);
  assert.equal((await history.read("thread/read",{threadId:"thread"})).thread.name,"name-19");
  assert.equal(changes.length,20);assert.ok(changes.every((n,i)=>i===0||n>changes[i-1]!));
  await worker.close();
  const saved=new ConversationHistory(storage.database,"local-codex");
  assert.equal(saved.read("thread/read",{threadId:"thread"}).thread.name,"name-19");
});

test("worker keeps scopes and discovery separate and returns typed history errors",async t=>{
  const {worker,history}=await fixture(t), other=worker.create("opencraft-server");
  await history.initialization({userAgent:"only-this-client"});
  assert.equal(await other.initialization(),null);
  assert.equal(await other.hasThreads(),false);
  await assert.rejects(async()=>await other.read("thread/read",{threadId:"thread"}),HistoryNotStored);
  await assert.rejects(async()=>await history.read("thread/list",{cursor:"conversation-directory:bad"}),InvalidHistoryCursor);
  await history.close?.();
  await assert.rejects(async()=>await history.hasThreads(),/closed/);
});

test("worker authorizes search outside SQL transactions and rechecks revocation before returning",async t=>{
  const {storage,history}=await fixture(t);
  await history.reindex("thread");
  const calls:string[]=[];
  const result=await Promise.resolve(history.read("thread/search",{searchTerm:"Worker"},id=>{
    calls.push(id);
    // An account-domain write here must succeed immediately: the worker is
    // awaiting authorization with no transaction or SQLite writer lock held.
    storage.database.exec("CREATE TABLE IF NOT EXISTS synthetic_authorization (id INTEGER)");
    return calls.length===1;
  })).catch((error:unknown)=>error);
  assert.ok(result instanceof HistoryNotStored, String(result));assert.deepEqual(calls,["thread","thread"]);
  assert.equal((await history.read("thread/search",{searchTerm:"Worker"},()=>false)).data.length,0);
});

test("a blocked SQLite writer does not stall gateway HTTP or WebSocket and retries losslessly",async t=>{
  const {storage,history}=await fixture(t);
  storage.database.exec("BEGIN IMMEDIATE");
  let committed=false;
  const write=Promise.resolve(history.observe("thread/name/updated",{threadId:"thread",threadName:"after-lock"})).then(()=>{committed=true;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(committed,false);
  const server=createServer((_req,res)=>res.end("session-ready"));
  const sockets=new WebSocketServer({server});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as any).port;
  const socket=new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await once(socket,"open");
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/session`)).text(),"session-ready");
    assert.equal(committed,false,"gateway responds while worker is awaiting SQLite contention");
  } finally {
    socket.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));storage.database.exec("COMMIT");
  }
  await write;
  assert.equal((await history.read("thread/read",{threadId:"thread"})).thread.name,"after-lock");
});

test("heavy indexing runs off-thread while HTTP and WebSocket continue and close drains live writes",async t=>{
  const {history}=await fixture(t);
  const server=createServer((_req,res)=>res.end("ready")), sockets=new WebSocketServer({server});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as any).port;
  // The synchronous owner genuinely hashes, tokenizes and indexes this body.
  // A Promise queue on the gateway cannot pass the response-before-commit cut.
  let done=false;
  const work=Promise.resolve(history.observe("item/completed",{threadId:"thread",turnId:"turn",item:{id:"item",type:"agentMessage",text:"worker indexing 汉字 ".repeat(160000)}})).then(()=>{done=true;});
  const socket=new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await once(socket,"open");
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/session`)).text(),"ready");
    assert.equal(done,false,"network progresses during one indivisible history transaction");
  } finally {
    socket.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
  await work;
  await history.observe("turn/completed",{threadId:"thread",turn:{id:"turn",status:"completed",itemsView:"full",items:[{id:"item",type:"agentMessage",text:"worker indexing 汉字 ".repeat(160000)}]}});
  const text=(await history.read("thread/turns/list",{threadId:"thread",itemsView:"full"})).data[0].items[0].text;
  assert.equal(text.length,"worker indexing 汉字 ".length*160000);
});

test("real history transport forwards live frames immediately and closes after accepted worker writes",async t=>{
  const {history,storage}=await fixture(t);
  let listener:(frame:string)=>void=()=>{};
  const inner={status:{state:"open" as const},async connect(){},async close(){},async send(){},subscribeMessage(fn:typeof listener){listener=fn;return()=>{};},subscribeStatus(){return()=>{};}};
  const transport=new ConversationHistoryTransport(inner,history);
  await transport.connect();
  const frames:string[]=[];transport.subscribeMessage(frame=>frames.push(JSON.parse(frame).method));
  for(let i=0;i<30;i++)listener(JSON.stringify({method:"thread/name/updated",params:{threadId:"thread",threadName:`live-${i}`}}));
  assert.equal(frames.length,30);
  await transport.close();
  assert.equal(new ConversationHistory(storage.database,"local-codex").read("thread/read",{threadId:"thread"}).thread.name,"live-29");
});

test("a queued native import rechecks its source immediately before execution",async t=>{
  const {history,storage}=await fixture(t);
  const revision=await history.revision("thread");
  storage.database.exec("BEGIN IMMEDIATE");
  const writing=history.observe("thread/name/updated",{threadId:"thread",threadName:"accepted-live"});
  let current=true;
  const importing=Promise.resolve(history.importResult("thread/read",{threadId:"thread"},{thread:{id:"thread",name:"retired-source"}},revision,undefined,false,()=>current));
  const rejected=assert.rejects(importing,HistoryNotStored);
  await new Promise(resolve=>setTimeout(resolve,30));current=false;storage.database.exec("COMMIT");
  await writing;await rejected;
  assert.equal((await history.read("thread/read",{threadId:"thread"})).thread.name,"accepted-live");
});

test("owner close drains operations already accepted by asynchronous handles",async t=>{
  const {worker,history,storage}=await fixture(t);
  const writing=history.observe("thread/name/updated",{threadId:"thread",threadName:"last-write"});
  const closing=worker.close();await writing;await closing;
  assert.equal(new ConversationHistory(storage.database,"local-codex").read("thread/read",{threadId:"thread"}).thread.name,"last-write");
  await assert.rejects(Promise.resolve().then(()=>history.hasThreads()),/closing/);
});

test("an unrelated stored read bypasses a blocked write, including a new logical handle",async t=>{
  const {storage,worker,history}=await fixture(t);
  await history.observe("thread/started",{thread:{id:"other",name:"Other",cwd:"/synthetic",createdAt:1,updatedAt:2}});
  storage.database.exec("BEGIN IMMEDIATE");
  const writing=Promise.resolve(history.observe("thread/name/updated",{threadId:"thread",threadName:"blocked"}));
  try {
    const other=worker.create("local-codex");
    const read=Promise.resolve(other.read("thread/read",{threadId:"other"}));
    const result=await Promise.race([read,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("unrelated read waited for writer")),500))]);
    assert.equal(result.thread.name,"Other");
    await other.close?.();
  } finally {storage.database.exec("COMMIT");await writing;}
});

test("a read on another handle waits for accepted writes to the same conversation",async t=>{
  const {storage,worker,history}=await fixture(t);
  const other=worker.create("local-codex");
  await other.read("thread/read",{threadId:"thread"});
  storage.database.exec("BEGIN IMMEDIATE");
  const writing=Promise.resolve(history.observe("thread/name/updated",{threadId:"thread",threadName:"new-name"}));
  let completed=false;
  const reading=Promise.resolve(other.read("thread/read",{threadId:"thread"})).then(value=>{completed=true;return value;});
  try {await new Promise(resolve=>setTimeout(resolve,40));assert.equal(completed,false);}
  finally {storage.database.exec("COMMIT");}
  await writing;assert.equal((await reading).thread.name,"new-name");
});

test("stored transport reads wait only for their conversation's accepted observations",async t=>{
  const {storage,history}=await fixture(t);
  await history.observe("thread/started",{thread:{id:"other",name:"Other",cwd:"/synthetic",createdAt:1,updatedAt:2}});
  await history.initialization({capabilities:{}});
  let listener:(frame:string)=>void=()=>{};
  const inner={status:{state:"open" as const},async connect(){},async close(){},async send(){},subscribeMessage(fn:typeof listener){listener=fn;return()=>{};},subscribeStatus(){return()=>{};}};
  const transport=new ConversationHistoryTransport(inner,history);await transport.connect();
  const replies:any[]=[];transport.subscribeMessage(frame=>replies.push(JSON.parse(frame)));
  await transport.send(JSON.stringify({id:1,method:"initialize",params:{}}));
  storage.database.exec("BEGIN IMMEDIATE");
  listener(JSON.stringify({method:"thread/name/updated",params:{threadId:"thread",threadName:"new-name"}}));
  let same:Promise<void>|undefined;
  try {
    const read=transport.send(JSON.stringify({id:2,method:"thread/read",params:{threadId:"other"}}));
    await Promise.race([read,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("transport waited for unrelated observation")),500))]);
    assert.equal(replies.find(r=>r.id===2)?.result.thread.name,"Other");
    same=transport.send(JSON.stringify({id:3,method:"thread/read",params:{threadId:"thread"}}));
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(replies.some(r=>r.id===3),false);
  }finally {storage.database.exec("COMMIT");if(same)await same;await transport.close();}
  assert.equal(replies.find(r=>r.id===3)?.result.thread.name,"new-name");
});

test("legacy preparation remains on the writer before a read-only snapshot is served",async t=>{
  const {storage,history}=await fixture(t);
  storage.database.prepare("UPDATE conversation_threads SET model_version=1 WHERE scope=? AND id=?").run("local-codex","thread");
  const result=await history.read("thread/read",{threadId:"thread"});
  assert.equal(result.thread.name,"Worker");
  assert.equal(storage.database.prepare("SELECT model_version FROM conversation_threads WHERE scope=? AND id=?").get("local-codex","thread")?.model_version,2);
});

test("a live observation registers its dependency before a yielding transport can serve another handle",async t=>{
  const {storage,worker,history}=await fixture(t);
  const other=worker.create("local-codex");await other.read("thread/read",{threadId:"thread"});
  let listener:(frame:string)=>void=()=>{};
  const inner={status:{state:"open" as const},async connect(){},async close(){},async send(){},subscribeMessage(fn:typeof listener){listener=fn;return()=>{};},subscribeStatus(){return()=>{};}};
  const transport=new ConversationHistoryTransport(inner,history);await transport.connect();
  await new Promise(resolve=>setTimeout(resolve,12));
  storage.database.exec("BEGIN IMMEDIATE");
  listener(JSON.stringify({method:"thread/name/updated",params:{threadId:"thread",threadName:"accepted-before-read"}}));
  let completed=false;
  const reading=Promise.resolve(other.read("thread/read",{threadId:"thread"})).then(value=>{completed=true;return value;});
  try {await new Promise(resolve=>setTimeout(resolve,40));assert.equal(completed,false,"new reader must observe the already accepted dependency");}
  finally {storage.database.exec("COMMIT");await transport.close();}
  assert.equal((await reading).thread.name,"accepted-before-read");
});


test("slow work distinguishes SQLite contention from dependency waiting",async t=>{
  const timings:HistoryWorkTiming[]=[];
  const {storage,history}=await fixture(t,timing=>timings.push(timing));
  storage.database.exec("BEGIN IMMEDIATE");
  const writing=Promise.resolve(history.observe("thread/name/updated",{threadId:"thread",threadName:"after-contention"}));
  const reading=Promise.resolve(history.read("thread/read",{threadId:"thread"}));
  try {await new Promise(resolve=>setTimeout(resolve,1100));}finally{storage.database.exec("COMMIT");}
  await writing;assert.equal((await reading).thread.name,"after-contention");
  assert.ok(timings.some(t=>t.phase==="worker" && !t.readOnly && Number(t.busyRetries)>0 && Number(t.busyWaitMs)>0));
  assert.ok(timings.some(t=>t.phase==="dependency" && t.readOnly && t.durationMs>=1000));
});

test("a failed scope initialization can be retried by a fresh logical handle",async t=>{
  const {storage,worker}=await fixture(t);
  storage.database.exec("BEGIN IMMEDIATE");
  const first=worker.create("initialization-retry");
  try {await assert.rejects(Promise.resolve(first.hasThreads()),/locked|busy/i);}
  finally{storage.database.exec("COMMIT");}
  assert.equal(await worker.create("initialization-retry").hasThreads(),false);
});


test("request timings pair concurrent replies and distinguish storage dependency from read execution", async t => {
  const { storage, history } = await fixture(t);
  await history.observe("thread/started", {thread:{id:"other",name:"Other",createdAt:1,updatedAt:2}});
  await history.initialization({capabilities:{}});
  const inner = {status:{state:"open" as const},async connect(){},async close(){},async send(){},subscribeMessage(){return()=>{};},subscribeStatus(){return()=>{};}};
  const events: any[] = [], replies: any[] = [];
  const transport = new ConversationHistoryTransport(inner, history, undefined, 100, undefined, undefined, event => {
    events.push(event);
    // A failing diagnostic sink cannot turn an acknowledged read into failure.
    throw new Error("sink unavailable");
  });
  await transport.connect();t.after(()=>transport.close());
  transport.subscribeMessage(frame=>replies.push(JSON.parse(frame)));
  await transport.send(JSON.stringify({id:1,method:"initialize",params:{}}));
  storage.database.exec("BEGIN IMMEDIATE");
  const write = history.observe("thread/name/updated", {threadId:"thread",threadName:"after-write"});
  const slow = transport.send(JSON.stringify({id:2,method:"thread/read",params:{threadId:"thread"}}));
  try {
    await transport.send(JSON.stringify({id:3,method:"thread/read",params:{threadId:"other"}}));
    assert.equal(replies.some(r=>r.id===2), false);
    await new Promise(resolve=>setTimeout(resolve,35));
  } finally { storage.database.exec("COMMIT"); }
  await write;await slow;
  const a = replies.find(r=>r.id===2).result.__opencraftGatewayTiming;
  const b = replies.find(r=>r.id===3).result.__opencraftGatewayTiming;
  assert.notEqual(a.gatewayPairId,b.gatewayPairId);
  const paired = events.find(e=>e.gatewayPairId===a.gatewayPairId);
  assert.equal(paired.outcome,"ok");
  assert(a.storageDependencyMs>=30,JSON.stringify(a));
  assert(b.storageDependencyMs<a.storageDependencyMs);
  assert(paired.storageExecuteMs>=0);assert(paired.storageQueueMs>=0);
  assert(paired.gatewaySerializeMs>=0);assert(paired.gatewayDeliverMs>=0);assert(paired.bytes>0);
  assert.equal(events.length,2);
  assert(!JSON.stringify(events).includes("after-write"));
  assert(!JSON.stringify(events).includes('"threadId"'));
});

test("native call boundaries separate source arrival, reply FIFO and import; background refresh is detached", async t => {
  const { history } = await fixture(t);
  await history.initialization({capabilities:{}});
  let onFrame: (frame:string)=>void = ()=>{};
  const gate = () => { let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; };
  const nativeStarted=gate(),releaseNative=gate(),importStarted=gate(),releaseImport=gate(),secondArrived=gate();
  const events:any[]=[],replies:any[]=[];
  const port = new Proxy(history, {get(target,key) {
    if(key==='importResult')return async (...args:any[])=>{
      if(args[0]==='thread/read' && args[1].threadId==='cold-a'){importStarted.resolve();await releaseImport.promise;}
      return (target.importResult as any)(...args);
    };
    return Reflect.get(target,key);
  }});
  const inner={status:{state:'open' as const},async connect(){},async close(){},
    async send(frame:string){const request=JSON.parse(frame);if(request.id===undefined)return;
      if(request.method==='thread/read' && request.params.threadId==='cold-a'){nativeStarted.resolve();await releaseNative.promise;}
      const result=request.method==='initialize'?{capabilities:{}}:{thread:{id:request.params.threadId,name:'private-source-title',createdAt:1,updatedAt:2,turns:[]}};
      onFrame(JSON.stringify({id:request.id,result}));
      if(request.params?.threadId==='cold-b')secondArrived.resolve();
    },subscribeMessage(fn:typeof onFrame){onFrame=fn;return()=>{};},subscribeStatus(){return()=>{};}};
  const transport=new ConversationHistoryTransport(inner,port,undefined,2000,undefined,undefined,event=>events.push(event));
  await transport.connect();t.after(()=>transport.close());
  transport.subscribeMessage(frame=>replies.push(JSON.parse(frame)));
  await transport.send(JSON.stringify({id:1,method:'initialize',params:{}}));
  const first=transport.send(JSON.stringify({id:2,method:'thread/read',params:{threadId:'cold-a'}}));
  await nativeStarted.promise;await new Promise(r=>setTimeout(r,35));releaseNative.resolve();
  await importStarted.promise;
  const second=transport.send(JSON.stringify({id:3,method:'thread/read',params:{threadId:'cold-b'}}));
  await secondArrived.promise;await new Promise(r=>setTimeout(r,35));releaseImport.resolve();
  await Promise.all([first,second]);
  const a=replies.find(r=>r.id===2).result.__opencraftGatewayTiming;
  const b=replies.find(r=>r.id===3).result.__opencraftGatewayTiming;
  const ca=events.find(e=>e.traceRole==='native-rpc'&&e.method==='thread/read'&&e.gatewayPairId===a.gatewayPairId);
  const cb=events.find(e=>e.traceRole==='native-rpc'&&e.method==='thread/read'&&e.gatewayPairId===b.gatewayPairId);
  assert(ca&&cb);assert.notEqual(ca.nativeCallId,cb.nativeCallId);
  assert(ca.nativeReplyWaitMs>=25,JSON.stringify(ca));
  assert(ca.nativeImportMs>=25,JSON.stringify(ca));
  assert(ca.nativeReplyProcessingMs>=ca.nativeImportMs,JSON.stringify(ca));
  assert(cb.nativeReceiveQueueMs>=25,JSON.stringify(cb));
  assert.equal(a.gatewayTimingVersion,2);
  assert(!JSON.stringify(events).includes('private-source-title'));
  // A cached read schedules an independently traced, causally linked revalidation.
  const before=events.filter(e=>e.kind==='dependency').length;
  await transport.send(JSON.stringify({id:4,method:'thread/read',params:{threadId:'cold-b'}}));
  await new Promise(r=>setTimeout(r,20));
  const background=events.find(e=>e.traceRole==='background-refresh');
  assert(background); assert.notEqual(background.traceId,events.find(e=>e.kind==='rpc'&&e.gatewayPairId===replies.find(r=>r.id===4).result.__opencraftGatewayTiming.gatewayPairId).traceId);
  assert(background.linkedTraceId); assert(events.filter(e=>e.kind==='dependency').length>before);
});


test("worker directory transitions and recovery pages stay on the requesting trace without leaking source cursors",async t=>{
  const {history}=await fixture(t);
  const {beginHistoryReadTiming,historyReadTiming}=await import("../../packages/app-host-server/src/history-read-timing.js");
  const {createRequestTrace}=await import("@opencraft/appserver-protocol");
  const metadata={id:"thread",name:"private-title",createdAt:1,updatedAt:2};
  await history.importResult("thread/list",{}, {data:[metadata],nextCursor:"private-next"},await history.catalogRevision());
  const cursor=(await history.read("thread/list",{limit:1})).nextCursor;
  await history.importResult("thread/list",{cursor:"private-next"},{data:[],nextCursor:null},await history.catalogRevision());
  assert.equal((await history.read("thread/list",{cursor,limit:1})).data.length,0);
  const transition=beginHistoryReadTiming();
  await historyReadTiming.run(transition,async()=>history.importResult("thread/list",{}, {data:[metadata],nextCursor:"private-reset"},await history.catalogRevision()));
  assert.equal(transition.details.directoryPriorState,"observed");assert.equal(transition.details.directoryState,"observed");assert.equal(transition.details.directoryImportPage,"head");
  await history.invalidateDirectory({});
  const events:any[]=[], replies:any[]=[],native:any[]=[];let onFrame=(frame:string)=>{};
  const inner={status:{state:"open" as const},async connect(){},async close(){},
    async send(frame:string){const req=JSON.parse(frame);if(req.id===undefined)return;native.push(req);
      const result=req.method==="initialize" ? {capabilities:{}} : {data:[],nextCursor:null};
      onFrame(JSON.stringify({id:req.id,result}));},subscribeMessage(fn:typeof onFrame){onFrame=fn;return()=>{};},subscribeStatus(){return()=>{};}};
  const transport=new ConversationHistoryTransport(inner,history,undefined,2000,undefined,undefined,e=>events.push(e));
  await transport.connect();t.after(()=>transport.close());transport.subscribeMessage(f=>replies.push(JSON.parse(f)));
  await transport.send(JSON.stringify({id:1,method:"initialize",params:{}}));
  const trace={...createRequestTrace("sidebar-catalog","auto-next-page"),pageIndex:4,attempt:1};
  await transport.send(JSON.stringify({id:2,method:"thread/list",params:{cursor,limit:1},__opencraftTrace:{...trace,secret:"private"}}));
  const root=events.find(e=>e.traceRole==="gateway-rpc");
  assert(root);assert.equal(root.traceId,trace.traceId);assert.equal(root.parentSpanId,trace.spanId);assert.equal(root.trigger,"auto-next-page");assert.equal(root.pageIndex,4);
  assert.equal(root.directoryCache,"miss");assert.equal(root.directoryMissReason,"unsynchronized-tail");assert.equal(root.directoryMode,"recover");
  assert.equal(root.directoryStart,"head");assert.equal(root.directoryCheckpoint,"absent");assert.equal(root.directoryPages,1);assert.equal(root.directoryStop,"cache-satisfied");
  const child=events.find(e=>e.traceRole==="native-rpc"&&e.method==="thread/list");
  assert(child);assert.equal(child.traceId,root.traceId);assert.equal(child.parentSpanId,root.spanId);assert.equal(child.directoryPriorState,"unknown");assert.equal(child.directoryState,"observed");
  assert(native.every(req=>!("__opencraftTrace" in req)));
  assert(!JSON.stringify(events).includes("private"));assert.equal(replies.find(r=>r.id===2).result.nextCursor,null);
});


test('worker committed notification runs under its original request cause',async t=>{
 const {history}=await fixture(t);const {historyReadTiming,beginHistoryReadTiming}=await import('../../packages/app-host-server/src/history-read-timing.js');
 const {createRequestTrace}=await import('@opencraft/appserver-protocol');const cause=beginHistoryReadTiming();cause.context=createRequestTrace('sidebar-catalog','initial-load');
 const seen:any[]=[];const stop=history.subscribeCommitted(()=>seen.push(historyReadTiming.getStore()?.context));
 try{await historyReadTiming.run(cause,()=>history.observe('thread/name/updated',{threadId:'thread',threadName:'changed'}));assert(seen.length);assert(seen.every(trace=>trace?.traceId===cause.context!.traceId));}
 finally{stop();}
});


test('real worker reports SQL calls, returned rows, thread CPU and fence rebuilds without parameters',async t=>{
 const {history}=await fixture(t);const {historyReadTiming,beginHistoryReadTiming}=await import('../../packages/app-host-server/src/history-read-timing.js');
 const {createRequestTrace}=await import('@opencraft/appserver-protocol');const {sanitizeEvent}=await import('../../packages/observability-contract/index.mjs');
 const rows=Array.from({length:150},(_,i)=>({id:'private-'+i,cwd:'/private',name:'private-title',createdAt:1,updatedAt:2}));
 await history.importResult('thread/list',{}, {data:rows,nextCursor:null},await history.catalogRevision());
 const trace=beginHistoryReadTiming();trace.context=createRequestTrace('sidebar-catalog','initial-load');trace.requestMethod='thread/list';const events:any[]=[];trace.sink=event=>events.push(event);
 await historyReadTiming.run(trace,async()=>{await history.directoryFence();await history.directoryFence();await history.read('thread/list',{limit:5});});
 assert.equal(trace.values.directoryFenceCalls,2);assert.equal(trace.values.directoryFenceRebuilds,1);assert.equal(trace.values.directoryFenceCacheHits,1);assert.equal(trace.values.directoryFenceRows,151);assert(trace.values.directoryFenceBytes>1000);
 assert(trace.values.storageSqlCalls>0);assert(trace.values.storageSqlRows>=151);assert(trace.values.storageSqlMs>=0);
 if(typeof process.threadCpuUsage==='function')assert(trace.values.storageWorkerCpuMs>0);
 const detail=events.find(e=>e.traceRole==='storage-work'&&e.storageOperation==='directoryFence');assert(detail);assert.equal(detail.parentSpanId,trace.context.spanId);assert.equal(detail.traceId,trace.context.traceId);assert(detail.sqlCalls>0);assert(detail.sqlRows>=151);
 assert(!JSON.stringify(events).includes('private'));assert(sanitizeEvent({schemaVersion:1,component:'gateway',producerId:'fixture',eventId:'fixture',at:100,...detail},100));assert(Buffer.byteLength(JSON.stringify(detail))<1536);
});


test("worker preserves directory observation epochs and fences an invalidated reply",async t=>{
 const {history:h}=await fixture(t);
 const row={id:"epoch-thread",cwd:"/synthetic",createdAt:1,updatedAt:2};
 await h.importResult("thread/list",{}, {data:[row],nextCursor:"native-private-cursor"},await h.catalogRevision());
 const epoch=await h.directoryEpoch({}),fence=await h.directoryFence();
 await h.invalidateDirectory({});
 assert.notEqual(await h.directoryEpoch({}),epoch);
 assert.equal(await h.importResult("thread/list",{}, {data:[{...row,name:"stale"}],nextCursor:null},await h.catalogRevision(),fence,false,()=>true,{epoch,fromHead:true}),false);
 const current=await h.directoryEpoch({});
 assert.equal(await h.importResult("thread/list",{}, {data:[row],nextCursor:null},await h.catalogRevision(),fence,false,()=>true,{epoch:current,fromHead:true}),true);
 await h.importResult("thread/list",{}, {data:[row],nextCursor:"another-private-cursor"},await h.catalogRevision(),undefined,false,()=>true,{epoch:current,fromHead:true});
 const saved=await h.read("thread/list",{});assert.equal(saved.historyCoverage.state,"observed");assert.equal(saved.nextCursor,null);
 assert(!JSON.stringify(saved.historyCoverage).includes("private-cursor"));
});


test("worker retains reconciliation intent until a successful current-epoch scan observes EOF",async t=>{
 const {history:h}=await fixture(t);const row={id:"reconcile-worker",cwd:"/synthetic",createdAt:1,updatedAt:2};
 await h.importResult("thread/list",{}, {data:[row],nextCursor:null},await h.catalogRevision());
 const old=await h.directoryState({});assert(Number.isFinite(old.observedAt));
 await h.invalidateDirectory({},undefined,true);const pending=await h.directoryState({});assert.equal(pending.reconciling,true);assert.notEqual(pending.epoch,old.epoch);
 await h.importResult("thread/list",{}, {data:[row],nextCursor:null},await h.catalogRevision(),await h.directoryFence(),false,()=>true,{epoch:pending.epoch,fromHead:true});
 const done=await h.directoryState({});assert.equal(done.reconciling,false);assert.equal(done.observed,true);assert(done.observedAt>=old.observedAt);
});

test("source retirement and cursor invalidation preserve unfinished reconciliation intent",async t=>{
 const {history:h}=await fixture(t);
 await h.importResult("thread/list",{}, {data:[{id:"legacy",cwd:"/synthetic",createdAt:1,updatedAt:2}],nextCursor:null},await h.catalogRevision());
 await h.invalidateDirectory({},undefined,true);const pending=await h.directoryState({});
 await h.invalidateDirectory();const retired=await h.directoryState({});
 assert.notEqual(retired.epoch,pending.epoch);assert.equal(retired.observed,false);assert.equal(retired.reconciling,true);
 await h.invalidateDirectory({});const restarted=await h.directoryState({});
 assert.notEqual(restarted.epoch,retired.epoch);assert.equal(restarted.reconciling,true);
 assert.equal((await h.read("thread/list",{limit:1})).data.length,1);
});
