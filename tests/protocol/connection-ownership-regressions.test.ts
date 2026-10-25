import assert from "node:assert/strict";
import test from "node:test";
import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import { AppHostServer } from "@opencraft/app-host-server";
import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { CodexNativeCoreTransport } from "../../apps/opencraft-daemon/src/codex-native-core-transport";
import { CodexCoreBridge } from "../../apps/opencraft-daemon/src/codex-core-bridge";
const turn=()=>new Promise<void>(r=>setImmediate(r));
const gate=<T=void>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};};
const initialized={codexHome:'/tmp/fixture',platformFamily:'unix',platformOs:'linux',userAgent:'audit'};
class Physical {
 status:any={state:'idle'};statuses=new Set<any>();messages=new Set<any>();connects=0;closes=0;
 async connect(){this.connects++;this.publish({state:'open'});}
 async send(frame:string){if(this.status.state!=='open')throw Error('physical failed');const m=JSON.parse(frame);if(m.method==='initialize')queueMicrotask(()=>this.emit({jsonrpc:'2.0',id:m.id,result:initialized}));}
 emit(m:any){for(const f of this.messages)f(JSON.stringify(m));}
 publish(status:any){this.status=status;for(const f of this.statuses)f(status);}
 subscribeMessage(f:any){this.messages.add(f);return()=>this.messages.delete(f);}
 subscribeStatus(f:any){this.statuses.add(f);return()=>this.statuses.delete(f);}
 async close(){this.closes++;this.publish({state:'closed'});}
}
function ports(){const a=new Set<any>(),b=new Set<any>();let closed=false;return{
 browser:{postMessage(m:any){queueMicrotask(()=>{if(!closed)for(const f of b)f(m);});},addEventListener(_t:any,f:any){a.add(f)},removeEventListener(_t:any,f:any){a.delete(f)},start(){},close(){closed=true;}},
 host:{postMessage(m:any){queueMicrotask(()=>{if(!closed)for(const f of a)f({data:m});});},subscribe(f:any){b.add(f);return()=>b.delete(f)},start(){},close(){closed=true;}}
};}


for (const composed of [false, true]) test(`cold initialize/loss preserves retry through ${composed ? 'AppHost + RPC + Runtime' : 'RPC + Runtime'}`, {timeout:10_000}, async () => {
 for (const ticks of [2,3,4,5,6,7,8,10,12]) {
  const first = new Physical(), next = new Physical(); let activations = 0;
  const original = first.send.bind(first);
  first.send = async frame => {
   await original(frame);
   if (JSON.parse(frame).method === 'initialize') {
    let n = ticks; const lose = () => { if (--n > 0) queueMicrotask(lose); else first.publish({state:'failed',reason:'lost after initialize reply'}); };
    queueMicrotask(lose);
   }
  };
  const factory = () => activations++ === 0 ? first : next;
  const server = new AppHostServer({createTransport:factory}); const pair = ports();
  const connection = server.accept(pair.host,'regression'); const apphost = new MessagePortAppHostClient(pair.browser,'regression');
  const timers = new Set<{callback():void;delay:number}>();
  const runtime = createAppServerWorkbenchRuntime({hostId:'fixture',createTransport:composed ? () => apphost.createTransport('fixture') : factory,
   autoReconnect:true,onRecoveryEvent:()=>{},clock:{setTimeout(callback,delay){const t={callback,delay};timers.add(t);return t;},clearTimeout(t){timers.delete(t as any);}}});
  try {
   await runtime.connect().catch(()=>{}); await turn();
   assert.equal(runtime.getSnapshot().phase,'reconnecting', `ticks=${ticks}`);
   assert.deepEqual([...timers].map(t=>t.delay),[500]);
   const retry=[...timers][0]!;timers.delete(retry);retry.callback();
   for(let i=0;i<40&&runtime.getSnapshot().phase!=='ready';i++)await turn();
   assert.equal(runtime.getSnapshot().phase,'ready'); assert.equal(runtime.getSnapshot().transport.state,'open');
  } finally { await runtime.dispose(); apphost.close(); connection.close(); await server.close(); }
 }
});

test('logical disconnect failure releases its own local claim and preserves a shared peer', async()=>{
 const p=new Physical();const original=p.send.bind(p);
 p.send=async frame=>{if(JSON.parse(frame).method==='runtime/client/disconnect')throw Error('notification failed');await original(frame);};
 const server=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>p});
 const pair=ports(),connection=server.accept(pair.host,'claim'),client=new MessagePortAppHostClient(pair.browser,'claim');
 try{
  const a=client.createTransport('fixture'),b=client.createTransport('fixture');await a.connect();await b.connect();await a.close();
  const slot=(server as any).slots.get('fixture');assert.equal(slot.claims.size,1);
  assert.equal((connection as any).leases.size,1);assert.equal(p.closes,0);assert.equal(b.status.state,'open');await b.close();
  assert.equal(slot.claims.size,0);assert.equal(p.closes,0);
 }finally{client.close();connection.close();await server.close();}
});

test('both Core adapters reject close during health and never reopen on late health',async()=>{
 for(const Factory of [CodexNativeCoreTransport,CodexCoreBridge]){
  const t=new Factory('/synthetic-not-connected','synthetic-test');
  const entered=gate(),release=gate<Awaited<ReturnType<typeof t.control.health>>>();
  t.control.health=async()=>{entered.resolve();return release.promise;};
  const start=t.connect();const rejected=assert.rejects(start);await entered.promise;await t.close();await rejected;
  release.resolve({protocolVersion:1,pid:1,codexPid:2,nativeSocket:'/synthetic-not-connected'});
  await turn();assert.equal(t.status.state,'closed');
 }
});

for (const shared of [false, true]) test(`hung failed transport cleanup cannot hold successor initialization (${shared ? 'shared' : 'owned'} registry)`, { timeout: 10_000 }, async () => {
 const registry = shared ? await createCordisAppServerRegistry() : null;
 const cleanup = gate(), entered = gate();
 const old = new Physical(), next = new Physical(); let created = 0;
 old.connect = async () => { throw Error('first dial failed'); };
 old.close = async () => { entered.resolve(); await cleanup.promise; old.publish({state:'failed',reason:'retired cleanup finished'}); };
 const runtime = createAppServerWorkbenchRuntime({hostId:'cleanup',clientRegistry:registry?.clients,
  createTransport:()=>created++ === 0 ? old : next,autoReconnect:false});
 try {
  await assert.rejects(runtime.connect(),/first dial failed/); await entered.promise;
  await runtime.reconnect();
  assert.equal(runtime.getSnapshot().phase,'ready'); assert.equal(created,2);
  cleanup.resolve(); await turn();
  assert.equal(runtime.getSnapshot().phase,'ready','late cleanup cannot erase or fail successor');
  assert.equal(next.closes,0);
 } finally { cleanup.resolve(); await runtime.dispose(); await registry?.dispose(); }
});

test('uncooperative transport dial is revoked by deadline and successor does not inherit it', {timeout:10_000}, async()=>{
 const dial=gate(),entered=gate(),old=new Physical(),next=new Physical();let created=0;
 old.connect=async()=>{entered.resolve();await dial.promise;old.publish({state:'open'});};
 const timers=new Set<{callback():void;delay:number}>();
 const runtime=createAppServerWorkbenchRuntime({hostId:'deadline',createTransport:()=>created++===0?old:next,
  clock:{setTimeout(callback,delay){const timer={callback,delay};timers.add(timer);return timer;},clearTimeout(timer){timers.delete(timer as any);}}});
 try{
  const pending=runtime.connect(),failed=assert.rejects(pending,/timed out/);await entered.promise;
  const deadline=[...timers].find(timer=>timer.delay===45_000)!;assert.ok(deadline);timers.delete(deadline);deadline.callback();await failed;await turn();
  await runtime.reconnect();assert.equal(runtime.getSnapshot().phase,'ready');
  dial.resolve();await turn();assert.equal(runtime.getSnapshot().phase,'ready');assert.equal(created,2);
 }finally{dial.resolve();await runtime.dispose();}
});
