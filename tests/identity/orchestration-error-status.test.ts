import assert from 'node:assert/strict';
import test from 'node:test';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { callConversationHost } from '../../scripts/conversation-execution.mjs';

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
