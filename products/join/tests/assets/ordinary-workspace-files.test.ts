import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryWorkspaceFileSelector } from '../../assets/ordinary-workspace-files';
import { composeHostFileSelector, HostFileSystemSession } from '../../../../scripts/host-filesystem-transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { OrdinaryRuntimeAdmission } from '../../assets/ordinary-conversation-runtime';
import type { OrdinaryExecutionBinding } from '../../../../apps/local-agent-host/src/ordinary-conversation-owner';
const context={sender:null};
function setup(){
 let local=0,remote=0,allowed=true,principal='alice';
 const admission:OrdinaryRuntimeAdmission={authority:{principalId:'alice',hostId:'host'},catalog:{scope:'alice',current:()=>allowed},async authorize(){if(!allowed)throw Error('revoked')}};
 const original:OrdinaryExecutionBinding={async executionFields(){throw Error('unused')},async close(){},
  files:{async request(_method,params){remote++;assert.deepEqual(params,{path:'/workspace/same'});return {dataBase64:'YWxpY2U='}}}};
 let binding=original;
 const select=ordinaryWorkspaceFileSelector({runtime:{async bindingFor(a,threadId){
  if(a.authority.principalId!=='alice'||threadId!=='alice-thread')throw Error('not found');return binding;
 }},admit(){if(!allowed)throw Error('revoked');return {...admission,authority:{...admission.authority,principalId:principal}}},
 local:async()=>({assertCurrent(){},files:{async request(){local++;return {local:true}}}})});
 return {select,admission,original,replace(){binding={...original}},revoke(){allowed=false},other(){principal='bob'},counts:()=>({local,remote})};
}
test('actual Host session strips routing hint and selects only the admitted private files',async()=>{
 const f=setup(),replies:any[]=[];
 const session=new HostFileSystemSession({async request(){throw Error('default files forbidden')}},()=>{},f.select);
 const frame=(id:string,method:string,params:unknown={})=>JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'client'});
 session.subscribeMessage(v=>replies.push(JSON.parse(v)));
 await session.receive(frame('init','initialize'),context);session.project(JSON.stringify({id:'init',result:{capabilities:{}},[LOGICAL_CLIENT_FIELD]:'client'}));
 await session.receive(frame('read','fs/readFile',{path:'/workspace/same',workspaceThreadId:'alice-thread'}),context);
 assert.deepEqual(replies.at(-1).result,{dataBase64:'YWxpY2U='});
 await session.receive(frame('foreign','fs/readFile',{path:'/workspace/same',workspaceThreadId:'bob-thread'}),context);
 assert.ok(replies.at(-1).error);assert.deepEqual(f.counts(),{local:0,remote:1});session.close();
});
test('retired binding, revoked grant and changed principal reject without selecting local files',async()=>{
 for(const change of ['replace','revoke','other'] as const){
  const f=setup(),binding=await f.select(context,{path:'/workspace/same',workspaceThreadId:'alice-thread'});
  f[change]();await assert.rejects(async()=>binding.assertCurrent());assert.deepEqual(f.counts(),{local:0,remote:0});
 }
});
test('only explicitly unscoped requests delegate to existing local policy',async()=>{
 const f=setup(),local=await f.select(context,{path:'/home/user'});
 assert.deepEqual(await local.files.request('fs/readFile',{path:'/home/user'}),{local:true});
 await assert.rejects(f.select(context,{path:'/workspace/same',workspaceThreadId:null}));
 await assert.rejects(f.select(context,{path:'/workspace/same',workspaceThreadId:'missing'}));
 assert.deepEqual(f.counts(),{local:1,remote:0});
});

test('Headless composition supplies the real local file port and retains authority checks',async()=>{
 let allowed=true;
 const files={async request(){return {local:true}}};
 let retained:unknown;
 const select=composeHostFileSelector(files,()=>{if(!allowed)throw Error('revoked')},
  async(ctx,params,local)=>{if(retained)assert.strictEqual(local,retained);retained=local;return local(ctx,params)})!;
 const a=await select(context,{path:'/tmp/a'}),b=await select(context,{path:'/tmp/b'});
 assert.strictEqual(a.files,files);assert.strictEqual(b.files,files);
 allowed=false;
 assert.throws(()=>a.assertCurrent(),/revoked/);
 await assert.rejects(select(context,{path:'/tmp/a'}),/revoked/);
});
test('Headless local file port rejects a workspace hint even if composition delegates it',async()=>{
 const select=composeHostFileSelector({async request(){throw Error('must not execute')}},()=>{},
  (ctx,params,local)=>local(ctx,params))!;
 await assert.rejects(select(context,{path:'/workspace',workspaceThreadId:'remote'}),/local binding/);
});
test('Headless file composition never recovers a failed remote selection with local files',async()=>{
 const files={async request(){throw Error('must not execute')}};
 assert.equal(composeHostFileSelector(files,()=>{},undefined),undefined);
 const select=composeHostFileSelector(files,()=>{},async()=>{throw Error('remote unavailable')})!;
 await assert.rejects(select(context,{}),/remote unavailable/);
});
