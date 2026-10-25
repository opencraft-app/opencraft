import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function result(threadId:string,tag:string) {
 const turn={id:`turn-${tag}`,status:"completed",itemsView:"full",items:[{id:`item-${tag}`,type:"agentMessage",text:tag,phase:"final_answer"}],error:null};
 return {thread:{id:threadId,sessionId:threadId,name:threadId,path:`/rollouts/${threadId}`,cwd:"/workspace",historyMode:"paginated",status:{type:"idle"},turns:[]},
  initialTurnsPage:{data:[turn],nextCursor:null},turnsBackwardsCursor:null,itemsBackwardsCursor:null};
}

test("logical Host reconnect reads a fresh baseline before a retired same-generation history reply",{timeout:5000},async()=>{
 let firstReply:(()=>void)|undefined,initializations=0,connects=0,closes=0;
 const reads=new Map<string,number>(),methods:string[]=[];
 const transport=new MemoryTransport({receive(frame,peer){
  const request=parseJsonRpcMessage(frame);if(!isJsonRpcRequest(request))return;
  methods.push(request.method);
  const send=(value:unknown)=>peer.send(encodeJsonRpcMessage({id:request.id,result:value}));
  if(request.method==="initialize") {initializations++;send({codexHome:"/fixture",platformFamily:"unix",platformOs:"linux",userAgent:"hydration-cancel"});}
  else if(request.method==="thread/read") {
   const id=(request.params as {threadId:string}).threadId,count=(reads.get(id)??0)+1;reads.set(id,count);
   if(id==="a" && count===1)firstReply=()=>send(result(id,"retired-baseline-v1"));
   else send(result(id,id==="a"?"fresh-baseline-v2":`peer-${count}`));
  }else if(request.method.endsWith("/list"))send({data:[],nextCursor:null});
  else send({});
 }});
 const connect=transport.connect.bind(transport),close=transport.close.bind(transport);
 transport.connect=signal=>{connects++;return connect(signal);};transport.close=async()=>{closes++;await close();};
 const runtime=createAppServerWorkbenchRuntime({hostId:"hydration-cancel",transport,autoReconnect:false,requestTimeoutMs:60_000,onRecoveryEvent(){}});
 try {
  await runtime.connect();const a=await runtime.acquireThread("a");a.setRecoveryVisibility(true);
  for(let i=0;i<20 && !firstReply;i++)await flush();assert.ok(firstReply);assert.equal(reads.get("a"),1);
  const b=await runtime.acquireThread("b");b.setRecoveryVisibility(true);
  for(let i=0;i<20 && !b.getSnapshot().authoritative;i++)await flush();assert.equal(b.getSnapshot().authoritative,true);
  const generation=runtime.getSnapshot().connectionGeneration;
  await runtime.reconnect();
  for(let i=0;i<30 && (reads.get("a")!==2 || !a.getSnapshot().authoritative || !b.getSnapshot().authoritative);i++)await flush();
  assert.equal(runtime.getSnapshot().phase,"ready");assert.equal(runtime.getSnapshot().connectionGeneration,generation);
  assert.equal(initializations,1);assert.equal(connects,1);assert.equal(closes,0,"history cancellation must preserve the healthy physical transport");
  assert.equal(reads.get("a"),2,"new recovery must not wait for the retired read's response");
  assert.equal(a.getSnapshot().authoritative,true);assert.equal(b.getSnapshot().authoritative,true);
  assert.match(JSON.stringify(a.getSnapshot()),/fresh-baseline-v2/);
  firstReply();for(let i=0;i<6;i++)await flush();
  assert.doesNotMatch(JSON.stringify(a.getSnapshot()),/retired-baseline-v1/);
  assert.equal(b.getSnapshot().authoritative,true);assert.equal(closes,0);
  assert.equal(methods.includes("turn/start"),false);assert.equal(methods.includes("thread/resume"),false);
  a.release();b.release();
 }finally{firstReply?.();await runtime.dispose();}
});
