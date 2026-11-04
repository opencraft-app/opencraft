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
