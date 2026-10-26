import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {CodexEngineAdapter} from '../../apps/opencraft-daemon/src/codex-engine-adapter';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';

test('persisted Agent provenance outranks its human delegation on external start and explicit queued steer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-usage-orchestration-')),frames:any[]=[];
 const actor={id:'human',kind:'human' as const};
 const engine=new CodexEngineAdapter({executable:process.execPath,runtimeDirectory:root,dataDirectory:join(root,'data'),nativeCodexHomeDirectory:join(root,'native'),
  upstreamBaseUrl:'http://127.0.0.1:9/backend-api/codex',fetch:async()=>Response.json({ok:true}),logDiagnostic:()=>{},createMaintenanceClient:async()=>{throw Error('unused');},
  spawnAppServer:({cwd,env})=>spawn(process.execPath,[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname],{cwd,env,stdio:['pipe','pipe','pipe']}),
  tokenUsage:{serverId:'server',queryWorkerEntry:new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url).pathname,actor:()=>actor,
    submission:(threadId,inputId)=>inputId.startsWith('known-agent-')?{threadId,inputId,sourceKind:'system',actorKind:'session',actorId:null,mode:'start',submittedAt:Date.now()}:null},
 });
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});engine.subscribeMessage(frame=>frames.push(JSON.parse(frame)));await engine.connect();
 const context={sender:null,actorContext:{actorId:'human',generation:1,credentialId:null,expiresAt:Date.now()+60000},tokenUsageAuthority:()=>({actorId:'human',administrator:true})};let sequence=0;
 async function rpc(method:string,params:Record<string,unknown>={}){
   const id=++sequence;await engine.sendWithContext(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'view'}),context);
   for(let i=0;i<1000;i++){const reply=frames.find(frame=>frame.id===id);if(reply){assert.equal(reply.error,undefined,JSON.stringify(reply.error));return reply.result;}await delay(5);}throw Error('RPC timeout');
 }
 await rpc('initialize');await rpc('opencraft/token-usage/configure',{enabled:true});const {thread}=await rpc('thread/start',{cwd:root,testNoServerRequest:true});
 const {turn}=await rpc('turn/start',{threadId:thread.id,clientUserMessageId:'known-agent-start',input:[{type:'text',text:'Synthetic Agent input'}]});
 const queued=await rpc('thread/queue/add',{threadId:thread.id,clientUserMessageId:'known-agent-steer',input:[{type:'text',text:'Synthetic Agent steer'}]});
 await rpc('thread/queue/steer',{threadId:thread.id,queuedSubmissionId:queued.queuedSubmission.id,expectedTurnId:turn.id});
 const database=new DatabaseSync(join(root,'data/token-usage.sqlite'),{readOnly:true});t.after(()=>database.close());
 for(const input of ['known-agent-start','known-agent-steer']){
   let row:any;for(let i=0;i<200;i++){row=database.prepare('SELECT source_kind,actor_kind,actor_id,outcome FROM token_usage_attempts WHERE input_id=?').get(input);if(row?.outcome==='accepted')break;await delay(5);}
   assert.deepEqual({...row},{source_kind:'system',actor_kind:'session',actor_id:null,outcome:'accepted'});
 }
});
