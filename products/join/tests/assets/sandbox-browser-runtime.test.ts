import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { EventEmitter } from 'node:events';
import { createSandboxBrowserRuntime } from '../../assets/sandbox-browser-runtime';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(overrides:any={}) {
 let spawns=0,stops=0,attaches=0,closes=0,lost=0,uncertain=0,exit!:()=>void,command:any;
 const exited=new Promise<any>(resolve=>exit=()=>resolve({code:0}));
 const process={kind:'process' as const,id:'test',exited,writeStdin:async()=>{},closeStdin:async()=>{},
  async terminate(){stops++;exit()}};
 const transport=Object.assign(new EventEmitter(),{connected:true,inventory:[],workerPid:1,automationCancellation:1,automationNavigation:1,
  send(){},kill(){this.connected=false},async close(){closes++;this.connected=false}});
 const owner=createSandboxBrowserRuntime({sandbox:{async spawn(c,output){spawns++;command=c;
  new Script(c.command[2]);output?.({stream:'stdout',data:Buffer.from('OPENCRAFT_BROWSER_OWNER_READY\n')});return process;}},
  prepare:async()=>({directory:'/tmp/opencraft-browser-runtime-test'}),
  isolation:'isolated-vm-compatibility',authorize:async()=>{},assertCurrent(){},
  onLost(){lost++},onCleanupUnconfirmed(){uncertain++},...overrides},
  {connect:async()=>{attaches++;return transport}});
 return {owner,process,transport,exit,get stats(){return {spawns,stops,attaches,closes,lost,uncertain}},get command(){return command}};
}
test('one lifecycle start, explicit VM flags, shared close and no NFS profile',async()=>{
 const f=fixture();await f.owner.connect();
 assert.equal(f.stats.spawns,1);assert.match(f.command.command[2],/--no-zygote/);
 assert.match(f.command.command[2],/--no-sandbox/);assert.doesNotMatch(f.command.command[2],/\/workspace|\/shared/);
 await assert.rejects(f.owner.connect(),/already attached/);
 const close=f.owner.close();assert.strictEqual(f.owner.close(),close);await close;
 assert.equal(f.stats.stops,1);assert.equal(f.stats.closes,1);assert.equal(f.stats.lost,0);
 await assert.rejects(f.owner.connect(),/unavailable/);
});
test('sandboxed policy never inherits compatibility flags',async()=>{
 const f=fixture({isolation:'chromium-sandbox'});await f.owner.connect();
 assert.doesNotMatch(f.command.command[2],/--no-sandbox|--no-zygote|--in-process-gpu/);await f.owner.close();
});
test('close during preparation prevents late native spawn',async()=>{
 let release!:(value:any)=>void;
 const f=fixture({prepare:()=>new Promise(resolve=>release=resolve)});
 const connect=f.owner.connect();await tick();const rejected=assert.rejects(connect,/unavailable/);
 const closed=f.owner.close();release({directory:'/tmp/opencraft-browser-test'});
 await rejected;await closed;assert.equal(f.stats.spawns,0);
});
test('startup failure is retained and never silently retried',async()=>{
 let prepared=0;const f=fixture({prepare:async()=>{prepared++;throw Error('bad runtime')}});
 await assert.rejects(f.owner.connect(),/bad runtime/);await assert.rejects(f.owner.connect(),/bad runtime/);
 assert.equal(prepared,1);assert.equal(f.stats.spawns,0);await f.owner.close();
});
test('native exit fences future connections and signals loss once',async()=>{
 const f=fixture();await f.owner.connect();f.exit();await tick();
 assert.equal(f.stats.lost,1);assert.throws(f.owner.assertCurrent,/unavailable/);
 await assert.rejects(f.owner.connect(),/unavailable/);await f.owner.close();
});
test('cleanup uncertainty is surfaced to lifecycle owner',async()=>{
 const f=fixture();await f.owner.connect();f.transport.close=async()=>{throw Error('unknown cleanup')};
 await assert.rejects(f.owner.close(),/cleanup unconfirmed/);assert.equal(f.stats.uncertain,1);
});
test('invalid prepared runtime never starts a process',async()=>{
 const f=fixture({prepare:async()=>({directory:'/shared/untrusted'})});
 await assert.rejects(f.owner.connect(),/Invalid prepared/);assert.equal(f.stats.spawns,0);await f.owner.close();
});

test('late spawn after close is terminated before owner connection',async()=>{
 let release!:(value:any)=>void;
 const f=fixture({sandbox:{spawn:async(_command:any,output:any)=>{output({stream:'stdout',data:Buffer.from('OPENCRAFT_BROWSER_OWNER_READY\n')});return new Promise(resolve=>release=resolve)}}});
 const connecting=f.owner.connect();await tick();const rejected=assert.rejects(connecting,/unavailable/);
 const closing=f.owner.close();release(f.process);await rejected;await closing;
 assert.equal(f.stats.stops,1);assert.equal(f.stats.attaches,0);
});
test('concurrent connects share preparation and private attachment',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.owner.connect(),f.owner.connect()]);
 assert.strictEqual(a,b);assert.equal(f.stats.spawns,1);assert.equal(f.stats.attaches,1);await f.owner.close();
});
