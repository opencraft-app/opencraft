import test from "node:test";
import assert from "node:assert/strict";
import {createRequestTrace,parseRequestTrace,parseJsonRpcMessage,encodeJsonRpcMessage} from "@opencraft/appserver-protocol";
import {JsonRpcAppServerClient} from "@opencraft/appserver-client";
import {MemoryTransport} from "@opencraft/appserver-transport-memory";

test("diagnostic traces are bounded, projected, and optional in a JSON-RPC envelope",()=>{
 const root=createRequestTrace("sidebar-catalog","initial-load"),child=createRequestTrace("sidebar-catalog","auto-next-page",root);
 assert.equal(child.traceId,root.traceId);assert.equal(child.parentSpanId,root.spanId);assert.notEqual(child.spanId,root.spanId);
 assert.deepEqual(parseRequestTrace({...child,params:"private"}),child);
 for(const bad of [{traceId:"0".repeat(32)},{spanId:"bad"},{caller:"private"},{trigger:"secret"},{pageIndex:-1},{linkedTraceId:root.traceId}]) assert.equal(parseRequestTrace({...child,...bad}),undefined);
 const message={id:1,method:"thread/list",params:{limit:1},__opencraftTrace:child};
 assert.deepEqual(parseJsonRpcMessage(encodeJsonRpcMessage(message)),message);
 assert.deepEqual(parseJsonRpcMessage(JSON.stringify({...message,__opencraftTrace:{traceId:"bad"}})),{id:1,method:"thread/list",params:{limit:1}});
});
for(const supported of [false,true]) test(`client negotiates the trace envelope; supported=${supported}`,async()=>{
 const seen:any[]=[],events:any[]=[];
 const transport=new MemoryTransport({server:{receive(frame,peer){const request=JSON.parse(frame);if(request.id===undefined)return;seen.push(request);peer.send(JSON.stringify({id:request.id,result:request.method==="initialize"
   ? {capabilities:{extensions:supported ? {"opencraft/request-trace":{version:1}} : {}}} : {data:[],nextCursor:null}}));}}});
 const client=new JsonRpcAppServerClient({hostId:"fixture",transport});client.subscribeRequestLifecycle(e=>events.push(e));
 try {await client.connect({clientInfo:{name:"fixture",version:"1"}});
   const trace=createRequestTrace("sidebar-catalog","auto-next-page");
   await client.request("thread/list",{limit:1},{trace});
   assert.deepEqual(seen.at(-1).params,{limit:1});
   assert.deepEqual(seen.at(-1).__opencraftTrace,supported ? trace : undefined);
   assert.deepEqual(events.find(e=>e.type==="started"&&e.method==="thread/list").trace,trace);
 } finally {await client.close();}
});


test("notification stamps and request causes are projected with a closed vocabulary",async()=>{
 const {createNotificationObservation,parseNotificationObservation,compactRequestTrace,notificationTraceFields}=await import("@opencraft/appserver-protocol");
 const cause=createRequestTrace("server-refresh","cache-refresh");
 const stamp=createNotificationObservation("opencraft/thread-catalog/changed",{revision:2,change:{type:"invalidate"},source:"private"},"history-storage",cause)!;
 assert.equal(stamp.notificationSource,"history-storage");assert.equal(stamp.notificationChange,"invalidate");assert.equal(stamp.notificationCauseTraceId,cause.traceId);
 assert.deepEqual(parseNotificationObservation({...stamp,threadId:"private"}),stamp);
 for(const bad of [{notificationId:"private"},{notificationMethod:"private"},{notificationSource:"private"},{notificationChange:"private"}])assert.equal(parseNotificationObservation({...stamp,...bad}),undefined);
 const frame={method:"opencraft/thread-catalog/changed",params:{},__opencraftNotification:stamp};assert.deepEqual(parseJsonRpcMessage(JSON.stringify(frame)),frame);
 assert(!("__opencraftNotification" in parseJsonRpcMessage(JSON.stringify({...frame,method:"thread/started"}))));
 const trace={...createRequestTrace("sidebar-catalog","catalog-notification"),...stamp,notificationDecision:"cancel-and-refetch" as const,notificationCount:7,notificationToInvalidateMs:1.23456};
 assert.equal(parseRequestTrace(trace)?.notificationId,stamp.notificationId);assert.equal(notificationTraceFields(trace).notificationCount,7);
 const summary=compactRequestTrace(trace);assert.equal(summary.notificationMethod,stamp.notificationMethod);assert(!("notificationCauseTraceId" in summary));assert(!("notificationCount" in summary));
});


test('expanded gateway diagnostics retain identity and timing inside the producer budget',async()=>{
 const {roundedHistoryDiagnostic}=await import('../../packages/app-host-server/src/history-read-timing.js');
 const {sanitizeEvent}=await import('../../packages/observability-contract/index.mjs');
 const event:any={kind:'rpc',method:'thread/list',outcome:'ok',measurementScope:'rpc',traceId:'1'.repeat(32),spanId:'2'.repeat(16),caller:'sidebar-catalog',trigger:'catalog-notification',traceRole:'gateway-rpc',gatewayPairId:'11111111-1111-4111-8111-111111111111',catalogId:'3'.repeat(32),directoryId:'11111111-1111-4111-8111-111111111111',notificationId:'4'.repeat(32),notificationMethod:'opencraft/thread-catalog/changed',notificationSource:'history-storage',notificationChange:'invalidate',notificationDecision:'cancel-and-refetch',directoryCache:'miss',directoryMode:'recover',directoryStart:'head',directoryCheckpoint:'absent',directoryMissReason:'unsynchronized-tail',directoryPriorState:'observed',directoryState:'partial',directoryImportPage:'head',directoryStop:'cache-satisfied',linkedTraceId:'7'.repeat(32),linkedSpanId:'8'.repeat(16),parentSpanId:'9'.repeat(16),gatewayIngressAt:1234567890123,gatewayReplyAt:1234567899123,gatewayIngressQueueMs:0.23456789,gatewayRpcAccessMs:12.12345678,gatewayIngressToReadMs:13.123456789,gatewayIngressToReplyMs:9000.123456789,durationMs:8987.123456789,pageIndex:13,attempt:1};
 for(const key of ['historyProjectionMs','historyCoreMs','historyQueueMs','historyNativeRpcMs','gatewayDependencyMs','gatewayInitializeMs','storageAuthorizeMs','storageBusyRetries','storageBusyMs','storageDependencyMs','storageExecuteMs','storageQueueMs','gatewaySerializeMs','gatewayDeliverMs'])event[key]=1234.123456789;
 const rounded=roundedHistoryDiagnostic(event);assert(Buffer.byteLength(JSON.stringify(rounded))<=1536);assert(Number(rounded.diagnosticTrimmed)>0);
 assert.equal(rounded.gatewayIngressToReplyMs,9000.123);assert.equal(rounded.notificationId,event.notificationId);assert.equal(rounded.traceId,event.traceId);
 const full={schemaVersion:1,eventId:'5'.repeat(32),producerId:'6'.repeat(32),component:'gateway',at:100,...rounded};assert(sanitizeEvent(full,100));assert(Buffer.byteLength(JSON.stringify(full))<2048);
});
