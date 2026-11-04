import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {TokenUsageTelemetry} from '../../apps/opencraft-daemon/src/token-usage-telemetry.js';
import {TokenUsageAttemptWriter} from '../../apps/opencraft-daemon/src/token-usage-attempt-writer.js';
import {TokenUsageStateDatabase} from '../../apps/opencraft-daemon/src/token-usage-state-database.js';
import {OpenCraftTokenUsageLedger,type UsageSubmission} from '../../apps/opencraft-daemon/src/token-usage-ledger.js';
import {CodexTokenUsageRuntime} from '../../apps/opencraft-daemon/src/token-usage-runtime.js';
const entry=new URL('../../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url).pathname;
const wait=async(check:()=>boolean)=>{const until=Date.now()+10000;while(!check()){assert.ok(Date.now()<until,'collector timed out');await new Promise(r=>setTimeout(r,10));}};
for(const bundled of [false,true])test(`collector ${bundled?'packaged':'source'} recovers receipts/cursor off the Host and foreground writes bypass native I/O`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'oc-collector-')),state=new TokenUsageStateDatabase(root),ledger=new OpenCraftTokenUsageLedger(state,'server',()=>1000);
 const turnId='00000000-03e8-7000-8000-000000000001',threadId='thread',file=join(root,'rollout.jsonl');
 const identity:UsageSubmission={threadId,inputId:'trusted-input',actorId:'trusted-human',actorKind:'human',sourceKind:'human',mode:'start',submittedAt:1000};
 const line=(type:string,payload:unknown)=>JSON.stringify({type,payload})+'\n';
 const body=line('event_msg',{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{type:'UserMessage',client_id:identity.inputId}})+line('token_usage_record',{thread_id:threadId,turn_id:turnId,session_id:'native',response_id:'response',usage:{total_tokens:'7'}});
 await writeFile(file,body);ledger.rememberRollout(threadId,file);
 let workerEntry=entry;if(bundled){workerEntry=join(root,'usage.mjs');await build({entryPoints:[entry],outfile:workerEntry,bundle:true,platform:'node',format:'esm',target:'node26',logLevel:'silent'});}
 const writer=new TokenUsageAttemptWriter({entry:workerEntry,directory:root,serverId:'server'});
 const telemetry=new TokenUsageTelemetry();
 let entered=false,release!:()=>void,validations=0;const blocked=new Promise<void>(r=>release=r);
 writer.configureCollector({telemetry,diagnostic:()=>{},submission:(thread,id)=>thread===threadId&&id===identity.inputId?identity:null,
  source:async()=>({nativeHome:root,key:'incarnation',validate:async()=>{validations++;}}),
  request:async(method)=>{if(method==='thread/read'){entered=true;await blocked;return {thread:{id:threadId,path:file}};}return {data:[{id:turnId,startedAt:1,status:'inProgress'}]};},
 });
 const runtime=new CodexTokenUsageRuntime(ledger,{request:async()=>{throw Error('main collector executed');},diagnostic:()=>{},collector:writer,writes:writer});
 try{
  runtime.initialize({codexHome:root});await wait(()=>entered);
  const began=performance.now();let timer=false;setTimeout(()=>{timer=true;},5);
  await writer.record('priority',{...identity,inputId:'foreground'});
  assert.ok(performance.now()-began<1000,'foreground admission waits for background native response');
  await new Promise(r=>setTimeout(r,10));assert.equal(timer,true);
  release();await wait(()=>Number(ledger.rollout(threadId)?.cursor)===Buffer.byteLength(body));
  assert.ok(validations>0);assert.equal(ledger.readTurn({threadId,turnId})?.observedTokens,'7');
  assert.equal(state.database.prepare('SELECT actor_id FROM token_usage_inputs WHERE input_id=?').get(identity.inputId)!.actor_id,'trusted-human');
  runtime.close();await writer.close();assert.equal(telemetry.snapshot().counts.collected,1);assert.ok(telemetry.snapshot().writeLatency.count>0);
 }finally{release();runtime.close();await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});

test('collector close aborts pending bridge requests instead of abandoning replay commits',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oc-collector-close-')),state=new TokenUsageStateDatabase(root),ledger=new OpenCraftTokenUsageLedger(state,'server');
 ledger.rememberRollout('thread',join(root,'missing.jsonl'));
 let entered=false;const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:'server'});
 writer.configureCollector({diagnostic:()=>{},request:async()=>{entered=true;return new Promise(()=>{});}});
 try{writer.send('initialize',{codexHome:root});await wait(()=>entered);await writer.close();assert.equal(ledger.rollout('thread')?.cursor,'0');}
 finally{await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});

test('a replaced native generation cannot commit a prefetched receipt or advance its cursor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'oc-collector-stale-')),state=new TokenUsageStateDatabase(root),ledger=new OpenCraftTokenUsageLedger(state,'server',()=>1000);
 const file=join(root,'rollout.jsonl'),turnId='00000000-03e8-7000-8000-000000000001';
 await writeFile(file,JSON.stringify({type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:turnId,item:{type:'UserMessage',client_id:'stale-input'}}})+'\n');ledger.rememberRollout('thread',file);
 let checked=false;const writer=new TokenUsageAttemptWriter({entry,directory:root,serverId:'server'});
 writer.configureCollector({diagnostic:()=>{},submission:()=>({threadId:'thread',inputId:'stale-input',actorId:'human',actorKind:'human',sourceKind:'human',mode:'start',submittedAt:1000}),
  request:async method=>method==='thread/read'?{thread:{path:file}}:{data:[{id:turnId,startedAt:1,status:'inProgress'}]},
  source:async()=>({nativeHome:root,key:'old-incarnation',validate:async()=>{checked=true;throw Error('source replaced');}}),
 });
 try{writer.send('initialize',{codexHome:root});await wait(()=>checked);await writer.close();assert.equal(ledger.rollout('thread')?.cursor,'0');assert.equal(state.database.prepare('SELECT count(*) AS n FROM token_usage_admissions').get()!.n,0);assert.equal(ledger.storedSubmission('thread','stale-input'),null);}
 finally{await writer.close();state.close();await rm(root,{recursive:true,force:true});}
});
