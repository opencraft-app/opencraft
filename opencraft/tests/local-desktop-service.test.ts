import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { LocalDesktopService, type LocalDesktopOwner } from "../apps/local-agent-host/src/desktop/local-desktop-service.js";

function fixture() {
  let current = true, native = { id: "thread-1", path: "/workspace/rollout.jsonl", createdAt: 123 };
  const reads: string[] = [];
  const owner: LocalDesktopOwner = { key: "server-created-client-epoch", isCurrent: () => current,
    async readThread(id) { reads.push(id); if(id!==native.id) throw new Error("not found"); return {...native}; } };
  const service = new LocalDesktopService({ serverId: "server-1", environmentId: "machine-1", principalId: "local-user",
    observer: { inspect: async () => "a".repeat(64), open: async () => { throw new Error("no stream"); } } });
  return { service, owner, reads, revoke() {current=false;service.revoke(owner.key);},
    replace() {native={...native,createdAt:456};} };
}
test("local binding is constructed from backend registration and actual Thread", async () => {
  const f=fixture(); try {
    const grant=await f.service.prepare(f.owner,"thread-1");
    assert.equal(grant.target.serverId,"server-1");assert.equal(grant.target.principalId,"local-user");
    assert.equal(grant.instanceId,"machine-1");assert.notEqual(grant.preparationGenerationId,grant.incarnation);
    assert.deepEqual(f.reads,["thread-1","thread-1"]);
    await assert.rejects(f.service.prepare(f.owner,"forged-thread"));
    f.revoke();await assert.rejects(f.service.prepare(f.owner,"thread-1"));
  } finally {f.service.close();}
});
test("late Thread/observer results cannot create grants after owner retirement", async () => {
  const f=fixture();let complete!:()=>void;
  const original=f.owner.readThread;
  f.owner.readThread=async id=>{await new Promise<void>(resolve=>complete=resolve);return original(id);};
  const issued=f.service.prepare(f.owner,"thread-1");await new Promise(resolve=>setImmediate(resolve));
  f.revoke();complete();await assert.rejects(issued);f.service.close();
});
test("cancelled metadata read terminates promptly even when engine is delayed", async () => {
  const f=fixture();f.owner.readThread=()=>new Promise(()=>{});
  const abort=new AbortController(),pending=f.service.prepare(f.owner,"thread-1",abort.signal);
  abort.abort();await assert.rejects(pending);f.service.close();
});
test("per-owner budget includes concurrently preparing grants", async () => {
  const f=fixture();f.owner.readThread=()=>new Promise(()=>{});
  const abort=new AbortController();const pending=Array.from({length:4},()=>f.service.prepare(f.owner,"thread-1",abort.signal));
  const settled=Promise.allSettled(pending);
  await assert.rejects(f.service.prepare(f.owner,"thread-1"));abort.abort();await settled;f.service.close();
});

test("local one-use viewer streams independently, rechecks native metadata and revokes only itself", async t => {
  const tcp=createServer(socket=>{socket.write("RFB 003.008\n");socket.on("data",bytes=>socket.write(bytes));});
  await new Promise<void>(resolve=>tcp.listen(0,"127.0.0.1",resolve));
  const port=(tcp.address() as {port:number}).port;
  t.after(()=>tcp.close());
  const f=fixture();f.service.close();
  let opens=0;
  const service=new LocalDesktopService({serverId:"server-1",environmentId:"machine-1",principalId:"local-user",
    observer:{inspect:async()=>"a".repeat(64),open:async()=>{opens++;const s=connect(port,"127.0.0.1");s.pause();await new Promise<void>(resolve=>s.once("connect",resolve));return s;}}});
  t.after(()=>service.close());
  const sockets=new WebSocketServer({host:"127.0.0.1",port:0,maxPayload:1<<20});
  await new Promise<void>(resolve=>sockets.once("listening",resolve));
  sockets.on("connection",socket=>service.accept(socket));t.after(()=>sockets.close());
  const endpoint=`ws://127.0.0.1:${(sockets.address() as {port:number}).port}`;
  const viewer=async(credential:Awaited<ReturnType<typeof service.prepare>>)=>{
    const socket=new WebSocket(endpoint);const frames:{text:string,bytes:Buffer,binary:boolean}[]=[];
    socket.on("message",(data,binary)=>frames.push({text:data.toString(),bytes:Buffer.from(data as Buffer),binary}));
    await new Promise<void>(resolve=>socket.once("open",resolve));
    const closed=new Promise<void>(resolve=>socket.once("close",()=>resolve()));
    socket.send(JSON.stringify({event:"desktop/attach",version:1,attachmentId:credential.attachmentId,ticket:credential.ticket}));
    return {socket,frames,closed};
  };
  const grant=await service.prepare(f.owner,"thread-1");const first=await viewer(grant);
  const wait=async(predicate:()=>boolean)=>{for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(predicate());};
  await wait(()=>first.frames.length===2);
  assert.equal(JSON.parse(first.frames[0]!.text).controlAvailable,false);assert.equal(first.frames[1]!.text,"RFB 003.008\n");
  first.socket.send(Buffer.from([0,1,2,255]));await wait(()=>first.frames.length===3);assert.deepEqual(first.frames[2]!.bytes,Buffer.from([0,1,2,255]));
  const replay=await viewer(grant);await replay.closed;assert.equal(opens,1);
  const next=await service.prepare(f.owner,"thread-1");const second=await viewer(next);await wait(()=>second.frames.length===2);
  service.release("wrong-owner",next.attachmentId);assert.equal(second.socket.readyState,1);
  service.release(f.owner.key,grant.attachmentId);await first.closed;assert.equal(second.socket.readyState,1);
  const stale=await service.prepare(f.owner,"thread-1");f.replace();const rejected=await viewer(stale);await rejected.closed;assert.equal(opens,2);
  service.revoke(f.owner.key);await second.closed;
});
