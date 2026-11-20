import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationRecoveryPresentation } from '../../packages/chat-core/src/conversation-recovery';
import { ChannelsClient } from '../../plugins/im/src/channel-client';
import type { ChannelRpc } from '../../plugins/im/src/channel-client';

test('retained rows remain display-only through a failed baseline, including an empty confirmed result',()=>{
  const presentation=(authoritative:boolean,hasVisibleHistory:boolean,failed=false)=>conversationRecoveryPresentation({authoritative,hasVisibleHistory,failed});
  assert.equal(presentation(false,false),'cold-loading');
  assert.equal(presentation(false,true),'warm-loading');
  assert.equal(presentation(false,true,true),'warm-error');
  assert.equal(presentation(true,false),'none');
  assert.equal(presentation(true,true),'none');
});

test('connection loss revokes current authority synchronously; ordinary change hints do not',async()=>{
  let change:((id:string)=>void)|undefined,disconnect:(()=>void)|undefined,id='',revoked=0,refreshes=0;
  const rpc={connect:async()=>{},close:async()=>{},onChanged(fn:typeof change){change=fn;return()=>{change=undefined}},onDisconnect(fn:typeof disconnect){disconnect=fn;return()=>{disconnect=undefined}},async request(method:string,p:any){if(method.endsWith('/subscribe'))id=p.subscriptionId;return{}}} as unknown as ChannelRpc;
  const lifetime=new AbortController();const client=new ChannelsClient(fetch,rpc);
  try{
    client.watch('group:a',async()=>{refreshes++},error=>{throw error},lifetime.signal,{onConnectionLost:()=>{revoked++}});
    for(let i=0;i<100&&!refreshes;i++)await new Promise(r=>setTimeout(r,2));
    assert.equal(refreshes,1);change!(id);assert.equal(revoked,0);
    disconnect!();assert.equal(revoked,1);
    lifetime.abort();assert.equal(disconnect,undefined);assert.equal(change,undefined);
  }finally{lifetime.abort();}
});

for (const phase of ['refresh', 'access-probe'] as const) {
  test(`retired connection ${phase} failures cannot overwrite the replacement connection`,async()=>{
    let disconnect=()=>{},rejectRead!:(error:Error)=>void,releaseProbe!:()=>void;
    let reads=0,errors=0,probes=0;
    const pending=new Promise<void>((_,reject)=>{rejectRead=reject});
    const probe=new Promise<void>(resolve=>{releaseProbe=resolve});
    const rpc={connect:async()=>{},close:async()=>{},onChanged:()=>()=>{},onDisconnect(fn:()=>void){disconnect=fn;return()=>{}},request:async()=>({})} as unknown as ChannelRpc;
    const client=new ChannelsClient(async()=>{probes++;await probe;return new Response('{}',{status:403})},rpc),lifetime=new AbortController();
    try {
      client.watch('a',async()=>{reads++;if(reads===1)await pending},()=>{errors++},lifetime.signal);
      const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,10));assert.ok(check())};
      await until(()=>reads===1);
      if(phase==='refresh'){disconnect();rejectRead(Error('old request failed'));}
      else {rejectRead(Error('old request failed'));await until(()=>probes===1);disconnect();}
      releaseProbe();await until(()=>reads===2);
      assert.equal(errors,0,'retired errors, even a late denial probe, must not revoke current authority');
      if(phase==='refresh')assert.equal(probes,0,'a retired failure must not start an access probe');
    } finally {lifetime.abort();releaseProbe();}
  });
}
