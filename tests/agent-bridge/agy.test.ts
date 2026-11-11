import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { AcpBridge, profileFromEnv } from '../../packages/agent-bridge-acp/src/index';
import { AgyTraceReader, agyDialect } from '../../packages/agent-bridge-acp/src/agy';
const wait = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(read:()=>any, accept:(v:any)=>boolean) {
 for(let i=0;i<300;i++){const v=await read();if(accept(v))return v;await wait(10);}throw Error('fixture timeout');
}
async function fixture(t:any, scenario='success') {
 const dir=await mkdtemp(join(tmpdir(),'p6-fixture-'));
 const command=resolve('tests/agent-bridge/fixtures/agy-agent.mjs');
 const env={AGENT_BRIDGE_AGY_CONVERSATIONS:dir,AGY_FIXTURE:scenario};
 await new Promise<void>((r,j)=>execFile(command,['--seed'],{env:{...process.env,...env}},e=>e?j(e):r()));
 const frames:any[]=[],deltas:any[]=[];
 const bridge=new AcpBridge({profile:profileFromEnv({AGENT_BRIDGE_ACP_DIALECT:'agy',AGENT_BRIDGE_ACP_COMMAND:command,AGENT_BRIDGE_ACP_CWD:process.cwd(),AGENT_BRIDGE_ACP_ENV:JSON.stringify(env)}),requestCallback:async(m,p)=>{if(m==='thread/delta')deltas.push(...p.deltas as any[]);return {};},onFrame:(direction,frame)=>frames.push({direction,frame})});
 t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});
 const init=await bridge.initialize({protocolVersion:1,grammarRange:{min:1,max:1}});
 const call=(method:string,params:Record<string,unknown>={})=>bridge.handle(method,{threadId:'test',executionEpoch:1,...params}) as Promise<any>;
 await call('session/create');
 const start=async()=>{const turn=await call('turn/start',{input:{text:'original'}});await until(()=>frames.some(f=>f.frame.params?.update?.sessionUpdate==='tool_call'),Boolean);return turn.nativeTurnId;};
 const steer=(turn:string,text='correction',id='steer')=>call('turn/steer',{expectedTurnId:turn,inputId:id,clientRequestId:id,delivery:'native-inject',input:{text}});
 const status=async()=>(await call('input/query')).inputs.find((i:any)=>i.inputId==='steer');
 return {bridge,init,call,start,steer,status,frames,deltas,dir};
}
for(const scenario of ['missing-plugin','bad-schema'])test(`AGY ${scenario} refuses native capability despite generic metadata`,async t=>{
 const f=await fixture(t,scenario);assert(!f.init.effectiveCapabilities.steer.deliveryMethods.includes('native-inject'));assert(!f.init.effectiveCapabilities.steer.evidenceKinds.includes('native-input-id'));
 // No prompt is needed to discover that this path is unavailable.
 assert(!f.frames.some(f=>f.frame.method==='session/prompt'));
 const turn=await f.start();await assert.rejects(f.steer(turn));
 assert(!f.frames.some(f=>f.frame.method==='opencraft/agy/steer'));
});
test('AGY hook plus new raw row and floor yield native evidence, never concurrent prompt',async t=>{
 const f=await fixture(t);const turn=await f.start();await f.steer(turn);
 const state=await until(f.status,s=>s?.outcome==='delivered');assert.equal(state.evidence.kind,'native-input-id');assert.equal(state.evidence.nativeInputId,'2');assert.equal(state.evidence.runId,'native-session');
 assert(f.deltas.some(d=>d.op==='input.evidence'&&d.evidenceKind==='native-input-id'&&d.nativeInputId==='2'));
 assert.equal(f.frames.filter(f=>f.direction==='out'&&f.frame.method==='session/prompt').length,1);
});
for(const scenario of ['no-row','same-rows','wrong-floor','exit','end-before-row'])test(`AGY ${scenario} stays unknown without replay`,async t=>{
 const f=await fixture(t,scenario);const turn=await f.start();await f.steer(turn);
 const state=await until(f.status,s=>s?.outcome==='unknown');assert.equal(state.evidence.value,'none');
 assert(!f.deltas.some(d=>d.op==='input.evidence'&&d.inputId==='steer'));
 await f.call('input/query');assert.equal(f.frames.filter(f=>f.direction==='out'&&f.frame.method==='session/prompt').length,1);
 assert(!f.frames.some(f=>f.direction==='out'&&f.frame.method==='session/cancel'));
});
test('AGY initial same text is unknown; slash/unknown content rejected before native write',async t=>{
 const f=await fixture(t);const turn=await f.start();
 for(const input of [{text:'/command'},{text:'ok',extra:true},{text:'ok',images:[{mimeType:'image/png',data:'AA=='}]}])await assert.rejects(f.call('turn/steer',{inputId:'bad',clientRequestId:'bad',input,delivery:'native-inject'}));
 await f.steer(turn,'original');assert.equal((await until(f.status,s=>s?.outcome==='unknown')).evidence.value,'none');
});
test('AGY SQLite is confined to worker; failed worker never falls back',async t=>{
 for(const name of ['agy.ts','bridge.ts','acp.ts'])assert(!/from\s*['"](?:better-sqlite3|node:sqlite|bun:sqlite)['"]/.test(await readFile(resolve('packages/agent-bridge-acp/src',name),'utf8')));
 const reader=new AgyTraceReader('/missing-p6-traces');t.after(()=>reader.close());await assert.rejects(reader.read());await reader.close();await assert.rejects(reader.read());
});

test('AGY locked native database leaves the main event loop responsive',async t=>{
 const f=await fixture(t);
 const locker=spawn(resolve('tests/agent-bridge/fixtures/agy-agent.mjs'),['--lock'],{env:{...process.env,AGENT_BRIDGE_AGY_CONVERSATIONS:f.dir},stdio:['pipe','pipe','ignore']});
 t.after(()=>locker.kill());await new Promise<void>(r=>locker.stdout.once('data',()=>r()));
 const reader=new AgyTraceReader(f.dir);t.after(()=>reader.close());
 let ticks=0;const timer=setInterval(()=>ticks++,5);t.after(()=>clearInterval(timer));
 await assert.rejects(reader.read('sample'));
 assert(ticks>=3,'worker lock wait must not stall main-thread timers');
 // Release only after the read settled; the lock holder owns the lock window.
 const exited=new Promise<void>(r=>locker.once('exit',()=>r()));
 locker.stdin.end();
 await exited;
});

test('AGY stop fences pending hook work; no native replay',async t=>{
 const f=await fixture(t,'no-row');const turn=await f.start();await f.steer(turn);await f.call('turn/stop');
 assert.equal((await until(f.status,s=>s?.outcome==='unknown')).evidence.value,'none');
 assert.equal(f.frames.filter(f=>f.direction==='out'&&f.frame.method==='session/prompt').length,1);
});
test('AGY Unix hook capability is not declared on Windows',()=>{
 const base:any={id:'generic',nativeSteering:()=>true};
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
 try {
  Object.defineProperty(process,'platform',{...descriptor,value:'win32'});
  assert.equal(agyDialect(base).nativeSteering({initialize:{protocolVersion:1,_meta:{'opencraft.agyHookTrace':true}},session:{sessionId:'test'}}),false);
 } finally { Object.defineProperty(process,'platform',descriptor); }
});
