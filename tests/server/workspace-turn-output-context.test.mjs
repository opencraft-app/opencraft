import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceTurnOutputContext} from '../../apps/headless-server/src/workspace-turn-output-context.mjs';
function fixture(){
 const state={context:{actorId:'actor',generation:1,expiresAt:1000},current:true,allowed:true,server:'server'};
 const actors={isCurrent:context=>state.current&&context.actorId==='actor'};
 const collaboration={executionContext:async(thread,options)=>{assert.equal(thread,'thread');assert.deepEqual(options,{turnId:'turn'});return{context:{...state.context},authorityId:'authority'};},delegation:(thread,turn,id)=>{assert.equal(thread,'thread');assert.equal(turn,'turn');assert.equal(id,'authority');return{context:state.context};},execution:{serverForThread:()=>state.server,serverId:null},conversationAllowed:(context,scope,capability)=>{assert.deepEqual(scope,{serverId:state.server,threadId:'thread'});assert.equal(capability,'execution.delegate');return state.allowed;}};
 return{state,actors,collaboration,threadId:'thread',turnId:'turn'};
}
test('public default preserves native output authority without requiring any provider identity',async()=>{
 const f=fixture(),result=await workspaceTurnOutputContext(f);assert.equal(result.executionPrincipal,undefined);assert.equal(result.resourceOwner.id,'actor');assert.equal(result.validUntil,1000);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.actorContext));assert.ok(Object.isFrozen(result.resourceOwner));result.resourceOwner.assertCurrent();
});
test('every original delegation, Actor and scope fence remains active on an existing context',async()=>{
 for(const revoke of [s=>s.context={...s.context,actorId:'other'},s=>s.context={...s.context,generation:2},s=>s.context={...s.context,expiresAt:2000},s=>s.current=false,s=>s.allowed=false,s=>s.server=null]){
  const f=fixture(),result=await workspaceTurnOutputContext(f);revoke(f.state);assert.throws(()=>result.resourceOwner.assertCurrent(),/authority revoked/);
 }
});
test('installed principal is copied and frozen while its live identity guard runs at capture and use',async()=>{
 const f=fixture(),principal={provider:'fixture',subject:'verified'},state={live:true,calls:0};
 const result=await workspaceTurnOutputContext({...f,selectIdentity:(context,actors)=>{assert.equal(context.actorId,'actor');assert.equal(actors,f.actors);return{principal,assertCurrent(){state.calls++;if(!state.live)throw Error('identity revoked');}};}});
 assert.deepEqual(result.executionPrincipal,principal);assert.ok(Object.isFrozen(result.executionPrincipal));principal.subject='mutated';assert.equal(result.executionPrincipal.subject,'verified');assert.equal(state.calls,1);state.live=false;assert.throws(()=>result.resourceOwner.assertCurrent(),/identity revoked/);
});
test('a provider policy cannot bypass native revocation',async()=>{
 const f=fixture();let calls=0;const result=await workspaceTurnOutputContext({...f,selectIdentity:()=>({principal:{provider:'fixture',subject:'verified'},assertCurrent(){calls++;}})});f.state.allowed=false;assert.throws(()=>result.resourceOwner.assertCurrent(),/authority revoked/);assert.equal(calls,1);
});
test('invalid installed selectors and incomplete identity projections fail closed',async()=>{
 for(const selectIdentity of [false,()=>undefined,()=>({principal:{provider:'fixture',subject:'x'}}),()=>({principal:{provider:'',subject:'x'},assertCurrent(){}})])await assert.rejects(workspaceTurnOutputContext({...fixture(),selectIdentity}),/identity/);
});
