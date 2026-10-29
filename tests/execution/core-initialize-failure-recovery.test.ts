import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { AppHostServer } from "@opencraft/app-host-server";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import { coreRouterRelayFixture } from "../fixtures/core-router-relay";

for(const failure of ["occupied-lane","initialized-notification"] as const) test(`Headless AppHost recovers initial ${failure} failure without restarting router`, async () => {
 const f=await coreRouterRelayFixture();
 let failNotification=failure==="initialized-notification";
 const engine=new CodexEngineAdapter({dataDirectory:f.hostDataDirectory,runtimeDirectory:f.root,executable:process.execPath,coreEndpoint:f.endpoint,coreAuthToken:f.token,coreHostOverlays:true,logDiagnostic:()=>{},decorateNativeTransport:native=>({
  get status(){return native.status;},connect:s=>native.connect(s),close:()=>native.close(),subscribeMessage:l=>native.subscribeMessage(l),subscribeStatus:l=>native.subscribeStatus(l),
  send:async frame=>{if(failNotification&&JSON.parse(frame).method==="initialized"){failNotification=false;throw Error("synthetic initialized notification write failure");}await native.send(frame);}
 })});
 const app=new AppHostServer({physicalHostLifetime:"server",logicalClientRouting:true,createTransport:()=>engine});
 const http=createServer(),wss=new WebSocketServer({server:http}),connections:WebSocket[]=[];
 wss.on("connection",socket=>{
  connections.push(socket);
  app.accept({postMessage:m=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));},subscribe:l=>{const handler=(raw:unknown)=>l(JSON.parse(String(raw)));socket.on("message",handler);return()=>socket.off("message",handler);},start(){},close(){socket.close();}},"synthetic-view");
 });
 await new Promise<void>(r=>http.listen(0,"127.0.0.1",r));
 const socket=new WebSocket(`ws://127.0.0.1:${(http.address() as import("node:net").AddressInfo).port}/apphost`);
 const opened=new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
 const pending=new Map<string,{resolve:(value:any)=>void,reject:(reason:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
 socket.on("message",raw=>{let m=JSON.parse(String(raw));const key=m.type==="host/frame"?(m=JSON.parse(m.frame)).id:m.requestId??m.type;const p=pending.get(key);if(p){pending.delete(key);clearTimeout(p.timer);p.resolve(m);}});
 const request=(key:string,message:unknown)=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(key);reject(Error("Headless RPC timeout: "+key));},5000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify(message));});
 let generation:number;
 const rpc=(id:string,method:string)=>request(id,{type:"host/send",requestId:"send-"+id,hostId:"local-codex",leaseId:"view-lease",generation,frame:JSON.stringify({id,method,params:{}})});
 const releaseOld=()=>f.releaseOld();
 try {
  if(failure==="initialized-notification")await releaseOld();
  await opened;
  await request("ready",{type:"hello",protocolVersion:2,rendererId:"synthetic-view"});
  const connected=await request("connect",{type:"host/connect",requestId:"connect",hostId:"local-codex",leaseId:"view-lease"});generation=connected.result.generation;
  const first=await rpc("initial","initialize");assert.ok(first.error,"the controlled initial handshake must fail");
  if(failure==="occupied-lane")assert.ok([-32081,-32082].includes(first.error.code));else assert.equal(first.error.code,-32000);
  await releaseOld();
  for(let n=0;n<300&&engine.status.state!=="open";n++)await new Promise(r=>setTimeout(r,10));
  const next=await rpc("recovered","initialize");assert.equal(next.error,undefined,"a failed initialize must retire its router socket and recover without restarting the router");
  assert.equal(next.result.capabilities.extensions["opencraft/read-history"].itemDetails,true);
  const listed=await rpc("list","thread/list");assert.equal(listed.error,undefined);assert.ok(Array.isArray(listed.result.data));
  assert.equal(f.calls.filter(c=>c==="initialize").length,1,"relay retains the real native initialization across Host recovery");
 }finally{
  for(const p of pending.values())clearTimeout(p.timer);socket.terminate();for(const c of connections)c.terminate();await app.close();wss.close();await new Promise<void>(r=>http.close(()=>r()));await engine.close();await f.close();
 }
});
