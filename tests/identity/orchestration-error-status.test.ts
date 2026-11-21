import assert from 'node:assert/strict';
import test from 'node:test';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { callConversationHost } from '../../apps/headless-server/src/conversation-execution.mjs';

for (const method of ['prepare','create']) for (const code of [400,403,409,502,503,-32081]) {
  test(`orchestration ${method} preserves rejection or uncertain creation ${code} without retry or error-text disclosure`, async t => {
    const listeners=new Set<(frame:string)=>void>();let operations=0;
    const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>({
      status:{state:'open' as const},connect:async()=>{},close:async()=>{},
      subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},subscribeStatus:()=>()=>{},
      async send(frame:string){const m=JSON.parse(frame);if(m.id===undefined)return;
        if(m.method!=='initialize')operations++;
        for(const listener of listeners)listener(JSON.stringify({id:m.id,...(m.method==='initialize'?{result:{}}:{error:{code,message:'PRIVATE_NATIVE_MESSAGE'}}),__opencraftClient:m.__opencraftClient}));},
    })});t.after(()=>host.close());
    await assert.rejects(callConversationHost(host,{hostId:'local-codex',threadId:'source'},'diagnostic-operation','opencraft/orchestration/'+method,{}, {sender:null}),
      (error:any)=>{assert.equal(error.code,code);assert.equal(error.status,method!=='create'&&code>=400&&code<=599?code:undefined);assert.doesNotMatch(error.message,/PRIVATE_NATIVE_MESSAGE/);return true;});
    assert.equal(operations,1);
  });
}

import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ThreadAccessSession,ThreadAccessStore} from '../../packages/access-control/src/thread-access';

test('operation-bound internal control reaches an owned private Thread without granting anonymous clients access',async t=>{
 const root=await mkdtemp(join(tmpdir(),'control-private-lane-')),actors=new ActorStore(join(root,'actors.sqlite'));
 const owner=actors.resolveHuman({provider:'test',subject:'owner',displayName:'owner',expiresAt:Date.now()+60_000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);access.created('server','private-child',owner,'private');
 const listeners=new Set<(frame:string)=>void>();let operations=0,admit=true,revokeAtReply=false;
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',
   createRpcAccessSession:(_host,context,emit)=>new ThreadAccessSession(access,()=> 'server',context.actorContext,emit),
   createTransport:()=>({status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>listeners.delete(listener);},subscribeStatus:()=>()=>{},
    async send(frame:string){const p=JSON.parse(frame);if(p.id===undefined)return;if(p.method!=='initialize'){operations++;if(revokeAtReply)admit=false;}
     for(const listener of listeners)listener(JSON.stringify({id:p.id,result:p.method==='initialize'?{}:{finalized:true},__opencraftClient:p.__opencraftClient}));}})});
 t.after(async()=>{await host.close();access.close();actors.close();await rm(root,{recursive:true,force:true});});
 const call=(context:any,method='opencraft/orchestration/finalize')=>callConversationHost(host,{hostId:'local-codex',threadId:'private-child'},'op',method,{operationId:'op'},context);
 const trusted={sender:null,orchestrationOperationId:'op',orchestrationCanAdmit:()=>admit};
 assert.deepEqual(await call(trusted),{finalized:true});assert.equal(operations,1);
 for(const context of [{sender:null},{sender:null,orchestrationOperationId:'wrong',orchestrationCanAdmit:()=>true},{sender:null,orchestrationOperationId:'op'}])await assert.rejects(call(context),(e:any)=>e.code===-32004);
 await assert.rejects(call(trusted,'thread/read'),(e:any)=>e.code===-32004);
 assert.equal(operations,1,'wire arguments, other methods and mismatched contexts never bypass private policy');
 revokeAtReply=true;await assert.rejects(call(trusted),(e:any)=>e.code===403);assert.equal(operations,2);
 await assert.rejects(call(trusted),(e:any)=>e.code===403);assert.equal(operations,2,'revoked admission never dispatches');
 assert.equal(access.allows('server','private-child'),false);assert.equal(access.allows('server','private-child',owner),true);
});

import {createThreadOrchestrationExecution} from '../../apps/headless-server/src/thread-orchestration-execution.mjs';
import {CodexOrchestrationControl} from '../../apps/opencraft-daemon/src/codex-orchestration-control';

test('real driver stop crosses AppHost private access only on the admitted control lane',async t=>{
 const root=await mkdtemp(join(tmpdir(),'stop-private-lane-')),actors=new ActorStore(join(root,'actors.sqlite'));
 const owner=actors.resolveHuman({provider:'test',subject:'owner',displayName:'owner',expiresAt:Date.now()+60_000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);access.created('server','private-child',owner,'private');
 const listeners=new Set<(frame:string)=>void>();let nativeStops=0,admit=true;
 const control=new CodexOrchestrationControl({supported:()=>true,read:async()=>{throw Error('not used');},recovery:()=>null,pendingInput:()=>false,
  request:async(method,params,canAdmit)=>{assert.equal(method,'turn/interrupt');assert.deepEqual(params,{threadId:'private-child',turnId:'expected-turn'});assert.equal(canAdmit?.(),true);nativeStops++;return {};}});
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',
  createRpcAccessSession:(_host,context,emit)=>new ThreadAccessSession(access,()=> 'server',context.actorContext,emit),
  createTransport:()=>({status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>listeners.delete(listener);},subscribeStatus:()=>()=>{},
   async send(frame:string){return this.sendWithContext(frame,{sender:null});},
   async sendWithContext(frame:string,context:any){const p=JSON.parse(frame);if(p.id===undefined)return;
    const result=p.method==='initialize'?{}:await control.handle(p.method,p.params,context);
    for(const listener of listeners)listener(JSON.stringify({id:p.id,result,__opencraftClient:p.__opencraftClient}));}})});
 t.after(async()=>{await host.close();access.close();actors.close();await rm(root,{recursive:true,force:true});});
 const driver=createThreadOrchestrationExecution(()=>host);
 await driver.interrupt!('private-child','expected-turn',()=>admit);assert.equal(nativeStops,1);
 admit=false;await assert.rejects(driver.interrupt!('private-child','expected-turn',()=>admit));assert.equal(nativeStops,1);
 await assert.rejects(callConversationHost(host,{hostId:'local-codex',threadId:'private-child'},'forged','turn/interrupt',{turnId:'expected-turn'},{sender:null}),(e:any)=>e.code===-32004);
 assert.equal(nativeStops,1);assert.equal(access.allows('server','private-child'),false);
});

test('revocation after native allocation preserves internal identity for custody, while a subsequent action is denied',async t=>{
 let admit=true,creates=0;const listeners=new Set<(frame:string)=>void>();
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',
 createTransport:()=>({status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>listeners.delete(listener);},subscribeStatus:()=>()=>{},
 async send(frame:string){const p=JSON.parse(frame);if(p.id===undefined)return;
  if(p.method==='opencraft/orchestration/create'){creates++;admit=false;}
  for(const listener of listeners)listener(JSON.stringify({id:p.id,result:p.method==='initialize'?{}:{threadId:'allocated-child',durability:'pending_first_turn'},__opencraftClient:p.__opencraftClient}));}})});t.after(()=>host.close());
 const context={sender:null,orchestrationOperationId:'op',orchestrationCanAdmit:()=>admit};
 const result=await callConversationHost(host,{hostId:'local-codex',threadId:''},'op','opencraft/orchestration/create',{operationId:'op',settings:{orchestrationRoot:true}},context);
 assert.deepEqual(result,{threadId:'allocated-child',durability:'pending_first_turn'});assert.equal(creates,1);
 await assert.rejects(callConversationHost(host,{hostId:'local-codex',threadId:'allocated-child'},'op','opencraft/orchestration/finalize',{operationId:'op'},context),(e:any)=>e.code===403);
 assert.equal(creates,1);
});
