import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { startControlServer } from "../../apps/codex-core/src/control-server.js";
import { inspectRouterNative, routerDigest, routerNativeDigest } from "../../apps/codex-core/src/router-maintenance.js";
import type { GenerationRecord } from "../../apps/codex-core/src/generation-registry.js";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'router-maintenance-native-')),socket=join(root,'native.sock'),endpoint=join(root,'core.sock');
  const work={core:0,oauth:0,callbacks:0,process:false,turn:false,goal:false,unexpected:false,changedIdentity:false,systemError:false,busyCommand:false,missingTurns:false,missingItems:false,lateTurn:false,readTurns:0};const calls:string[]=[];
  const server=createServer(),wss=new WebSocketServer({server});
  wss.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(String(raw));calls.push(m.method);if(m.id===undefined)return;
    const result=m.method==='initialize'?{}:m.method==='thread/loaded/list'?{data:['thread']}:
      m.method==='thread/goal/get'?{goal:work.goal?{status:'active'}:null}:
      m.method==='thread/read'?{thread:{id:m.params.threadId,status:{type:work.turn?'active':work.systemError?'systemError':'idle'},...(m.params.includeTurns?{turns:work.missingTurns?[]:[{id:'turn',status:work.lateTurn&&work.readTurns++>0?'inProgress':'failed',...(work.missingItems?{}:{items:[{id:'command',type:'commandExecution',status:work.busyCommand?'inProgress':'completed'}]})}]}:{})}}:{};
    ws.send(JSON.stringify({id:m.id,result}));if(work.unexpected&&m.method==='thread/loaded/list')ws.send(JSON.stringify({id:77,method:'item/tool/call',params:{threadId:'thread'}}));
  }));await new Promise<void>(r=>server.listen(socket,r));
  const core=await startControlServer(endpoint,'synthetic',async()=>({status:200,value:{pid:2,handoff:{protocolVersion:1,topology:'split',phase:'open',persistence:'ready',owner:'core',epoch:4,uncertain:[{id:'keep-unknown',route:'/v1/responses'}]},proof:{coverage:'unknown',activeCount:null,counts:{oauth:work.oauth,proxy:work.core,refresh:0,requests:0,resetCredits:0,subscriptions:0}}}}));
  const generation={id:'old',state:'active',incarnation:1,endpoint,executable:'/fixed-cli',bundle:'/fixed-app',node:'/fixed-node',cwd:root,runtimeDataDirectory:root} as GenerationRecord;
  const identity={ownerPid:3,nativePid:4,ownerStart:'1',nativeStart:'2',unit:'native.service',cliSha256:'fixed',cliVersion:'codex-cli 0.162.0'};
  const options={generations:[generation],routes:[{generationId:'old',threadId:'thread'},{generationId:'old',threadId:'ephemeral-old-binding'}],metadata:{'runtime:old':identity,'thread-retention:ephemeral-old-binding':'ephemeral'},unresolvedCreations:0,coreEndpoint:endpoint,token:'synthetic',failures:{version:1 as const,failures:[]},supervisor:{
    inspect:async()=>({protocolVersion:1 as const,pid:3,codexPid:4,dataDirectory:root,nativeSocket:socket,proxyBaseUrl:'http://127.0.0.1:1',callbackProtocolVersion:1 as const,pendingCallbacks:work.callbacks,pendingOrchestrationMutations:0}),
    identify:async()=>work.changedIdentity?{...identity,nativePid:88}:identity,processesQuiet:async()=>!work.process,
    start:async()=>{throw Error('must not start Native');},stop:async()=>{throw Error('must not stop Native');},discardUnready:async()=>{throw Error('must not discard Native');}
  }};
  return {work,options,calls,async close(){for(const ws of wss.clients)ws.terminate();await core.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}};
}
test('zero-work proof retains Core unknown and uses the existing durable binding policy without any resume or answer',async()=>{
  const f=await fixture();try{const before=routerDigest(f.options);const proof=await inspectRouterNative(f.options);assert.equal(proof.core.historicalUnknown[0].id,'keep-unknown');assert.equal(proof.generations[0]!.history.historicalCount,1);assert.equal(routerDigest(f.options),before);assert(f.calls.every(m=>['initialize','initialized','thread/loaded/list','thread/goal/get','thread/read'].includes(m)));assert(!f.calls.includes('thread/resume'));}finally{await f.close();}
});
for(const field of ['core','callbacks','process','turn','unexpected','changedIdentity'] as const)test('independent in-flight coverage blocks maintenance: '+field,async()=>{
  const f=await fixture();try{(f.work as any)[field]=['core','callbacks'].includes(field)?1:true;await assert.rejects(inspectRouterNative(f.options));assert(!f.calls.includes('thread/resume'));}finally{await f.close();}
});
test('a persistent goal record stays with idle Native and is not queried, armed or replayed',async()=>{
 const f=await fixture();try{f.work.goal=true;await inspectRouterNative(f.options);assert(!f.calls.some(m=>m.includes('goal')||m.includes('schedule')));}finally{await f.close();}
});
test('unresolved creation and unsupported lifecycle do not become historical unknown',async()=>{
  const f=await fixture();try{f.options.unresolvedCreations=1;await assert.rejects(inspectRouterNative(f.options));f.options.unresolvedCreations=0;(f.options.generations[0] as any).state='candidate';await assert.rejects(inspectRouterNative(f.options));assert.equal(f.calls.length,0);}finally{await f.close();}
});

test('independent Core OAuth work remains with Core while only proxy traffic blocks the router',async()=>{const f=await fixture();try{f.work.oauth=1;await inspectRouterNative(f.options);assert(!f.calls.some(m=>m.includes('login')));}finally{await f.close();}});

test('terminal systemError Thread is quiet only with full terminal Turn and command evidence',async()=>{const f=await fixture();try{f.work.systemError=true;const proof=await inspectRouterNative(f.options);assert.deepEqual((proof.generations[0] as any).terminalSystemErrors,[{threadId:'thread',turns:[{id:'turn',status:'failed',executions:[{id:'command',type:'commandExecution',status:'completed'}]}]}]);assert(f.calls.filter(m=>m==='thread/read').length>=5);assert(f.calls.every(m=>['initialize','initialized','thread/loaded/list','thread/read'].includes(m)));}finally{await f.close();}});
for(const field of ['busyCommand','missingTurns','missingItems','lateTurn','callbacks','unexpected','process']as const)test('systemError never hides unresolved work: '+field,async()=>{const f=await fixture();try{f.work.systemError=true;(f.work as any)[field]=field==='callbacks'?1:true;await assert.rejects(inspectRouterNative(f.options));assert(!f.calls.some(m=>m==='thread/resume'||m==='thread/unload'||m==='turn/interrupt'));}finally{await f.close();}});

test('required migration preserves active Native work and callbacks without answering or replaying',async()=>{const f=await fixture();try{Object.assign(f.work,{turn:true,core:1,callbacks:2,process:true,unexpected:true});f.options.unresolvedCreations=1;await assert.rejects(inspectRouterNative(f.options));const proof=await inspectRouterNative(f.options,true);assert.equal(proof.policy,'continuing-v1');assert.equal(proof.observations?.coreCounts.proxy,1);assert.equal(proof.observations?.unresolvedCreations,1);assert.equal(proof.generations[0]!.observations?.pendingCallbacks,2);assert.equal(proof.generations[0]!.observations?.processesQuiet,false);assert(f.calls.every(m=>['initialize','initialized','thread/loaded/list','thread/read'].includes(m)));const first=routerNativeDigest(proof);f.work.core=2;f.work.callbacks=3;assert.equal(routerNativeDigest(await inspectRouterNative(f.options,true)),first);await assert.rejects(inspectRouterNative(f.options));}finally{await f.close();}});
