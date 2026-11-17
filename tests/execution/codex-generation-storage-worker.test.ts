import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer, get } from "node:http";
import { GenerationRegistryWorker } from "../../apps/codex-core/src/generation-registry-worker.js";
import { CodexRouterOwner } from "../../apps/codex-core/src/router-owner.js";
const pause = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
async function forbidMainSql(work:()=>Promise<void>) {
  const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;
  const probe=new DatabaseSync(":memory:"),statement=probe.prepare("SELECT 1"),prototype=Object.getPrototypeOf(statement);
  const methods=new Map(["get","all","run","iterate"].map(key=>[key,prototype[key]]));probe.close();
  const forbidden=()=>{throw Error("SQLite executed on router network thread");};
  DatabaseSync.prototype.prepare=forbidden;DatabaseSync.prototype.exec=forbidden;for(const key of methods.keys())prototype[key]=forbidden;
  try {await work();} finally {DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;for(const [key,value] of methods)prototype[key]=value;}
}
test("registry startup, route reads, lease commits and shutdown execute no main-thread SQL",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-worker-"));
  try {await forbidMainSql(async()=>{
    const registry=await GenerationRegistryWorker.open(directory);
    const owner=new CodexRouterOwner(registry);await owner.ready;
    try {
      await registry.register({id:"a",endpoint:join(directory,"a/control.sock"),runtimeDataDirectory:join(directory,"a/data"),executable:process.execPath,bundle:process.argv[1]!,node:process.execPath,cwd:directory});
      await registry.ready("a");await registry.activate("a",0);const route=await registry.discover("thread","a");
      for(let i=0;i<100;i++){assert.equal(registry.valid(route),true);assert.equal((await registry.discover("thread","a")).admissionEpoch,1);}
      const leases=await Promise.all(Array.from({length:12},()=>owner.enter(false,{generationId:"a",incarnation:1,threadId:"thread"})));
      assert.equal(owner.snapshot().activeCalls,12);assert.equal(owner.snapshot().pending?.length,12);
      await Promise.all(leases.map(async lease=>{await lease.update({nativeRequestId:"request:"+lease.id});await lease.sent();await lease();}));
      assert.equal(owner.snapshot().activeCalls,0);assert.deepEqual(owner.snapshot().pending,[]);
      for(const lease of leases)assert.equal((registry.metadata(`router-lease:${lease.id}`) as any).phase,"released");
    }finally{await owner.dispose();await owner.drain();await registry.close();}
  });}finally{await rm(directory,{recursive:true,force:true});}
});
test("real registry writer lock stalls only Worker while network and committed projection stay live",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"router-lock-")),registry=await GenerationRegistryWorker.open(directory);
  const locker=new DatabaseSync(join(directory,"codex-generations.sqlite"));
  const server=createServer((_request,response)=>response.end("ok"));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));locker.close();await registry.close();await rm(directory,{recursive:true,force:true});});
  await registry.setMetadata("commit","before");locker.exec("BEGIN IMMEDIATE");let settled=false;
  const writing=registry.setMetadata("commit","after").finally(()=>{settled=true;});
  try {
    for(let i=0;i<12;i++){
      await new Promise<void>((resolve,reject)=>get(`http://127.0.0.1:${(server.address() as any).port}`,response=>{assert.equal(response.statusCode,200);response.resume();response.once("end",resolve);}).once("error",reject));
      assert.equal(registry.metadata("commit"),"before");await pause(10);
    }
    assert.equal(settled,false,"ACK and projection cannot precede durable commit");
  }finally{locker.exec("ROLLBACK");}
  await writing;assert.equal(registry.metadata("commit"),"after");
});
test("Worker failure rejects queued writes, never falls back, and reopening recovers committed state",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-worker-failure-")),registry=await GenerationRegistryWorker.open(directory);
  try{
    await registry.setMetadata("durable",{id:"keep"});
    await (registry as any).worker.terminate();
    await forbidMainSql(async()=>{await assert.rejects(registry.setMetadata("durable",{id:"replace"}),/exited/);});
    await registry.close().catch(()=>{});
    const reopened=await GenerationRegistryWorker.open(directory);
    try{assert.deepEqual(reopened.metadata("durable"),{id:"keep"});}finally{await reopened.close();}
  }finally{await registry.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});
test("close drains accepted FIFO writes and rejects later admissions",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-drain-")),registry=await GenerationRegistryWorker.open(directory);
  try{
    const writes=[registry.setMetadata("order",1),registry.setMetadata("order",2),registry.setMetadata("order",3)];
    await registry.close();await Promise.all(writes);await assert.rejects(registry.setMetadata("order",4),/closing|exited/);
    const reopened=await GenerationRegistryWorker.open(directory);try{assert.equal(reopened.metadata("order"),3);}finally{await reopened.close();}
  }finally{await registry.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});

import {WebSocketServer} from "ws";
import {GenerationPeer} from "../../apps/codex-core/src/generation-peer.js";
async function nativeFixture(t:test.TestContext) {
  const directory=await mkdtemp(join(tmpdir(),"router-native-barrier-")),socket=join(directory,"native.sock");
  const server=createServer(),sockets=new WebSocketServer({server});const received:string[]=[];
  sockets.on("connection",client=>client.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id===undefined)return;received.push(message.method);client.send(JSON.stringify({id:message.id,result:{}}));}));
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  const {peer}=await GenerationPeer.open(socket,{clientInfo:{name:"storage-barrier",version:"1"}},{message(){},disconnected(){}});
  t.after(async()=>{peer.close();for(const client of sockets.clients)client.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  return {peer,received,directory};
}
test("Native RPC is not sent until its asynchronous durable sent receipt commits",{timeout:5000},async t=>{
  const {peer,received,directory}=await nativeFixture(t),registry=await GenerationRegistryWorker.open(join(directory,"registry")),owner=new CodexRouterOwner(registry);await owner.ready;
  const locker=new DatabaseSync(join(directory,"registry/codex-generations.sqlite"));
  const lease=await owner.enter(false,{method:"turn/start"});locker.exec("BEGIN IMMEDIATE");
  const call=peer.call("turn/start",{},async nativeRequestId=>{await lease.update({nativeRequestId});await lease.sent();});
  try{await pause(60);assert.deepEqual(received,["initialize"],"a held commit cannot leak the mutation onto Native");}
  finally{locker.exec("ROLLBACK");}
  try{await call;assert.deepEqual(received,["initialize","turn/start"]);assert.equal((registry.metadata(`router-lease:${lease.id}`) as any).phase,"sent");await lease();}
  finally{locker.close();await owner.dispose();await owner.drain();await registry.close();}
});
test("a failed durable sent receipt fails closed and sends no Native mutation",{timeout:5000},async t=>{
  const {peer,received,directory}=await nativeFixture(t),registry=await GenerationRegistryWorker.open(join(directory,"registry")),owner=new CodexRouterOwner(registry);await owner.ready;
  const locker=new DatabaseSync(join(directory,"registry/codex-generations.sqlite")),lease=await owner.enter(false,{method:"turn/start"});
  locker.exec("CREATE TRIGGER fixture_reject_receipt BEFORE UPDATE ON routing_metadata WHEN NEW.key LIKE 'router-lease:%' BEGIN SELECT RAISE(ABORT,'fixture reject receipt'); END");
  try{
    await assert.rejects(peer.call("turn/start",{},()=>lease.sent()),/fixture reject receipt/);
    assert.deepEqual(received,["initialize"]);assert.equal(owner.isOpen(),false);
    assert.equal(registry.available,false);assert.throws(()=>registry.metadata(`router-lease:${lease.id}`),/fixture reject receipt/);
    await assert.rejects(lease.sent(),/unavailable/);
    // Remove the injected schema fault before testing a legitimate reopen.
    locker.exec("DROP TRIGGER fixture_reject_receipt");
    await registry.close().catch(()=>{});
    const reopened=await GenerationRegistryWorker.open(join(directory,"registry"));
    try {assert.equal((reopened.metadata(`router-lease:${lease.id}`) as any).phase,"accepted","failed transaction cannot publish sent state");}
    finally {await reopened.close();}
  }finally{locker.close();await owner.dispose();await owner.drain();await registry.close().catch(()=>{});}
});

import fs from "node:fs";
import childProcess from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {routerStorageTask} from "../../apps/codex-core/src/generation-registry-worker.js";
import {inspectRouterNative} from "../../apps/codex-core/src/router-maintenance.js";
test("cold lifecycle directory creation and backup integrity stay off the network thread",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-cold-io-")),home=join(directory,"home");await mkdir(join(home,"nested"),{recursive:true});
  const path=join(home,"nested/state.sqlite"),database=new DatabaseSync(path);database.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('keep')");database.close();
  const original=new Map<string,any>(["mkdirSync","statSync","chownSync"].map(key=>[key,(fs as any)[key]])),execute=childProcess.execFileSync;
  for(const key of original.keys())(fs as any)[key]=()=>{throw Error("Synchronous filesystem on network thread");};
  childProcess.execFileSync=(()=>{throw Error("Synchronous process on network thread");}) as any;syncBuiltinESMExports();
  try{await forbidMainSql(async()=>{
    await routerStorageTask<void>("create-directory",[join(directory,"runtime/tmp"),process.getuid!(),process.getgid!()]);
    assert.equal(await routerStorageTask<number>("check-databases",[home]),1);
  });assert.equal((await stat(join(directory,"runtime/tmp"))).mode&0o777,0o700);}
  finally{for(const [key,value] of original)(fs as any)[key]=value;childProcess.execFileSync=execute;syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});}
});
test("a corrupt backup rejects read-only validation without rewriting inspected bytes",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-corrupt-backup-"));try{
    const backup=join(directory,"backup");await mkdir(backup);await writeFile(join(backup,"state.sqlite"),"invalid sqlite fixture");
    await forbidMainSql(async()=>{await assert.rejects(routerStorageTask<number>("check-databases",[backup]),/database|SQLite|sqlite/i);});
    assert.equal(await readFile(join(backup,"state.sqlite"),"utf8"),"invalid sqlite fixture");
  }finally{await rm(directory,{recursive:true,force:true});}
});
test("host restart validation reads boot identity asynchronously before rejecting busy lifecycle",async()=>{
  const boot=(await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim(),read=fs.readFileSync;
  fs.readFileSync=((path:any,...args:any[])=>{if(path==="/proc/sys/kernel/random/boot_id")throw Error("Blocking boot read on network thread");return (read as any)(path,...args);}) as any;syncBuiltinESMExports();
  try{await assert.rejects(inspectRouterNative({generations:[{state:"candidate"}],routes:[],metadata:{},unresolvedCreations:0} as any,false,{sourceBootId:"prior-boot",recoveryBootId:boot}),{code:"ROUTER_LIFECYCLE_BUSY"});}
  finally{fs.readFileSync=read;syncBuiltinESMExports();}
});

import {once} from "node:events";
import {CodexGenerationRegistry} from "../../apps/codex-core/src/generation-registry.js";
import {REGISTRY_PENDING_LIMIT} from "../../apps/codex-core/src/generation-registry-protocol.js";
test("confirmed domain and CAS rollbacks preserve the owner; non-whitelisted RPC cannot execute",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-domain-reject-")),registry=await GenerationRegistryWorker.open(directory),owner=new CodexRouterOwner(registry);await owner.ready;
  try{
    await registry.register({id:"one",endpoint:join(directory,"one/control.sock"),runtimeDataDirectory:join(directory,"one/data"),executable:process.execPath,bundle:process.argv[1]!,node:process.execPath,cwd:directory});
    await registry.ready("one");await registry.activate("one",0);await registry.setMetadata("version",1);
    await assert.rejects(registry.activate("one",0),{code:"GENERATION_REGISTRY_REJECTED"});
    await assert.rejects(registry.compareMetadata("version",0,2),{code:"GENERATION_REGISTRY_REJECTED"});
    await assert.rejects((registry as any).request("projection",[]),{code:"REGISTRY_OPERATION_REJECTED"});
    assert.equal(registry.available,true);assert.equal(owner.isOpen(),true);assert.equal(registry.current().epoch,1);assert.equal(registry.metadata("version"),1);
    await registry.setMetadata("after-rejection","committed");assert.equal(registry.metadata("after-rejection"),"committed");
  }finally{await owner.dispose();await owner.drain();await registry.close();await rm(directory,{recursive:true,force:true});}
});
test("post-commit SQL projection failure fences all reads and later writes and releases the writer lease",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-unknown-effect-")),registry=await GenerationRegistryWorker.open(directory),owner=new CodexRouterOwner(registry);await owner.ready;
  const database=new DatabaseSync(join(directory,"codex-generations.sqlite")),exited=once((registry as any).worker,"exit");
  try{
    database.exec("DROP TABLE creation_claims");
    const first=registry.setMetadata("effect-before-projection-error","committed"),later=registry.setMetadata("must-not-run","forbidden");
    await assert.rejects(first,/creation_claims/);await assert.rejects(later,/creation_claims/);await exited;
    assert.equal(registry.available,false);assert.equal(owner.isOpen(),false);assert.equal(registry.valid({ownerEpoch:"old",generationId:"none",incarnation:1,admissionEpoch:1}),false);
    for(const read of [()=>registry.get("none"),()=>registry.current(),()=>registry.route("thread"),()=>registry.routes(),()=>registry.metadata("effect-before-projection-error")])assert.throws(read,/creation_claims/);
    assert.equal(database.prepare("SELECT value FROM routing_metadata WHERE key='effect-before-projection-error'").get()?.value,'"committed"');
    assert.equal(database.prepare("SELECT value FROM routing_metadata WHERE key='must-not-run'").get(),undefined);
    const lock=new DatabaseSync(join(directory,".codex-routing-owner.sqlite"));try{lock.exec("BEGIN EXCLUSIVE; ROLLBACK");}finally{lock.close();}
  }finally{database.close();await owner.dispose();await owner.drain();await registry.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});
test("bounded pending queue rejects overflow but close drains every accepted write",{timeout:10000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-queue-limit-")),registry=await GenerationRegistryWorker.open(directory),database=new DatabaseSync(join(directory,"codex-generations.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  try{
    const writes=Array.from({length:REGISTRY_PENDING_LIMIT},(_,i)=>registry.setMetadata("ordered",i));
    await assert.rejects(registry.setMetadata("overflow","not-admitted"),{code:"REGISTRY_QUEUE_FULL"});assert.equal(registry.available,true);
    const closing=registry.close();database.exec("ROLLBACK");await Promise.all(writes);await closing;
    const reopened=await GenerationRegistryWorker.open(directory);try{assert.equal(reopened.metadata("ordered"),REGISTRY_PENDING_LIMIT-1);assert.equal(reopened.metadata("overflow"),null);}finally{await reopened.close();}
  }finally{if(database.isTransaction)database.exec("ROLLBACK");database.close();await registry.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});
test("hot generation, route and claim reads use indexes of the committed projection",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-projection-index-")),seed=new CodexGenerationRegistry(directory);
  try{
    seed.register({id:"one",endpoint:join(directory,"one/control.sock"),runtimeDataDirectory:join(directory,"one/data"),executable:process.execPath,bundle:process.argv[1]!,node:process.execPath,cwd:directory});seed.ready("one");seed.activate("one",0);
    const database=new DatabaseSync(join(directory,"codex-generations.sqlite"));try{database.exec("BEGIN");const row=database.prepare("INSERT INTO thread_routes VALUES(?,'one',1)");for(let i=0;i<5000;i++)row.run("thread-"+i);database.exec("COMMIT");}finally{database.close();}
    seed.acceptCreation(undefined,"operation");
  }finally{seed.close();}
  const registry=await GenerationRegistryWorker.open(directory);
  try{
    const projection=(registry as any).projection;
    // A linear-search regression is observable even when small fixtures hide its latency.
    for(const array of [projection.generations,projection.routes,projection.claims])array.find=()=>{throw Error("Hot path scanned the full projection");};
    assert.equal(registry.get("one")?.id,"one");const route=registry.route("thread-4999")!;assert.equal(route.generationId,"one");assert.equal(registry.valid(route),true);
    assert.equal(registry.route("absent"),null);assert.equal(registry.creationTicket("operation")?.generationId,"one");assert.equal(registry.unresolvedCreations("one"),1);
  }finally{await registry.close();await rm(directory,{recursive:true,force:true});}
});


test("path resume waits for the registry Worker commit before publishing its route",async t=>{
  const {generationThreadPath}=await import('../../apps/codex-core/src/generation-thread-path.js');
  const directory=await mkdtemp(join(tmpdir(),'router-path-')),registry=await GenerationRegistryWorker.open(directory);
  const locker=new DatabaseSync(join(directory,'codex-generations.sqlite'));
  t.after(async()=>{locker.close();await registry.close();await rm(directory,{recursive:true,force:true});});
  await registry.register({id:'a',endpoint:join(directory,'control.sock'),runtimeDataDirectory:directory,executable:process.execPath,bundle:process.argv[1]!,node:process.execPath,cwd:directory});
  await registry.ready('a');await registry.activate('a',0);
  await mkdir(join(directory,'runtime'),{recursive:true});const path=join(directory,'runtime','thread.jsonl');
  await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'from-path'}})+'\n');
  locker.exec('BEGIN IMMEDIATE');let settled=false;
  const pending=generationThreadPath(registry,path,'from-path').then(id=>{settled=true;assert.equal(registry.route(id)?.generationId,'a');return id;});
  try{await pause(50);assert.equal(settled,false);assert.equal(registry.route('from-path'),null);}
  finally{locker.exec('ROLLBACK');}
  assert.equal(await pending,'from-path');
  await assert.rejects(generationThreadPath(registry,path,'different'),/identity disagree/);
});

test("lease commits do not retransmit unchanged historical receipts; deltas retain copy and removal semantics",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"router-history-delta-"));
  const registry=await GenerationRegistryWorker.open(directory);
  try {
    const history={rows:Array.from({length:12000},(_,id)=>({id,proof:"retained-evidence-".repeat(12)}))};
    await registry.setMetadata("router-history:fixture",history);
    const messages:unknown[]=[];
    const observe=(message:any)=>{if(message.projection)messages.push(message.projection);};
    (registry as any).worker.on("message",observe);
    await forbidMainSql(async()=>{
      await registry.setMetadata("lease",{phase:"accepted"});
      await registry.updateMetadata({lease:{phase:"sent"},transient:true});
      await assert.rejects(registry.compareMetadata("lease",{phase:"wrong"},{phase:"lost"}));
      await registry.updateMetadata({lease:{phase:"released"}},["transient"]);
      assert.deepEqual(registry.metadata("router-history:fixture"),history);
      const borrowed=registry.metadata("router-history:fixture") as typeof history;borrowed.rows[0]!.proof="modified";
      assert.deepEqual(registry.metadata("router-history:fixture"),history);
      assert.deepEqual(registry.metadata("lease"),{phase:"released"});assert.equal(registry.metadata("transient"),null);
    });
    (registry as any).worker.off("message",observe);
    assert.equal(messages.length,3);
    for(const message of messages)assert.ok(Buffer.byteLength(JSON.stringify(message))<50000,"unchanged multi-megabyte history must not enter a lease ACK");
    await registry.close();
    const reopened=await GenerationRegistryWorker.open(directory);
    try{assert.deepEqual(reopened.metadata("router-history:fixture"),history);assert.equal(reopened.metadata("transient"),null);assert.deepEqual(reopened.metadata("lease"),{phase:"released"});}
    finally{await reopened.close();}
  }finally{await registry.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});

test("metadata-only commits retain route indexes without retransmitting routing tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-delta-"));
  const registry = await GenerationRegistryWorker.open(directory);
  try {
    await registry.register({ id: "a", endpoint: join(directory, "a/control.sock"), runtimeDataDirectory: join(directory, "a/data"), executable: process.execPath, bundle: process.argv[1]!, node: process.execPath, cwd: directory });
    await registry.ready("a"); await registry.activate("a", 0);
    const ticket = await registry.discover("thread", "a");
    const messages: any[] = [];
    (registry as any).worker.on("message", (message: any) => { if (message.projection) messages.push(message.projection); });
    await registry.updateMetadata({ "router-lease:fixture": { phase: "sent" } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].routingUnchanged, true);
    assert.deepEqual(messages[0].routes, []);
    assert.deepEqual(messages[0].claims, []);
    assert.deepEqual(messages[0].generations, []);
    assert.equal(registry.valid(ticket), true);
    assert.deepEqual(registry.threadIds("a"), ["thread"]);
    await registry.discover("next", "a");
    assert.equal(messages.at(-1).routingUnchanged, false);
    assert.deepEqual(registry.threadIds("a"), ["next", "thread"]);
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("warm metadata projection avoids archive scans and invalidates on rollback and external writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-projection-sql-"));
  const registry = new CodexGenerationRegistry(directory);
  const external = new DatabaseSync(join(directory, "codex-generations.sqlite"));
  const prepare = DatabaseSync.prototype.prepare;
  let scans = 0;
  try {
    registry.setMetadata("router-history:fixture", { payload: "x".repeat(1024 * 1024) });
    registry.projection();
    DatabaseSync.prototype.prepare = function(sql: string, ...args: any[]) {
      if (sql === "SELECT key,value FROM routing_metadata") scans++;
      return Reflect.apply(prepare, this, [sql, ...args]);
    } as typeof prepare;
    for (let i = 0; i < 10; i++) { registry.setMetadata("lease", i); assert.equal(registry.projection(true).metadata.lease, String(i)); }
    assert.equal(scans, 0);
    assert.throws(() => registry.metadataTransaction(() => { registry.setMetadata("lease", 99); registry.projection(true); throw Error("rollback"); }), /rollback/);
    assert.equal(registry.projection(true).metadata.lease, "9");
    assert.equal(scans, 1);
    external.prepare("UPDATE routing_metadata SET value='42' WHERE key='lease'").run();
    const after = registry.projection(true);
    assert.equal(after.routingUnchanged, false);
    assert.equal(after.metadata.lease, "42");
    assert.equal(scans, 2);
  } finally { DatabaseSync.prototype.prepare = prepare; external.close(); registry.close(); await rm(directory, { recursive: true, force: true }); }
});
