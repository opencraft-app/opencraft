import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AppServerIdentityOverlay} from '../../apps/opencraft-daemon/src/appserver-identity-overlay';

test('only trusted successful child creation carries immutable creation provenance',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'creation-context-')),creators=new Map<string,unknown>();
 const overlay=new AppServerIdentityOverlay({directory,resolveTarget:async()=>{throw Error('No history');},
  createMetadata:()=>({methods:[],capabilities:{},supports:()=>false,request:async()=>({}),observeNotification(){},close(){},
   observeResult(method,_params,result,sender){const id=(result as any)?.thread?.id;if(method==='thread/start'&&sender!==undefined&&!creators.has(id))creators.set(id,sender);}
  })});
 t.after(async()=>{await overlay.close();await rm(directory,{recursive:true,force:true});});
 const session=overlay.open(()=>{}),employee={kind:'employee' as const,loginName:'original.creator'};
 const create=(id:string,target:string,trusted:boolean,sender:typeof employee|null=employee)=>{
  const request=JSON.parse(session.toNative(JSON.stringify({id,method:'opencraft/orchestration/create',params:{operationId:id,creator:'untrusted.creator'}}),{
   sender,...(trusted?{orchestrationOperationId:id,orchestrationCanAdmit:()=>true}:{})})!);
  session.fromNative(JSON.stringify({id:request.id,result:{threadId:target}}));
 };
 create('trusted','child',true);assert.deepEqual(creators.get('child'),employee);
 create('spoofed','other',false);assert.equal(creators.has('other'),false);
 create('unknown','legacy-child',true,null);create('replay','legacy-child',true);assert.equal(creators.get('legacy-child'),null);
 assert.equal(overlay.identity.senders.hasEmployees('child'),false);
});
