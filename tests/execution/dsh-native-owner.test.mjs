import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createDshNativeOwner} from '../../apps/local-agent-host/src/dsh-native-owner.mjs';
const ctx=()=>({settings:{describe:()=>[]},jobs:{list:()=>[]},agents:{list:()=>[],get:()=>null},sessions:{flush:async()=>{}},sessionPersistence:{list:async()=>[]}});
async function fixture(t) {
 const root=await mkdtemp('/tmp/dsh-owner-');t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,owner:createDshNativeOwner(ctx(),root)};
}
test('native RPC fence and exact consumer receipts survive a new incarnation',async t=>{
 const {root,owner}=await fixture(t);let calls=0;
 const operation=async()=>{calls++;return Response.json({accepted:true});};
 assert.equal((await owner.rpc('session.prompt',{rpcId:'input'},operation)).status,409);
 owner.resume();const response=await owner.rpc('session.prompt',{rpcId:'input'},operation);
 owner.fence();assert.equal((await owner.inspect()).activeCount,1);
 assert.equal((await owner.rpc('session.prompt',{rpcId:'input'},operation)).status,409);
 assert.equal(calls,1);
 assert.throws(()=>owner.receipt({rpcId:'input',receipt:'wrong'}));
 const next=createDshNativeOwner(ctx(),root);assert.equal((await next.inspect()).activeCount,1);
 next.receipt({rpcId:'input',receipt:response.headers.get('x-opencraft-dsh-receipt')});
 assert.equal((await next.inspect()).activeCount,0);
});
test('lost response and tool errors remain unknown after cancellation and restart',async t=>{
 const {root,owner}=await fixture(t);owner.resume();
 await assert.rejects(owner.rpc('session.prompt',{rpcId:'lost'},async()=>{throw Error('connection lost');}));
 const coords={sessionId:'s',turn:1,step:1,callId:'tool'};
 const effect=owner.beginEffect(coords);owner.effectResult(effect,{isError:true},false);owner.commitEffect(coords);
 const cancelled=await owner.rpc('session.cancel',{rpcId:'stop'},async()=>Response.json({accepted:true}));
 owner.receipt({rpcId:'stop',receipt:cancelled.headers.get('x-opencraft-dsh-receipt')});
 owner.fence();assert.equal((await owner.inspect()).activeCount,2);
 const next=createDshNativeOwner(ctx(),root);assert.equal((await next.inspect()).activeCount,2);
 assert.throws(()=>next.receipt({rpcId:'lost',receipt:'cancelled'}));
});
test('successful tool requires native journal commit before custody retires',async t=>{
 const {owner}=await fixture(t);const coords={sessionId:'s',turn:1,step:1,callId:'tool'};
 const effect=owner.beginEffect(coords);owner.effectResult(effect,{isError:false},false);
 assert.equal((await owner.inspect()).activeCount,1);owner.commitEffect(coords);
 assert.equal((await owner.inspect()).activeCount,0);
});

test('cold inbox, blocked goal, approvals and unowned jobs remain work',async t=>{
 const root=await mkdtemp('/tmp/dsh-future-');t.after(()=>rm(root,{recursive:true,force:true}));
 const events=[{seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[{id:'future',content:[]}]}},
   {seq:1,type:'goal/change',data:{goal:{id:'goal',phase:'blocked'}}},
   {seq:2,type:'approval/asked',data:{id:'approval'}}];
 const native={...ctx(),jobs:{list:()=>[{status:'running',ownerSession:null}]},sessionPersistence:{list:async()=>[{id:'s'}],readFrom:async()=>({events})}};
 const owner=createDshNativeOwner(native,root);const first=await owner.inspect();assert.equal(first.activeCount,4);
 assert.equal(first.records[0].inbox,1);assert.equal(first.records[0].goal,1);assert.equal(first.records[0].approvals,1);
 owner.fence();assert.deepEqual((await owner.inspect()).records,first.records);
});

test('bootstrap cannot admit inputs and is permanently sealed',async t=>{
 const {root}=await fixture(t);const owner=createDshNativeOwner(ctx(),root,'private-bootstrap');let calls=0;
 const operation=async()=>{calls++;return Response.json({ok:true});};
 assert.equal((await owner.rpc('session.prompt',{rpcId:'input',payload:{}},operation,'private-bootstrap')).status,409);
 const configured=await owner.rpc('settings.mutate',{rpcId:'config',payload:{ns:'agent-default-model'}},operation,'private-bootstrap');
 assert.equal(configured.status,200);owner.receipt({rpcId:'config',receipt:configured.headers.get('x-opencraft-dsh-receipt')});
 owner.sealBootstrap();assert.equal((await owner.rpc('settings.mutate',{rpcId:'late',payload:{ns:'agent-default-model'}},operation,'private-bootstrap')).status,409);
 assert.equal(calls,1);
});

test('caught private-tool failure survives a successful enclosing tool and terminal turn',async t=>{
 const {owner}=await fixture(t),outer={sessionId:'s',turn:1,step:1,callId:'outer'};
 const parent=owner.beginEffect(outer),privateCall=owner.beginPrivateEffect({sessionId:'s',turn:1,callId:'nested'});
 owner.privateResult(privateCall,{success:false},false);
 owner.effectResult(parent,{isError:false},false);owner.commitEffect(outer);owner.commitPrivateTurn('s',1);
 assert.equal((await owner.inspect()).activeCount,1);
 const confirmed=owner.beginPrivateEffect({sessionId:'s',turn:2,callId:'confirmed'});
 owner.privateResult(confirmed,{success:true},false);owner.commitPrivateTurn('s',1);
 assert.equal((await owner.inspect()).activeCount,2);owner.commitPrivateTurn('s',2);assert.equal((await owner.inspect()).activeCount,1);
});

test('cold fork inbox excludes the inherited seed prefix',async t=>{
 const {root}=await fixture(t);
 const events=[{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[{id:'parent-only'}]}}];
 const native={...ctx(),sessionPersistence:{list:async()=>[{id:'child'}],readFrom:async()=>({meta:{seedLength:1},events})}};
 const owner=createDshNativeOwner(native,root);
 assert.equal((await owner.inspect()).activeCount,0);
 events.push({type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[{id:'child-owned'}]}});
 assert.equal((await owner.inspect()).activeCount,1);
});
