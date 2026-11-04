import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelPolicyStore} from '@opencraft/model-usage-policy';
import {ModelPolicyTransport} from '@opencraft/model-usage-policy/transport';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';

test('explicit Codex turns validate current policy without nested discovery and retain native admission',async t=>{
  const root=await mkdtemp(join(tmpdir(),'explicit-policy-')),path=join(root,'policy.sqlite');
  const store=new ModelPolicyStore(path);store.write(0,[{engine:'codex',effort:'ultra'}],'fixture');
  let listener:(frame:string)=>void=()=>{};
  const sent:any[]=[],replies:any[]=[];
  const inner:any={status:{state:'open'},connect:async()=>{},close:async()=>{},subscribeStatus:()=>()=>{},
    subscribeMessage(fn:any){listener=fn;return()=>{};},async send(frame:string){
      const m=JSON.parse(frame);sent.push(m);
      if(m.method==='thread/read')listener(JSON.stringify({id:m.id,result:{thread:{model:'allowed',reasoningEffort:'low'}}}));
      if(m.method==='model/list')listener(JSON.stringify({id:m.id,result:{data:[{model:'allowed',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}}));
    }};
  const transport=new ModelPolicyTransport(inner,path);transport.subscribeMessage(f=>replies.push(JSON.parse(f)));
  t.after(async()=>{await transport.close();store.close();await rm(root,{recursive:true,force:true});});
  const send=(id:string,params:any)=>transport.send(JSON.stringify({id,method:'turn/start',params,[LOGICAL_CLIENT_FIELD]:'same-client'}));
  await send('explicit',{threadId:'thread',model:'allowed',effort:'high'});
  assert.deepEqual(sent.map(m=>m.method),['turn/start']);
  assert.equal(sent[0][LOGICAL_CLIENT_FIELD],'same-client');
  // Missing effort still requires the persisted/native default.
  sent.length=0;await send('partial',{threadId:'thread',model:'allowed'});
  assert.deepEqual(sent.map(m=>m.method),['thread/read','model/list','turn/start']);
  // A newly restricted effort is denied, including collaboration's precedence.
  store.write(1,[{engine:'codex',effort:'high'}],'fixture');sent.length=0;
  await send('restricted',{threadId:'thread',model:'allowed',effort:'low',collaborationMode:{settings:{model:'allowed',reasoning_effort:'high'}}});
  assert.equal(sent.some(m=>m.method==='turn/start'),false);
  assert.equal(replies.at(-1).error.data.kind,'effort');
  assert.deepEqual(replies.at(-1).error.data.alternatives,['low']);
});
