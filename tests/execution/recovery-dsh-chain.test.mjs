import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryTransport } from '../../packages/appserver-transport-memory/src/index.ts';
import { createAppServerWorkbenchRuntime } from '../../packages/workbench-runtime/src/index.ts';
import { DshAppServerAdapter } from '../../apps/local-agent-host/src/dsh-appserver-adapter.ts';
import { ThreadLifecycle } from '../../apps/local-agent-host/src/thread-lifecycle.ts';
import { ThreadCatalog } from '../../apps/local-agent-host/src/thread-catalog.ts';
for (const nativeHead of [false, true]) test(`DSH combined recovery avoids items waterfall (native head: ${nativeHead})`, async () => {
const events=[]; const native=[]; const requests=[];
const push=(type,data)=>events.push({event:{seq:events.length,time:1000,type,data}});
for(let turn=0;turn<10;turn++) {
 push('turn/start',{turn});
 push('user/message',{source:{kind:'user'},content:[{type:'text',text:`prompt-${turn}`}]});
 push('assistant/message',{turn,message:{content:[{type:'text',text:`answer-${turn}`}]}});
 push('turn/end',{turn,reason:{kind:'completed'}});
}
const client={call:async(method,payload)=>{
 assert.equal(method,'session.history');native.push({method,...payload});
 const before=events.filter(e=>payload.beforeSeq===undefined||e.event.seq<payload.beforeSeq);
 return {events:before.slice(-50),hasMore:before.length>50};
}};
const adapter=new DshAppServerAdapter(client);
adapter.summaries.set('s',{sessionId:'s',running:false,blank:false,cwd:'/',updatedAt:1});
let activations=0;
adapter.setThreadEngine({describe:async()=>({loaded:false,...(nativeHead?{historyHead:{nextSeq:events.length}}:{}),selection:{provider:'p',model:'m'},permissions:{approval:'ask',sandbox:{mode:'workspace-write',workspaceRoot:'/'},preset:'custom'}}),resume:async()=>{activations++;throw Error('Unexpected activation');},create:async()=>{},fork:async()=>{},inject:async()=>{},release:async()=>{}});
let peer;
const transport=new MemoryTransport({connected:value=>{peer=value;},receive:async(frame,reply)=>{
 const message=JSON.parse(frame);if(message.id===undefined)return;
 requests.push({method:message.method,params:message.params});
 try {
 const result=message.method==='initialize'?{codexHome:'/tmp',platformFamily:'unix',platformOs:'linux',userAgent:'dsh-fixture',capabilities:{extensions:{'opencraft/resume-history':{version:1,mode:'paginated',initialTurnsPage:true,boundedRecovery:true}}}}:await adapter.dispatch(message.method,message.params);
 reply.send(JSON.stringify({id:message.id,result}));
 }catch(error){reply.send(JSON.stringify({id:message.id,error:{code:-32000,message:error.message}}));}
}});
const runtime=createAppServerWorkbenchRuntime({hostId:'synthetic-dsh',hostKind:'local',transport,autoReconnect:false,requestTimeoutMs:500});
let baseline;
try{
 await runtime.connect();const lease=await runtime.acquireThread('s');
 for(let i=0;i<60&&!lease.getSnapshot().authoritative;i++)await new Promise(r=>setImmediate(r));
 assert.equal(lease.getSnapshot().authoritative,true,lease.getSnapshot().error?.message);
 for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
 assert.equal(native.length,1,'unused navigation does not enumerate history');
 await lease.getNavigation().prepare();
 baseline={rpc:requests.slice(),nativeHistoryReads:native.length,nativeHistoryRequests:native.slice()};
 assert.equal(baseline.nativeHistoryReads,2); // one tail plus useful older-only navigation
 assert.equal(requests.filter(r=>r.method==='thread/items/list').length,0);
 assert.notEqual(requests.find(r=>r.method==='thread/turns/list').params.cursor,null);
 const before=native.length, revalidation=lease.retryRestore();
 assert.equal(lease.getSnapshot().authoritative,false,'manual revalidation immediately revokes authority');
 await revalidation;
 assert.equal(native.length,before+(nativeHead?0:1),'unchanged native head eliminates history reads; legacy falls back');
 const position=requests.filter(r=>r.method==='thread/resume')[1].params.historyCheckpoint;
 const resume=checkpoint=>adapter.dispatch('thread/resume',{threadId:'s',excludeTurns:true,historyCheckpoint:checkpoint,initialTurnsPage:{limit:5,itemsView:'full',sortDirection:'desc'}});
 const unchanged=await resume(position);
 assert.equal(unchanged.historyRecovery.mode,'unchanged');
 assert.equal(unchanged.initialTurnsPage.data.length,0);
 assert.equal(unchanged.historyMetrics.nativeReads,nativeHead?0:1);
 peer.send(JSON.stringify({method:'turn/started',params:{threadId:'s',turn:{id:'active-turn',status:'inProgress',items:[],error:null}}}));
 for(let i=0;i<60&&lease.getSnapshot().activeTurn===null;i++)await new Promise(r=>setImmediate(r));
 assert.equal(lease.getSnapshot().activeTurn?.turnId,'active-turn');
 const activeReads=native.length;
 await lease.retryRestore();
 assert.equal(native.length,activeReads+1,'an observed active Turn requires a fresh history read');
 assert.equal(requests.filter(r=>r.method==='thread/resume').at(-1).params.historyCheckpoint,undefined,'active Turn state cannot offer its older checkpoint');
 for(let turn=10;turn<110;turn++) {
  push('turn/start',{turn}); push('user/message',{source:{kind:'user'},content:[{type:'text',text:`prompt-${turn}`}]});
  push('assistant/message',{turn,message:{content:[{type:'text',text:`answer-${turn}`}]}});
  push('turn/end',{turn,reason:{kind:'completed'}});
 }
 const gapStart=native.length, latest=await resume(position);
 assert.equal(latest.historyRecovery.mode,'replace'); assert.equal(native.length,gapStart+2);
 assert.equal(latest.initialTurnsPage.data[0].id,'dsh-turn-s-109');
 assert.equal(latest.initialTurnsPage.data.length,5); assert.ok(latest.initialTurnsPage.nextCursor);
 const smallCursor=latest.historyRecovery.checkpoint;
 push('turn/start',{turn:110}); push('user/message',{source:{kind:'user'},content:[{type:'text',text:'new'}]});
 push('assistant/message',{turn:110,message:{content:[{type:'text',text:'new answer'}]}}); push('turn/end',{turn:110,reason:{kind:'completed'}});
 const small=await resume(smallCursor);
 assert.equal(small.historyRecovery.mode,'append'); assert.deepEqual(small.initialTurnsPage.data.map(t=>t.id),['dsh-turn-s-110']);
 adapter.engineUnavailable(new Error('synthetic native restart'));adapter.engineRecovered();
 const reset=await resume(small.historyRecovery.checkpoint);
 assert.equal(reset.historyRecovery.mode,'replace');
 assert.notEqual(reset.historyRecovery.checkpoint.epoch,small.historyRecovery.checkpoint.epoch);
 assert.equal(activations,0);
 lease.release();
}finally{await runtime.dispose();adapter.close();}

});

test('native-head Resume retains events arriving after its cut on a replacement connection', async () => {
 const events=[];let reads=0;
 const push=(type,data)=>events.push({event:{seq:events.length,time:1000,type,data}});
 const turn=(index,text)=>{
  push('turn/start',{turn:index});push('user/message',{source:{kind:'user'},content:[{type:'text',text:`Question ${index}`}]});
  push('assistant/message',{turn:index,message:{content:[{type:'text',text}]}});push('turn/end',{turn:index,reason:{kind:'completed'}});
 };
 turn(1,'original answer');
 const adapter=new DshAppServerAdapter({call:async(method)=>{assert.equal(method,'session.history');reads++;return {events:[...events],hasMore:false};}});
 adapter.summaries.set('s',{sessionId:'s',running:false,blank:false,cwd:'/',updatedAt:1});
 adapter.setThreadEngine({describe:async()=>({historyHead:{nextSeq:events.length},selection:{provider:'p',model:'m'},permissions:{approval:'ask',sandbox:{mode:'workspace-write',workspaceRoot:'/'},preset:'custom'}}),resume:async()=>{throw Error('Unexpected activation');},create:async()=>{},fork:async()=>{},inject:async()=>{},release:async()=>{}});
 const lifecycle=new ThreadLifecycle(new ThreadCatalog(),async()=>({released:true}),()=>{});
 let peer,client='',sequence=0;
 const transport=new MemoryTransport({connected:p=>{peer=p;client=`client-${++sequence}`;},disconnected:()=>lifecycle.disconnect(client),receive:async(frame,reply)=>{
  const request=JSON.parse(frame);if(request.id===undefined)return;
  try {
   const result=request.method==='initialize'?{capabilities:{extensions:{'opencraft/resume-history':{version:1,mode:'paginated',initialTurnsPage:true,boundedRecovery:true}}}}
    :request.method==='thread/resume'?await lifecycle.dispatch(request.method,request.params,client,(method,params)=>adapter.dispatch(method,params))
    :await adapter.dispatch(request.method,request.params);
   reply.send(JSON.stringify({id:request.id,result}));
  }catch(error){reply.send(JSON.stringify({id:request.id,error:{code:-32000,message:error.message}}));}
 }});
 let delivered=0;
 adapter.subscribe((method,params)=>{if(lifecycle.receivesNotifications(client,'s')){delivered++;peer.send(JSON.stringify({method,params}));}});
 const runtime=createAppServerWorkbenchRuntime({hostId:'concurrent-head',hostKind:'local',transport,autoReconnect:false});let lease,unblock;
 const until=async(check)=>{const end=Date.now()+3000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not settle');};
 try{
  await runtime.connect();lease=await runtime.acquireThread('s');lease.setRecoveryVisibility(true);
  await until(()=>lease.getSnapshot().authoritative);await transport.close();
  let enter,release;const entered=new Promise(r=>{enter=r;}),held=new Promise(r=>{release=r;unblock=r;});
  const model=adapter.describedModel.bind(adapter);
  adapter.describedModel=async(...args)=>{enter();await held;return model(...args);};
  const before=reads,pending=runtime.reconnect();await entered;
  assert.equal(lifecycle.attachments.has(client,'s'),false,'replacement client has no successful attachment yet');
  const from=events.length,beforeDelivery=delivered;turn(2,'late answer');
  for(const entry of events.slice(from))adapter.onMuxFrame({type:'session/event',sessionId:'s',event:entry.event});
  await until(()=>delivered>beforeDelivery);release();await pending;
  await until(()=>lease.getSnapshot().authoritative&&JSON.stringify(lease.getSnapshot().timeline).includes('late answer'));
  assert.equal(reads,before+1,'replacement connection reloads one bounded tail and preserves concurrent observations');
 }finally{unblock?.();lease?.release();await runtime.dispose();await lifecycle.close();adapter.close();}
});
