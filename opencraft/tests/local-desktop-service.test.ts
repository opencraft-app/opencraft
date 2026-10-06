import assert from "node:assert/strict";
import test from "node:test";
import { createServer, connect } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { LocalDesktopService, type LocalDesktopOwner } from "../apps/local-agent-host/src/desktop/local-desktop-service.js";
import type { NativeControlLease } from "../apps/local-agent-host/src/desktop/native-control.js";

test("desktop access is explicitly advertised without enabling input", () => {
  const registration = { serverId: "server", environmentId: "machine", principalId: "owner",
    observer: { inspect: async () => "a".repeat(64), open: async () => { throw new Error("no stream"); } } };
  for (const transport of ["same-origin-loopback", "same-origin-trusted-internal"] as const) {
    const service = new LocalDesktopService({ ...registration, transport });
    try { assert.deepEqual(service.capability(), { version: 1, observe: true, control: false, transport,
      serverId: "server", environmentId: "machine", principalId: "owner", renewable: true }); }
    finally { service.close(); }
  }
});

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
  let opens=0, incarnation="a".repeat(64);
  const service=new LocalDesktopService({serverId:"server-1",environmentId:"machine-1",principalId:"local-user",
    observer:{inspect:async()=>incarnation,open:async()=>{opens++;const s=connect(port,"127.0.0.1");s.pause();await new Promise<void>(resolve=>s.once("connect",resolve));return s;}}});
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
  t.mock.timers.enable({apis:["Date"],now:next.expiresAt-30_000});
  const readsBefore=f.reads.length;
  second.socket.send(JSON.stringify({event:"desktop/renew",requestId:"1"}));
  await wait(()=>second.frames.some(frame=>!frame.binary&&JSON.parse(frame.text).event==="desktop/renewed"));
  const receipt=second.frames.find(frame=>!frame.binary&&JSON.parse(frame.text).event==="desktop/renewed")!;
  assert.deepEqual(JSON.parse(receipt.text),{event:"desktop/renewed",requestId:"1",expiresAt:Date.now()+300_000});
  assert.equal(f.reads.length,readsBefore+2,"renewal rechecks the authoritative Thread on both sides of observer inspection");
  assert.equal(opens,2,"renewal neither reopens media nor reacquires control");
  service.release("wrong-owner",next.attachmentId);assert.equal(second.socket.readyState,1);
  service.release(f.owner.key,grant.attachmentId);await first.closed;assert.equal(second.socket.readyState,1);
  incarnation="b".repeat(64);
  second.socket.send(JSON.stringify({event:"desktop/renew",requestId:"2"}));
  await second.closed;
  assert.equal(second.frames.filter(frame=>!frame.binary&&JSON.parse(frame.text).event==="desktop/renewed").length,1,
    "a new physical desktop cannot renew an earlier attachment");
  const stale=await service.prepare(f.owner,"thread-1");f.replace();const rejected=await viewer(stale);await rejected.closed;assert.equal(opens,2);
});

test("control has one owner, confirms after binding checks, fences late grants and releases on disconnect", async t => {
  const tcp = createServer(socket => { socket.write("RFB 003.008\n"); socket.on("data", bytes => socket.write(bytes)); });
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve)); t.after(() => tcp.close());
  const f = fixture(); f.service.close();
  const inputs: unknown[] = [], grants: { lease: NativeControlLease; valid: boolean }[] = [];
  let complete: (() => void) | undefined, delay = false;
  const service = new LocalDesktopService({ serverId: "server", environmentId: "machine", principalId: "user",
    observer: { inspect: async () => "a".repeat(64), open: async () => {
      const stream = connect((tcp.address() as { port: number }).port, "127.0.0.1"); stream.pause();
      await new Promise<void>(resolve => stream.once("connect", resolve)); return stream;
    } }, control: { inspect: async () => "a".repeat(64), async acquire(_incarnation, signal) {
      const record = { valid: true, lease: undefined as unknown as NativeControlLease };
      const listeners = new Set<() => void>();
      record.lease = { isValid: () => record.valid,
        subscribeRevoked: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        release() { if (!record.valid) return; record.valid = false; for (const listener of listeners) listener(); },
        key: (symbol, down) => inputs.push([symbol, down]), pointer: () => inputs.push("pointer") };
      if (delay) await new Promise<void>(resolve => { complete = resolve; });
      // Deliberately late/uncancellable transport: service must reconcile itself.
      if (!delay) signal.addEventListener("abort", () => record.lease.release(), { once: true });
      grants.push(record); return record.lease;
    } } });
  t.after(() => service.close()); assert.equal(service.capability().control, true);
  const sockets = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => sockets.once("listening", resolve));
  sockets.on("connection", socket => service.accept(socket)); t.after(() => sockets.close());
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate());
  };
  const viewer = async () => {
    const credential = await service.prepare(f.owner, "thread-1");
    const socket = new WebSocket(`ws://127.0.0.1:${(sockets.address() as { port: number }).port}`);
    const messages: any[] = [];
    socket.on("message", (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
    await new Promise<void>(resolve => socket.once("open", resolve));
    socket.send(JSON.stringify({ event: "desktop/attach", version: 1, attachmentId: credential.attachmentId, ticket: credential.ticket }));
    await wait(() => messages.some(message => message.event === "desktop/ready"));
    socket.send(Buffer.from("RFB 003.008\n\x01\x01"));
    return { socket, messages, send(event: string, requestId: string) { socket.send(JSON.stringify({ event, requestId })); } };
  };
  const first = await viewer(), second = await viewer();
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
  first.socket.send(key); await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(inputs, []);
  first.send("control/request", "1"); await wait(() => first.messages.some(m => m.event === "control/locked"));
  second.send("control/request", "1"); await wait(() => second.messages.some(m => m.event === "control/denied"));
  second.socket.send(key); first.socket.send(key); await wait(() => inputs.length === 1);
  assert.deepEqual(inputs, [[97, true]]);
  const granted=grants[0]!.lease;
  first.send("desktop/renew", "4"); await wait(()=>first.messages.some(m=>m.event==="desktop/renewed"));
  assert.equal(grants.length,1);assert.equal(grants[0]!.lease,granted);assert.equal(granted.isValid(),true);
  second.send("control/release", "1"); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(grants[0]!.valid, true);
  first.send("control/release", "1"); await wait(() => !grants[0]!.valid);
  delay = true; second.send("control/request", "2"); await wait(() => !!complete);
  second.send("control/release", "2"); await new Promise(resolve => setTimeout(resolve, 10)); complete!();
  await wait(() => grants.length === 2 && !grants[1]!.valid);
  assert.ok(!second.messages.some(m => m.event === "control/locked" && m.requestId === "2"));
  delay = false; second.send("control/request", "3"); await wait(() => second.messages.some(m => m.event === "control/locked"));
  // Lease remains usable beyond the preparation timeout, not a five-second grant.
  await new Promise(resolve => setTimeout(resolve, 5100)); assert.equal(grants[2]!.valid, true);
  const closed = new Promise<void>(resolve => second.socket.once("close", () => resolve())); second.socket.close(); await closed;
  await wait(() => !grants[2]!.valid); first.socket.close();
});
