import assert from 'node:assert/strict';
import test from 'node:test';
import { AppHostServer } from '../../packages/app-host-server/src/index';
test('self-title writes use the existing Host method and fixed source thread for every driver',async t=>{
  const {createThreadOrchestrationExecution}=await import('../../scripts/thread-orchestration-execution.mjs');
  for(const threadId of ['codex-current','pi_current','dsh_acp_current']){
    const listeners=new Set<(frame:string)=>void>(),writes:any[]=[];
    let current=true,revokeOnInitialize=false;
    const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>({
      status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeStatus:()=>()=>{},
      subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
      async send(frame:string){const value=JSON.parse(frame);if(value.id===undefined)return;
        if(value.method==='initialize'){if(revokeOnInitialize)current=false;}
        else{assert.equal(value.method,'thread/name/set');writes.push(value.params);}
        for(const listener of listeners)listener(JSON.stringify({id:value.id,result:{},__opencraftClient:value.__opencraftClient}));
      },
    })});
    t.after(()=>host.close());
    const execution=createThreadOrchestrationExecution(()=>host,{enabled:['codex','pi','dsh-acp']});
    await execution.setTitle!('set-current',threadId,'Current task',()=>current);
    assert.equal(writes.length,1);assert.equal(writes[0].threadId,threadId);assert.equal(writes[0].name,'Current task');
    revokeOnInitialize=true;
    await assert.rejects(execution.setTitle!('revoked-during-initialize',threadId,'Denied',()=>current),/delegation revoked/);
    assert.equal(writes.length,1);
  }
});

test('child creation inherits trusted parent provenance across engines and rechecks revocation', async t => {
  const {createThreadOrchestrationExecution} = await import('../../scripts/thread-orchestration-execution.mjs');
  const listeners = new Set<(frame:string)=>void>(), contexts:any[] = [], lookups:string[] = [];
  const transport = {
    status:{state:'open' as const}, connect:async()=>{}, close:async()=>{}, subscribeStatus:()=>()=>{},
    subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    async send(frame:string){return this.sendWithContext(frame,{sender:null});},
    async sendWithContext(frame:string,context:any){
      const message=JSON.parse(frame);if(message.id===undefined)return;
      if(message.method==='opencraft/orchestration/create'){
        contexts.push(context);assert.equal(message.params.sender,undefined);assert.equal(message.params.creator,undefined);
      }
      for(const listener of listeners)listener(JSON.stringify({id:message.id,result:message.method==='initialize'?{}:{threadId:'created'},__opencraftClient:message.__opencraftClient}));
    },
  };
  const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>transport});
  t.after(()=>host.close());let current=true;
  const execution=createThreadOrchestrationExecution(()=>host,{enabled:['codex','pi','dsh-acp'],creationSender:async source=>{
    lookups.push(source);return source==='unknown'?null:{kind:'employee',loginName:'original.creator'};
  }});
  for(const [source,destination] of [['parent','pi'],['pi_parent','dsh-acp'],['dsh_acp_parent','codex'],['unknown','codex']])
    await execution.create('create-'+source,source!,{orchestrationDriver:destination},()=>current);
  assert.deepEqual(lookups,['parent','pi_parent','dsh_acp_parent','unknown']);
  assert.deepEqual(contexts.map(context=>context.sender),[...Array(3).fill({kind:'employee',loginName:'original.creator'}),null]);
  assert.ok(contexts.every(context=>!context.executionPrincipal&&!context.actorContext),'creation provenance grants no execution identity');
  current=false;await assert.rejects(execution.create('revoked','parent',{orchestrationDriver:'codex'},()=>current),/revoked/);
  assert.equal(contexts.length,4);
});
